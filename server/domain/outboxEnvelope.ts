/**
 * S48 — what a worker is allowed to assume about a job another build enqueued.
 *
 * WHAT WAS THERE
 * --------------
 * `OutboxPayload` declared seven fields and no version. The worker destructured
 * `job.payload.to`, `job.payload.subject` and five more straight into an `ActionRequest` whose
 * `payload` is typed `any`. No validation anywhere on the path. So a worker could not reject an
 * unsupported payload version — it could not detect one.
 *
 * That matters only during a rolling deploy, which is the only time two builds run at once, and
 * it fails in both directions:
 *
 *   FORWARD   a new build adds a required field — say a consent basis. Old web instances are
 *             still enqueuing while the new worker runs. Their jobs lack the field. The worker
 *             cannot tell "old job" from "new job with the field deliberately absent", so it
 *             dispatches with the new constraint defaulted open.
 *
 *   BACKWARD  a rollback puts the old worker back in front of new-format jobs. It destructures
 *             the fields it knows, silently ignores the ones it does not, applies none of the
 *             new constraint, and reports every send as SUCCESS.
 *
 * The backward case is worse, because nothing anywhere records that it happened.
 *
 * WHY A MISSING VERSION IS NOT VERSION 1
 * --------------------------------------
 * The obvious reading of an unversioned job is "it predates versioning, so it is v1". That is
 * the same inference as the FORWARD failure above — absence read as a specific known value —
 * and §14 rules it out: an unknown state must never resolve to permission. An unversioned job
 * is one this build cannot describe, so it is dead-lettered for an operator rather than sent on
 * an assumption.
 *
 * Dead-lettering is recoverable: DEAD_LETTER -> HUMAN_REVIEW is a legal transition and the row
 * keeps its payload. Sending to a real person on a guess is not recoverable. Existing rows are
 * backfilled explicitly by `scripts/backfill-outbox-version.ts`, which is a decision someone
 * makes about a specific queue rather than an inference this module makes about every job.
 *
 * WHY THE SCHEMA IS STRICT
 * ------------------------
 * An unrecognised field on a payload that claims to be v1 means the producer and this build
 * disagree about what v1 is. Accepting it and ignoring the extra field is precisely the
 * BACKWARD failure. Refusing it forces the version to be bumped, which is the whole discipline.
 */
import { z } from 'zod';

/** The version this build PRODUCES. Bump when the payload shape changes in any way. */
export const OUTBOX_PAYLOAD_VERSION = 1;

/**
 * The versions this build can EXECUTE.
 *
 * Deliberately separate from the version produced: during a rolling deploy a build must often
 * accept the previous shape while emitting the new one. Widening this list is the deliberate
 * act that makes an old job executable, and it is the only thing that does.
 */
export const SUPPORTED_PAYLOAD_VERSIONS: readonly number[] = [1];

export const outboxPayloadV1 = z
  .object({
    to: z.string().min(1),
    subject: z.string(),
    htmlBody: z.string(),
    textBody: z.string().optional(),
    inReplyTo: z.string().optional(),
    references: z.string().optional(),
    threadId: z.string().optional(),
  })
  .strict();

export type OutboxPayloadV1 = z.infer<typeof outboxPayloadV1>;

/**
 * What this build should do with a job it has just claimed.
 *
 * A discriminated union rather than a boolean and a message, so that "dispatch" cannot be
 * reached by a caller that ignored an error, and so that the two ways of being unusable stay
 * distinguishable in the dead-letter reason: a version nobody here understands is an operational
 * fact about the deploy, and a payload that does not parse is a bug.
 */
export type EnvelopeDecision =
  | { readonly kind: 'EXECUTE'; readonly version: number; readonly payload: OutboxPayloadV1 }
  | { readonly kind: 'UNSUPPORTED_VERSION'; readonly found: number | null; readonly reason: string }
  | { readonly kind: 'MALFORMED'; readonly reason: string };

/** The shape read off the stored job, before anything is believed about it. */
export interface StoredEnvelope {
  readonly schemaVersion?: unknown;
  readonly payload?: unknown;
}

/**
 * Decide, from the stored job alone, whether this build may act on it.
 *
 * Pure and side-effect free: it neither reads the clock nor touches the datastore, so the same
 * job always produces the same decision and a test can hold every case still.
 */
export function readEnvelope(job: StoredEnvelope): EnvelopeDecision {
  return readEnvelopeFor(job, SUPPORTED_PAYLOAD_VERSIONS);
}

/**
 * The same decision, for a build that supports a different set of versions.
 *
 * Exported so that both rolling-deploy directions can actually be exercised — "enqueue v1 and
 * run a v2 worker", then "enqueue v2 and run a v1 worker" — rather than asserted about a
 * constant that is the same in every test. The two directions fail differently and only one of
 * them is obvious, so testing one and assuming the other is how the quiet half survives.
 */
export function readEnvelopeFor(
  job: StoredEnvelope,
  supported: readonly number[]
): EnvelopeDecision {
  const raw = job.schemaVersion;

  if (raw === undefined || raw === null) {
    return {
      kind: 'UNSUPPORTED_VERSION',
      found: null,
      reason:
        'the job carries no schemaVersion. It is NOT assumed to be version ' +
        `${OUTBOX_PAYLOAD_VERSION}: an unversioned job is one this build cannot describe, and ` +
        'reading absence as a known value is the rolling-deploy failure this check exists for. ' +
        'Backfill it deliberately with scripts/backfill-outbox-version.ts.',
    };
  }

  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return {
      kind: 'UNSUPPORTED_VERSION',
      found: null,
      reason: `schemaVersion is ${JSON.stringify(raw)}, which is not an integer version`,
    };
  }

  if (!supported.includes(raw)) {
    return {
      kind: 'UNSUPPORTED_VERSION',
      found: raw,
      reason:
        `this build executes payload version(s) ${supported.join(', ')} and the ` +
        `job is version ${raw}. ` +
        (raw > Math.max(...supported)
          ? 'The job was enqueued by a NEWER build — this is a rollback, and the fields this ' +
            'build does not know about would be silently dropped if it proceeded.'
          : 'The job was enqueued by an OLDER build whose shape this one no longer accepts.'),
    };
  }

  const parsed = outboxPayloadV1.safeParse(job.payload);
  if (parsed.success === false) {
    return {
      kind: 'MALFORMED',
      reason:
        `payload does not match version ${raw}: ` +
        parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')
          .slice(0, 400),
    };
  }

  return { kind: 'EXECUTE', version: raw, payload: parsed.data };
}

/**
 * May this decision reach a provider?
 *
 * One place, one answer, and nothing to accumulate. A caller cannot arrive at a send by
 * checking a subset of the cases.
 */
export function mayDispatch(
  decision: EnvelopeDecision
): decision is Extract<EnvelopeDecision, { kind: 'EXECUTE' }> {
  return decision.kind === 'EXECUTE';
}

/**
 * The dead-letter reason for a decision that must not be dispatched.
 *
 * Terminal in every case: neither an unsupported version nor a malformed payload becomes valid
 * by waiting, and a job that retries on a backoff would keep a queue busy failing until its
 * attempts ran out — arriving at the same dead letter, later and noisier.
 *
 * @throws if handed an EXECUTE, because there is no failure reason for a job that is fine, and
 *         returning one would let a caller dead-letter a sendable job by mistake.
 */
export function deadLetterReason(decision: EnvelopeDecision): string {
  if (decision.kind === 'EXECUTE') {
    throw new Error('[outboxEnvelope] deadLetterReason called for an executable job');
  }
  return `${decision.kind}: ${decision.reason}`;
}
