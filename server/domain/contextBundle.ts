import { createHash } from 'node:crypto';
import { activeFacts, isAttestedFact, type StoredFact } from './facts';
import { quoteBinding, type Quote } from '../../shared/domain/quote';

/**
 * P1.8 — DETERMINISTIC CONTEXT SELECTION (addendum §21, §20).
 *
 * WHAT WAS WRONG
 * --------------
 * The live composer built its context like this:
 *
 *     const fullTranscript = thread.map((m, idx) => `[Message #${idx+1}] ... ${m.bodyText}`)
 *                                  .join("\n\n---\n\n");
 *
 * The ENTIRE thread, every message, unbounded, interpolated into the prompt. Three consequences.
 * A long thread silently exceeds the context window and the model sees a truncated prompt nobody
 * chose the shape of. Cost grows without limit on a path with no budget check. And — the reason
 * this is a correctness section and not a performance one — there is no record of what the model
 * was shown, so a bad reply cannot be explained afterwards. "Why did it say that?" has no answer
 * when the input was assembled implicitly and never written down.
 *
 * Alongside it, `knownRelevantFacts` was a two-item hardcoded literal about latency and calendar
 * sync — the same two sentences for every customer, described in the type as the facts relevant
 * to THIS conversation.
 *
 * THE RULE
 * --------
 * Context is SELECTED by explicit rule from addressable records, and the ids of the records
 * selected are recorded. Every item in the prompt can be named, and the same inputs produce the
 * same bundle — which is what makes a prompt hash meaningful and a bad reply investigable.
 *
 * Determinism is a property this module has to work for: no `Date.now()`, no iteration over a
 * Set built from object identity, no dependence on datastore return order. Records are sorted by
 * a total order before selection, and ties broken by id.
 */

export type ContextKind =
  | 'INBOUND_MESSAGE'
  | 'THREAD_TURN'
  | 'FACT'
  | 'OPEN_QUESTION'
  | 'UNRESOLVED_OBJECTION'
  | 'OUTSTANDING_COMMITMENT'
  | 'QUOTE'
  | 'COMPANY_FACT';

/** One addressable thing that may go into a prompt. */
export interface ContextRecord {
  id: string;
  kind: ContextKind;
  content: string;
  /** ISO timestamp used for ordering. Absent sorts oldest. */
  observedAt?: string | null;
  /** True when the content originated outside our trust boundary (§18). */
  untrusted: boolean;
  /** Why this record was selected, for the manifest. */
  reason: string;
}

export interface ContextBundleInputs {
  /** The thread, oldest first. */
  thread: readonly {
    id: string;
    sender: 'PROSPECT' | 'AGENT';
    subject?: string | null;
    bodyText?: string | null;
    sentAt?: string | null;
  }[];
  facts: readonly StoredFact[];
  openQuestions: readonly { id: string; question: string }[];
  unresolvedObjections: readonly { id: string; objection: string }[];
  outstandingCommitments: readonly { id: string; commitment: string; dueAt?: string | null }[];
  /** Every quote for this customer. Selection picks the one in force, if any. */
  quotes: readonly Quote[];
  /** Approved company-level knowledge. */
  companyFacts: readonly { id: string; content: string }[];
  /**
   * Kinds whose SOURCE COULD NOT BE READ, as distinct from kinds that are genuinely empty.
   *
   * Every field above is an array, and an empty array says "there are none". With three of the
   * five stores behind an unreachable database, that is the wrong answer far more often than it
   * is the right one — and "this customer has raised no objections" reads identically to
   * "the objections table threw". §14: an unknown must not present itself as a known-empty.
   *
   * The caller is the only place that knows which it was, so the caller must say.
   */
  unavailable?: readonly ContextKind[];
  /** The clock, injected. A context builder that reads the wall clock is not deterministic. */
  now: string;
}

export interface ContextBundleOptions {
  /** How many recent thread turns to include beyond the latest inbound message. */
  maxThreadTurns?: number;
  maxFacts?: number;
  maxCompanyFacts?: number;
  /** Total character budget across all records. */
  maxTotalChars?: number;
}

export const DEFAULTS: Required<ContextBundleOptions> = {
  maxThreadTurns: 8,
  maxFacts: 25,
  maxCompanyFacts: 10,
  maxTotalChars: 24_000,
};

export interface ContextBundle {
  records: ContextRecord[];
  /** The ids of every record included, in order. This is the manifest. */
  contextIds: string[];
  /** Records that were selected by rule and then dropped for budget, with the reason. */
  excluded: { id: string; kind: ContextKind; reason: string }[];
  /**
   * Kinds whose source could not be read, sorted and deduplicated.
   *
   * Distinct from a kind that is simply absent from `records`: absent means "there are none",
   * this means "we do not know". A reader of the bundle that treats the two the same is making
   * the §14 mistake the field exists to prevent.
   */
  unavailable: ContextKind[];
  /** A stable hash of the selected content AND of what could not be read. Same inputs, same hash. */
  contextHash: string;
  /** Rendered block for the prompt. */
  promptBlock: string;
  totalChars: number;
}

