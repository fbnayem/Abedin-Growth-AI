/**
 * S32 — reconciliation: what actually happened, asked of the provider.
 *
 * WHAT WAS WRONG
 * --------------
 * P1.11 built the taxonomy. `providerError.ts` classifies TIMEOUT, CONNECTION_FAILED,
 * PROVIDER_UNAVAILABLE and UNKNOWN as AMBIGUOUS, `requiresReconciliation(error, irreversible)`
 * states the §32 gate, and the gateway calls it. Then:
 *
 *     // It requires an operator or the reconciliation worker to resolve.
 *     await outboxService.markFailed(orgId, job.id, "AMBIGUOUS_PROVIDER_RESULT: ...", true);
 *
 * There was no reconciliation worker. Every ambiguous send was dead-lettered permanently. That
 * is fail-CLOSED and therefore not dangerous — but it is not §32 either, and it has a real
 * cost: a Gmail send that timed out and was in fact never delivered is a message the customer
 * is still waiting for, and the system had no way to tell it apart from one that arrived. The
 * safe answer was the only answer available, so it was given to every case.
 *
 * THE THREE ANSWERS
 * -----------------
 * Reconciliation replaces one outcome with three, and the difference between them is what a
 * caller is then permitted to do:
 *
 *   APPLIED       The provider has the message. The send HAPPENED. Record it as sent, with the
 *                 id the provider gave — never retry.
 *   NOT_APPLIED   The provider does not have it, and enough time has passed that it would if
 *                 it did. The ambiguity is resolved to a definite failure, and retry is safe.
 *   STILL_UNKNOWN We could not establish either. This is the fail-closed answer and it is
 *                 returned generously: no identity to search on, the search itself failed, the
 *                 search ran too soon to be trusted, or the provider returned something that
 *                 does not prove what it appears to prove.
 *
 * Only NOT_APPLIED licenses a retry. That single rule is the whole safety property, and
 * `mayRetryAfterReconciliation` is the only place it is written down.
 *
 * WHY "TOO SOON" IS A DISTINCT ANSWER
 * -----------------------------------
 * A mailbox search is eventually consistent. Asking Gmail one second after a timeout whether
 * the message is in Sent will often say no even when the send succeeded, because the index has
 * not caught up. Treating that "no" as NOT_APPLIED would license a retry and deliver the
 * message twice — the precise outcome §32 exists to prevent, arrived at through the machinery
 * built to prevent it. So an absence observed before the settle window has elapsed is
 * STILL_UNKNOWN, not NOT_APPLIED. Waiting is cheap; a duplicate to a customer is not.
 */

import { isFabricatedProviderId } from './providerId';
import { classifyThrown, ProviderError } from './providerError';
import { isWellFormedMessageId } from './messageIdentity';

export type ReconciliationVerdict = 'APPLIED' | 'NOT_APPLIED' | 'STILL_UNKNOWN';

export interface ReconciliationOutcome {
  readonly verdict: ReconciliationVerdict;
  /** What the verdict was based on. Written for an operator reading a dead-letter row. */
  readonly evidence: string;
  /** Present only when APPLIED. The id the PROVIDER holds, never one of ours. */
  readonly providerMessageId: string | null;
  readonly providerThreadId: string | null;
  /** The classified failure, when the reconciliation query itself failed. */
  readonly lookupErrorKind: string | null;
}

/**
 * What a provider must offer for its sends to be reconcilable.
 *
 * Separate from `EmailProvider` on purpose: an adapter that cannot search its own sent mail
 * cannot promise this, and a method that throws "not supported" would let the gateway believe
 * it had reconciled when it had not.
 */
export interface SentMessageLookup {
  readonly providerName: string;
  /**
   * Returns the message if the provider holds one with this RFC 5322 Message-ID, else null.
   *
   * @throws {ProviderError} if the question could not be asked. Never null for "we failed" —
   * that conflation is what made `getHistory` return an empty array for a dead credential and
   * so made a broken connection look like a quiet inbox (P1.11).
   */
  findSentMessageByRfc822MessageId(
    rfc822MessageId: string
  ): Promise<{ id: string; threadId: string } | null>;
}

/**
 * How long after the attempt an absence starts to count as evidence of absence.
 *
 * 30 seconds is a judgement, not a measurement: long enough to clear ordinary Gmail indexing
 * lag, short enough that a genuinely failed send is retried while the reply still makes sense
 * to the recipient. It is a parameter so a deployment that measures something different can
 * say so, and so the tests can state the boundary exactly.
 */
export const DEFAULT_SETTLE_MS = 30_000;

