import { createHash } from 'crypto';

/**
 * S10 — THE AUDIT RECORD THE GATEWAY WRITES, AND WHY IT IS NOT A DOCUMENT.
 *
 * WHAT WAS WRONG
 * --------------
 * `ActionGateway.logAction` could not fail, and nothing could tell whether it had:
 *
 *     private async logAction(actionId, status, request, resultDetails?) {
 *       if (!store) return;
 *       try { await setDoc(doc(store, orgPath(org, 'actionLogs'), actionId), {...}, { merge: true }); }
 *       catch (e) { console.error("[ActionGateway] Failed to audit log action:", e); }
 *     }
 *
 * It returns `void`, so `await this.logAction(actionId, 'PROPOSED', request)` is a statement whose
 * outcome no caller can inspect. A datastore that is briefly unavailable therefore prints one line
 * and the irreversible action proceeds — the exact inversion §10 is about. An unlogged send is not
 * merely an incomplete record: it is a send nobody can afterwards prove happened, to a person who
 * can prove it did.
 *
 * And every lifecycle state was written to ONE document id with `{ merge: true }`, so DISPATCHING
 * overwrote PROPOSED and SUCCESS overwrote both. What survived was the last status, not the
 * sequence — and the sequence is the thing an audit trail is. The payload was never recorded in
 * any form, so there was nothing to compare a later dispute against.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The parts of that record which are decisions rather than plumbing: what a fingerprint is
 * computed over, which statuses may not proceed without a durable write, and how a result is made
 * safe to store. They live here because the gateway needs a datastore to run and these do not, so
 * a test can put a hostile value in front of them directly.
 */

/** The statuses whose write must COMMIT before anything irreversible may follow them. */
export const MUST_COMMIT_BEFORE_PROCEEDING = Object.freeze(['PROPOSED', 'DISPATCHING'] as const);

export type DurableStatus = (typeof MUST_COMMIT_BEFORE_PROCEEDING)[number];

/**
 * Whether a failed write of this status must stop the dispatch.
 *
 * PROPOSED and DISPATCHING precede the side effect, so refusing costs nothing but a retry. SUCCESS,
 * FAILED and the reconciliation statuses follow it: by then the message may be in someone's inbox,
 * and reporting failure because the LOG failed would send it a second time. Those are recorded as
 * best-effort, and the result says so rather than pretending.
 */
export function mustCommitBefore(status: string): boolean {
  return (MUST_COMMIT_BEFORE_PROCEEDING as readonly string[]).includes(status);
}

/**
 * A deterministic rendering of a value, for hashing.
 *
 * Object keys are emitted in sorted order, so two payloads that differ only in key order produce
 * the same fingerprint — `JSON.stringify` does not promise that, and a fingerprint that changes
 * with key order cannot be compared across processes.
 *
 * `undefined` is dropped, as JSON does. A value JSON cannot represent (a BigInt, a function, a
 * cycle) is rendered as a marker rather than throwing: this runs on the path that records what
 * happened, and an exception here would lose the record it exists to make.
 */
export function stableStringify(value: unknown, seen: Set<unknown> = new Set()): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string') return JSON.stringify(value);
  if (kind === 'number') return Number.isFinite(value as number) ? String(value) : '"<non-finite>"';
  if (kind === 'boolean') return String(value);
  if (kind === 'bigint') return '"<bigint>"';
  if (kind === 'function' || kind === 'symbol' || kind === 'undefined') return '"<unrepresentable>"';
  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (seen.has(value)) return '"<cycle>"';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableStringify(item, seen)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v, seen)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * A fingerprint of the action's payload.
 *
 * THE PAYLOAD ITSELF IS NEVER STORED. It carries the recipient's address, the subject and the body
 * of a message to a real person; an audit trail that copies them creates a second place that data
 * lives and a second place it must be erased from. A digest answers the question the trail is for —
 * "is this the same thing that was approved?" — without holding the thing.
 */
export function payloadFingerprint(payload: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex')}`;
}

/**
 * A result made safe to store.
 *
 * The store REFUSES `undefined` anywhere in a document, deliberately — `JSON.stringify` drops such
 * a field silently, so the failure mode is a record missing a value the writer believed it wrote.
 * `ActionResult` is full of optional fields, so the value handed to the audit write routinely
 * contains them, and every one of those writes threw inside the old swallowing `catch`. They were
 * not being recorded and nothing said so.
 *
 * Oversized values are truncated rather than dropped: a provider error body can be very large, and
 * an audit row is not the place to put it, but knowing it was there matters.
 */
export function auditSnapshot(value: unknown, maxChars = 4_000): unknown {
  if (value === undefined || value === null) return null;
  const rendered = stableStringify(value);
  if (rendered.length > maxChars) {
    return { truncated: true, chars: rendered.length, head: rendered.slice(0, maxChars) };
  }
  try {
    return JSON.parse(rendered);
  } catch {
    // stableStringify emits JSON for everything it can represent; anything else is already a
    // marker string, and a marker is a better record than nothing.
    return { unrepresentable: true, rendered: rendered.slice(0, 200) };
  }
}

export interface AuditEventInput {
  readonly actionId: string;
  readonly seq: number;
  readonly status: string;
  readonly actionType: string;
  readonly organizationId: string;
  readonly targetId: string;
  readonly conversationId?: string | null;
  readonly proposedBy: string;
  readonly provider: string;
  readonly idempotencyKey?: unknown;
  readonly payload: unknown;
  readonly resultDetails?: unknown;
  readonly at: number;
}

/**
 * One immutable event in an action's trail.
 *
 * `seq` is what makes the sequence readable after the fact. The old record kept only the latest
 * status on one document, so "was this proposed before it was dispatched?" — the question the
 * ordering requirement exists to answer — had no answer at all.
 */
export function auditEvent(input: AuditEventInput): Record<string, unknown> {
  return {
    actionId: input.actionId,
    seq: input.seq,
    status: input.status,
    actionType: input.actionType,
    organizationId: input.organizationId,
    targetId: input.targetId,
    conversationId: input.conversationId ?? null,
    proposedBy: input.proposedBy,
    provider: input.provider,
    idempotencyKey: typeof input.idempotencyKey === 'string' ? input.idempotencyKey : null,
    payloadFingerprint: payloadFingerprint(input.payload),
    resultDetails: auditSnapshot(input.resultDetails),
    at: input.at,
  };
}