function sortByTimeDescending<T extends { observedAt?: string | null; id: string }>(items: T[]): T[] {
  // Ties broken by id so the order is total and therefore reproducible. Sorting only by
  // timestamp leaves same-second records in whatever order the datastore returned them, which
  // would make the manifest differ between two runs on identical data.
  return [...items].sort((a, b) => {
    const at = a.observedAt ?? '';
    const bt = b.observedAt ?? '';
    if (at !== bt) return bt.localeCompare(at);
    return a.id.localeCompare(b.id);
  });
}

/**
 * Select the context for a reply.
 *
 * Every inclusion is a rule, stated here rather than emerging from whatever the caller happened
 * to have loaded:
 *
 *  1. The latest inbound message. Always, in full — it is what is being replied to.
 *  2. The most recent N thread turns, newest first, bounded.
 *  3. Facts that are still in force. A SUPERSEDED fact is excluded (§20): including it would
 *     put a value the customer has since corrected back into the prompt as current.
 *  4. Open questions, unresolved objections, outstanding commitments.
 *  5. The quote in force, if one binds. A withdrawn or expired quote is excluded (§24) — an
 *     offer that has lapsed must not be restated as though it were still open.
 *  6. Approved company facts.
 */
export function buildContextBundle(
  inputs: ContextBundleInputs,
  options: ContextBundleOptions = {}
): ContextBundle {
  const opts = { ...DEFAULTS, ...options };
  const records: ContextRecord[] = [];
  const excluded: { id: string; kind: ContextKind; reason: string }[] = [];

  // 1. The latest inbound message.
  const inbound = [...inputs.thread].filter((m) => m.sender === 'PROSPECT');
  const latestInbound = inbound.length > 0 ? inbound[inbound.length - 1] : null;
  if (latestInbound) {
    records.push({
      id: `msg:${latestInbound.id}`,
      kind: 'INBOUND_MESSAGE',
      content: `Subject: ${latestInbound.subject ?? '(none)'}\n${latestInbound.bodyText ?? ''}`,
      observedAt: latestInbound.sentAt ?? null,
      untrusted: true,
      reason: 'The message being replied to.',
    });
  }

  // 2. Recent turns, excluding the latest inbound (already included). Newest first, bounded —
  // the previous implementation took every turn with no limit at all.
  const remaining = inputs.thread.filter((m) => m.id !== latestInbound?.id);
  const recent = remaining.slice(-opts.maxThreadTurns).reverse();
  for (const turn of recent) {
    records.push({
      id: `msg:${turn.id}`,
      kind: 'THREAD_TURN',
      content: `[${turn.sender}] ${turn.subject ?? ''}\n${turn.bodyText ?? ''}`,
      observedAt: turn.sentAt ?? null,
      untrusted: turn.sender === 'PROSPECT',
      reason: `Within the most recent ${opts.maxThreadTurns} turns.`,
    });
  }
  for (const dropped of remaining.slice(0, Math.max(0, remaining.length - opts.maxThreadTurns))) {
    excluded.push({
      id: `msg:${dropped.id}`,
      kind: 'THREAD_TURN',
      reason: `Older than the most recent ${opts.maxThreadTurns} turns.`,
    });
  }

  // 3. Facts in force. Superseded facts are excluded and SAID to be excluded.
  for (const fact of inputs.facts) {
    if (fact.validUntil !== null && fact.validUntil !== undefined) {
      excluded.push({
        id: `fact:${fact.id}`,
        kind: 'FACT',
        reason: `Superseded on ${fact.validUntil}; the customer's current position differs.`,
      });
    }
  }
  const live = sortByTimeDescending(activeFacts([...inputs.facts])).slice(0, opts.maxFacts);
  for (const fact of live) {
    records.push({
      id: `fact:${fact.id}`,
      kind: 'FACT',
      content: `${fact.key}: ${fact.value}`,
      observedAt: fact.observedAt ?? null,
      // §18 — a fact a model summarised from a customer email is not a record we hold.
      untrusted: !isAttestedFact(fact),
      reason: isAttestedFact(fact)
        ? `Attested fact (${fact.sourceType}), in force.`
        : `Derived from untrusted material (${fact.sourceType}); in force but not attested.`,
    });
  }

  // 4. The ledgers. These three reads existed and were called by nothing.
  for (const q of inputs.openQuestions) {
    records.push({
      id: `question:${q.id}`,
      kind: 'OPEN_QUESTION',
      content: q.question,
      untrusted: true,
      reason: 'Open question the customer has asked and we have not answered.',
    });
  }
  for (const o of inputs.unresolvedObjections) {
    records.push({
      id: `objection:${o.id}`,
      kind: 'UNRESOLVED_OBJECTION',
      content: o.objection,
      untrusted: true,
      reason: 'Objection raised and not yet resolved.',
    });
  }
  for (const c of inputs.outstandingCommitments) {
    records.push({
      id: `commitment:${c.id}`,
      kind: 'OUTSTANDING_COMMITMENT',
      content: c.dueAt ? `${c.commitment} (due ${c.dueAt})` : c.commitment,
      observedAt: c.dueAt ?? null,
      untrusted: false,
      reason: 'A commitment we made and have not discharged.',
    });
  }

  // 5. The quote in force. A lapsed offer is excluded and named.
  for (const quote of inputs.quotes) {
    const verdict = quoteBinding(quote, inputs.now);
    if (verdict.binding) {
      records.push({
        id: `quote:${quote.id}`,
        kind: 'QUOTE',
        content: `Quote ${quote.id} v${quote.version}, approved by ${quote.approvedBy}.`,
        observedAt: quote.validFrom,
        untrusted: false,
        reason: 'The offer currently in force for this customer.',
      });
    } else if (verdict.binding === false) {
      // `=== false` rather than an else branch: TypeScript does not narrow the union in the
      // negative arm of a truthiness test here.
      excluded.push({ id: `quote:${quote.id}`, kind: 'QUOTE', reason: verdict.reason });
    }
  }

  // 6. Approved company facts.
  for (const fact of inputs.companyFacts.slice(0, opts.maxCompanyFacts)) {
    records.push({
      id: `company:${fact.id}`,
      kind: 'COMPANY_FACT',
      content: fact.content,
      untrusted: false,
      reason: 'Approved company knowledge.',
    });
  }

  // Budget. Applied last and recorded, so a dropped record is visible rather than being a
  // silent truncation inside the model's context window.
  const kept: ContextRecord[] = [];
  let total = 0;
  for (const record of records) {
    const size = record.content.length;
    if (total + size > opts.maxTotalChars) {
      excluded.push({
        id: record.id,
        kind: record.kind,
        reason: `Dropped for the ${opts.maxTotalChars}-character budget.`,
      });
      continue;
    }
    kept.push(record);
    total += size;
  }

  const contextIds = kept.map((r) => r.id);
  // Deduplicated and ordered, so the hash below does not change with the caller's argument
  // order for what is conceptually a set.
  const unavailable = [...new Set(inputs.unavailable ?? [])].sort();
  const contextHash = hashContext(kept, unavailable);

  return {
    records: kept,
    contextIds,
    excluded,
    unavailable,
    contextHash,
    promptBlock: renderBundle(kept),
    totalChars: total,
  };
}