export interface ReconcileEmailSendArgs {
  /** The id stamped into the outbound message. Absent means the send was not reconcilable. */
  rfc822MessageId: string | null | undefined;
  /** When the ambiguous attempt was made. Absent means we cannot judge whether it is too soon. */
  attemptedAt: Date | null | undefined;
  /** Injected: reconciliation must be testable at an exact instant either side of the window. */
  now: Date;
  settleMs?: number;
}

function outcome(
  verdict: ReconciliationVerdict,
  evidence: string,
  extra: Partial<ReconciliationOutcome> = {}
): ReconciliationOutcome {
  return {
    verdict,
    evidence,
    providerMessageId: extra.providerMessageId ?? null,
    providerThreadId: extra.providerThreadId ?? null,
    lookupErrorKind: extra.lookupErrorKind ?? null,
  };
}

/**
 * Ask the provider whether the send happened.
 *
 * This function never throws. Every failure path is a verdict, because a reconciliation that
 * throws leaves the caller holding the ambiguity it started with plus an exception that some
 * caller upstream will treat as an ordinary retryable error.
 */
export async function reconcileEmailSend(
  lookup: SentMessageLookup,
  args: ReconcileEmailSendArgs
): Promise<ReconciliationOutcome> {
  const settleMs = args.settleMs ?? DEFAULT_SETTLE_MS;

  if (!isWellFormedMessageId(args.rfc822MessageId)) {
    return outcome(
      'STILL_UNKNOWN',
      'The send carried no well-formed Message-ID, so there is no question to ask the ' +
        'provider. This is an unreconcilable send and must not be retried.'
    );
  }
  const messageId: string = args.rfc822MessageId as string;

  let found: { id: string; threadId: string } | null;
  try {
    found = await lookup.findSentMessageByRfc822MessageId(messageId);
  } catch (e) {
    const classified: ProviderError =
      e instanceof ProviderError
        ? e
        : classifyThrown(e, { provider: lookup.providerName, operation: 'reconcileEmailSend' });
    return outcome(
      'STILL_UNKNOWN',
      'The reconciliation query itself failed (' +
        classified.kind +
        ': ' +
        classified.signal +
        '). A failed question is not a negative answer.',
      { lookupErrorKind: classified.kind }
    );
  }

  if (found !== null && found !== undefined) {
    // A provider that answers with an id we could have minted ourselves has proved nothing.
    // This is the P0.8 rule applied to the other direction of the same claim.
    if (typeof found.id !== 'string' || found.id === '' || isFabricatedProviderId(found.id)) {
      return outcome(
        'STILL_UNKNOWN',
        'The lookup returned ' +
          JSON.stringify(found.id) +
          ', which is not a usable provider id. A fabricated id is not weaker evidence of ' +
          'delivery; it is none.'
      );
    }
    return outcome(
      'APPLIED',
      'The provider holds a sent message with Message-ID ' +
        messageId +
        '. The send happened; retrying it would deliver a second copy.',
      {
        providerMessageId: found.id,
        providerThreadId: typeof found.threadId === 'string' ? found.threadId : null,
      }
    );
  }

  // Absent. Whether that is evidence depends entirely on how long ago we asked.
  if (!(args.attemptedAt instanceof Date) || Number.isNaN(args.attemptedAt.getTime())) {
    return outcome(
      'STILL_UNKNOWN',
      'The provider does not hold the message, but the attempt has no recorded time, so we ' +
        'cannot tell whether the index has had a chance to catch up.'
    );
  }

  const elapsedMs = args.now.getTime() - args.attemptedAt.getTime();
  if (elapsedMs < settleMs) {
    return outcome(
      'STILL_UNKNOWN',
      'The provider does not hold the message, but only ' +
        elapsedMs +
        'ms have passed and a mailbox index is eventually consistent (settle window ' +
        settleMs +
        'ms). Reading this absence as failure would license a retry that delivers a second copy.'
    );
  }

  return outcome(
    'NOT_APPLIED',
    'The provider does not hold a message with Message-ID ' +
      messageId +
      ', ' +
      elapsedMs +
      'ms after the attempt (settle window ' +
      settleMs +
      'ms). The send did not happen and may be retried.'
  );
}

/**
 * The §32 gate after reconciliation, stated once.
 *
 * Written as an equality against the one permitting value rather than as a negation of the
 * forbidding ones, so a verdict added to the union later is refused by default instead of
 * silently inheriting permission.
 */
export function mayRetryAfterReconciliation(verdict: ReconciliationVerdict): boolean {
  return verdict === 'NOT_APPLIED';
}

/** Did reconciliation establish that the irreversible action DID take effect? */
export function wasApplied(verdict: ReconciliationVerdict): boolean {
  return verdict === 'APPLIED';
}
