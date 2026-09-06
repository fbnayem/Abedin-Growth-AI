/**
 * P1.5 — WHICH CONVERSATION DOES AN INBOUND MESSAGE BELONG TO (addendum §29, §18).
 *
 * WHAT WAS WRONG
 * --------------
 * InboundPipeline contained this:
 *
 *     let conversationId = identity.contactId; // hack
 *     if (!conversationId) { ...create a conversation... }
 *
 * The guard above it returns early when `identity.contactId` is absent, so the branch that
 * creates a conversation was unreachable — no conversation row has ever been written. Every
 * message was then stored with `conversationId` set to a CONTACT id, against a column whose
 * foreign key points at `conversations`.
 *
 * Two consequences. Structurally, the insert violates its own foreign key, so on a deployment
 * with PostgreSQL actually configured the inbound pipeline fails at the first message.
 * Behaviourally — and this is the one that survives the schema being fixed — every message a
 * person ever sends lands in ONE conversation keyed by who they are. Two unrelated threads
 * with the same customer become one transcript, and that transcript is what the reply composer
 * reads as context. `providerThreadId`, `inReplyTo` and `references` were captured into columns
 * and never once consulted.
 *
 * THE ATTACK THIS HAS TO SURVIVE
 * ------------------------------
 * `In-Reply-To` and `References` are headers on an email that anybody can send. If a
 * conversation is chosen by matching those headers against stored Message-IDs, then an
 * attacker who learns or guesses a Message-ID can graft their own email onto someone else's
 * thread — and the composer will draft a reply using that thread's history, which is exactly
 * the "untrusted material gains authority" shape §18 describes, arriving through routing
 * rather than through prompt text.
 *
 * So a header match is a *hint that must be confirmed*: the referenced message must belong to
 * a conversation with the same tenant AND the same contact as the message now arriving. When
 * it does not, the correct answer is a new conversation. That costs a split thread, which is
 * visible and repairable. The alternative costs a disclosed one, which is neither.
 *
 * Subject-line matching is not implemented and should not be. "Re: Quick question" matches
 * every unrelated thread with that subject, and it is trivially forgeable.
 */

/** A conversation that some signal proposed, as loaded from the datastore. */
export interface ThreadCandidate {
  conversationId: string;
  organizationId: string;
  contactId: string;
  providerThreadId?: string | null;
}

/** The message being placed. */
export interface InboundThreadSignals {
  organizationId: string;
  contactId: string;
  providerThreadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}

export type ThreadMethod = 'PROVIDER_THREAD' | 'HEADER_REFERENCE';

export type ThreadResolution =
  | {
      kind: 'EXISTING';
      conversationId: string;
      method: ThreadMethod;
      confidence: number;
    }
  | {
      kind: 'NEW';
      reason: string;
      /** Set when a candidate was found and deliberately rejected, so it can be logged. */
      rejected?: { conversationId: string; why: string };
    };

/**
 * Extract Message-IDs from a `References` or `In-Reply-To` header.
 *
 * RFC 5322 says these are angle-addr tokens separated by whitespace, and that a long
 * References header is folded across lines. Splitting on whitespace alone therefore produces
 * fragments; matching the bracketed form is what actually parses.
 *
 * Bounded at 50 ids: References grows by one entry per reply and an attacker controls its
 * length, so an unbounded parse is an unbounded number of datastore lookups per inbound
 * message. The most recent entries are the relevant ones, and they are at the end.
 */
export const MAX_REFERENCES = 50;

export function parseMessageIds(header: unknown): string[] {
  if (typeof header !== 'string' || header.length === 0) return [];

  const ids: string[] = [];
  const seen = new Set<string>();

  // The character class excludes angle brackets so a malformed header cannot make one match
  // run over the whole string, and excludes whitespace so a fold cannot end up inside an id.
  const pattern = /<([^<>\s]{1,512})>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(header)) !== null) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids.length > MAX_REFERENCES ? ids.slice(-MAX_REFERENCES) : ids;
}

/** Every Message-ID this message claims to be a reply to, most recent first. */
export function referencedMessageIds(signals: InboundThreadSignals): string[] {
  const inReplyTo = parseMessageIds(signals.inReplyTo);
  const references = parseMessageIds(signals.references);

  // In-Reply-To names the immediate parent, so it is the strongest of these. References is
  // ordered oldest-first, so its tail is the nearest ancestry.
  const ordered = [...inReplyTo, ...references.reverse()];
  const seen = new Set<string>();
  return ordered.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
}

/**
 * Decide which conversation an inbound message joins.
 *
 * Pure: the caller performs the lookups and passes what it found. That is what makes the
 * confirmation rule below testable — including the case where the lookup returns a
 * conversation belonging to somebody else.
 */
export function resolveThread(
  signals: InboundThreadSignals,
  found: {
    /** The conversation carrying this provider thread id, if the caller found one. */
    byProviderThread?: ThreadCandidate | null;
    /** Conversations owning any referenced Message-ID, in the order the ids were tried. */
    byReference?: readonly ThreadCandidate[];
  }
): ThreadResolution {
  const confirm = (candidate: ThreadCandidate): string | null => {
    if (candidate.organizationId !== signals.organizationId) {
      return 'belongs to a different organisation';
    }
    if (candidate.contactId !== signals.contactId) {
      return 'belongs to a different contact';
    }
    return null;
  };

  // 1. The provider's own thread id. Gmail computed it from the full message, on the server,
  // from data the sender does not solely control — a stronger signal than any header we could
  // parse ourselves. It is still confirmed: a thread id from another tenant is not ours.
  const providerCandidate = found.byProviderThread;
  if (providerCandidate && typeof signals.providerThreadId === 'string' && signals.providerThreadId.length > 0) {
    const problem = confirm(providerCandidate);
    if (problem === null) {
      return {
        kind: 'EXISTING',
        conversationId: providerCandidate.conversationId,
        method: 'PROVIDER_THREAD',
        confidence: 0.99,
      };
    }
    return {
      kind: 'NEW',
      reason: 'A conversation carries this provider thread id, but it is not ours to append to.',
      rejected: { conversationId: providerCandidate.conversationId, why: problem },
    };
  }

  // 2. The reply headers. Attacker-supplied, so a match is a hint and the confirmation is the
  // control. A candidate that fails confirmation does not fall through to the next candidate
  // as though nothing happened — it is reported, because a mismatch here is either a bug in
  // our threading or somebody probing it.
  for (const candidate of found.byReference ?? []) {
    const problem = confirm(candidate);
    if (problem === null) {
      return {
        kind: 'EXISTING',
        conversationId: candidate.conversationId,
        method: 'HEADER_REFERENCE',
        confidence: 0.9,
      };
    }
    return {
      kind: 'NEW',
      reason:
        'An inbound message referenced a Message-ID belonging to another conversation. ' +
        'Starting a new thread rather than appending to one that is not this contact’s.',
      rejected: { conversationId: candidate.conversationId, why: problem },
    };
  }

  return { kind: 'NEW', reason: 'No provider thread id and no recognised reply headers.' };
}