/**
 * A stable hash of what was selected.
 *
 * Over ids AND content, because either alone is insufficient: ids alone would not notice a
 * fact's value changing under a stable id, and content alone would not notice a reordering that
 * changes what the model reads first.
 *
 * UNAVAILABLE KINDS ARE PART OF THE HASH. A run where the objections table was unreachable
 * and a run where the customer genuinely has no objections select the same records and render
 * the same prompt block — but they are not the same context, and §21 asks the hash exactly one
 * question: "was this the same context?" Two runs that differ in what could be READ must not
 * answer it identically.
 */
export function hashContext(
  records: readonly ContextRecord[],
  unavailable: readonly ContextKind[] = []
): string {
  const material =
    records.map((r) => `${r.id}\u0000${r.content}`).join('') +
    `\u0000UNAVAILABLE\u0000${[...unavailable].sort().join('\u0000')}`;
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
}

const KIND_HEADINGS: Record<ContextKind, string> = {
  INBOUND_MESSAGE: 'THE MESSAGE YOU ARE REPLYING TO',
  THREAD_TURN: 'EARLIER IN THIS THREAD',
  FACT: 'WHAT WE KNOW ABOUT THIS CUSTOMER',
  OPEN_QUESTION: 'QUESTIONS THEY ASKED THAT ARE STILL UNANSWERED',
  UNRESOLVED_OBJECTION: 'OBJECTIONS NOT YET RESOLVED',
  OUTSTANDING_COMMITMENT: 'COMMITMENTS WE MADE AND HAVE NOT DISCHARGED',
  QUOTE: 'THE OFFER IN FORCE',
  COMPANY_FACT: 'APPROVED COMPANY KNOWLEDGE',
};

/**
 * Render the bundle for a prompt.
 *
 * Untrusted records are LABELLED as untrusted. This does not replace the structural fencing in
 * lib/promptAssembly — that is what actually separates authority — but a bundle that renders a
 * model's paraphrase of a customer email indistinguishably from an operator-entered fact would
 * undo the tiering P1.6 established (§18).
 */
export function renderBundle(records: readonly ContextRecord[]): string {
  const byKind = new Map<ContextKind, ContextRecord[]>();
  for (const record of records) {
    const list = byKind.get(record.kind) ?? [];
    list.push(record);
    byKind.set(record.kind, list);
  }

  const sections: string[] = [];
  // Iterated over the declared order, not the Map's insertion order, so the rendering is
  // deterministic regardless of which kinds happened to be present.
  for (const kind of Object.keys(KIND_HEADINGS) as ContextKind[]) {
    const list = byKind.get(kind);
    if (!list || list.length === 0) continue;
    const lines = list
      .map((r) => `  [${r.id}]${r.untrusted ? ' (reported by the customer, not verified)' : ''} ${r.content}`)
      .join('\n');
    sections.push(`${KIND_HEADINGS[kind]}:\n${lines}`);
  }

  return sections.join('\n\n');
}
