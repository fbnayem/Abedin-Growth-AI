/**
 * S38 — what an operator did, who they were, and what it moved.
 *
 * WHAT WAS THERE
 * --------------
 * Approve wrote `approvedBy` and `approvedAt` onto the job document. That is attribution, and it
 * is not a trail: the next approval overwrites it, a rejection records nothing comparable, and
 * there is no way to ask "what has anyone done to this queue" because the answer only exists as
 * the current state of each row. `actionLogs` exists but is written by the gateway for actions
 * it dispatched, not for decisions a human made.
 *
 * And there was no way back from DEAD_LETTER at all. A job that exhausted its attempts, or was
 * refused for a stale draft, could only be recovered by an engineer editing the datastore by
 * hand — with, by construction, no record of who changed what.
 *
 * WHY AN UNATTRIBUTED ACTION IS NOT ANONYMOUS
 * -------------------------------------------
 * `actorOf(req)` fell back to the string `'unknown-operator'`, which reads in a log exactly like
 * a user account of that name. An action nobody can be identified for is a different fact from
 * an action taken by somebody called unknown-operator, and only one of them is true.
 *
 * So attribution is a state, not a string. In production an unattributed operator action is
 * REFUSED rather than recorded: releasing a message to a customer is the moment attribution
 * matters most, and `requireAuth` admits anonymous callers when `ALLOW_ANONYMOUS_DEV_AUTH` is
 * set — which is ignored in production precisely so that this cannot happen there.
 */

export const OPERATOR_ACTIONS = ['APPROVE', 'REJECT', 'REQUEUE'] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

/**
 * Who took the action.
 *
 * No `actor` field on the unattributed arm, so a caller cannot read one off a record that does
 * not have one. That is the whole reason this is a union rather than `actor?: string`.
 */
export type Attribution =
  | { readonly kind: 'IDENTIFIED'; readonly actor: string }
  | { readonly kind: 'UNATTRIBUTED'; readonly why: string };

/** The claims an authenticated request can carry. Deliberately not the express Request type. */
export interface ActorClaims {
  readonly email?: unknown;
  readonly uid?: unknown;
}

/**
 * Resolve attribution from whatever the auth layer left on the request.
 *
 * An empty or whitespace-only value is not an identity. Neither is a non-string — a claim that
 * arrives as an object would stringify to `[object Object]` and sit in the log looking like an
 * account name.
 */
export function attributionFor(claims: ActorClaims | null | undefined): Attribution {
  const candidates = [claims?.email, claims?.uid];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return { kind: 'IDENTIFIED', actor: candidate.trim() };
    }
  }
  return {
    kind: 'UNATTRIBUTED',
    why: 'the request carried no email or uid, so no operator can be named for this action',
  };
}

/**
 * May an unattributed caller mutate the queue?
 *
 * Never in production. Elsewhere it is allowed so that a local developer without Firebase Auth
 * can use the console — the same trade `ALLOW_ANONYMOUS_DEV_AUTH` makes, and the same place it
 * stops.
 */
export function mayActUnattributed(isProduction: boolean): boolean {
  return isProduction === false;
}

export interface OperatorActionRecord {
  readonly action: OperatorAction;
  readonly organizationId: string;
  readonly jobId: string;
  /** `null` when unattributed. Never a placeholder that reads like an account. */
  readonly actor: string | null;
  readonly attribution: Attribution['kind'];
  readonly fromStatus: string;
  readonly toStatus: string;
  /** Free text from the operator. Absent rather than invented when they gave none. */
  readonly reason: string | null;
  readonly at: number;
}

/**
 * Build the record for one operator action.
 *
 * @throws if the action would be recorded with a from-state equal to its to-state, or with an
 *         empty job or organisation id. A record that says nothing moved is worse than no
 *         record: it is evidence that something was reviewed.
 */
export function operatorActionRecord(input: {
  action: OperatorAction;
  organizationId: string;
  jobId: string;
  attribution: Attribution;
  fromStatus: string;
  toStatus: string;
  reason?: string | null;
  at: number;
}): OperatorActionRecord {
  if (!input.organizationId || !input.jobId) {
    throw new Error('[operatorAction] a record must name the organisation and the job');
  }
  if (input.fromStatus === input.toStatus) {
    throw new Error(
      `[operatorAction] ${input.action} would record ${input.fromStatus} -> ${input.toStatus}. ` +
        'An action that moved nothing must not leave a record saying it did.'
    );
  }
  const reason = typeof input.reason === 'string' && input.reason.trim().length > 0
    ? input.reason.trim()
    : null;
  return {
    action: input.action,
    organizationId: input.organizationId,
    jobId: input.jobId,
    actor: input.attribution.kind === 'IDENTIFIED' ? input.attribution.actor : null,
    attribution: input.attribution.kind,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reason,
    at: input.at,
  };
}

/**
 * Where a REQUEUE puts a job, given where it is now.
 *
 * DEAD_LETTER goes to HUMAN_REVIEW, not to PENDING. That is not a detail: PENDING is claimable
 * by the worker on its next tick, so requeueing straight to it would let one operator click
 * re-send a message that had already failed five times or been refused for a stale draft, with
 * no second look. The shared transition map encodes this — `DEAD_LETTER -> PENDING` is not a
 * legal edge — and this function agrees with it rather than restating it loosely.
 *
 * FAILED goes to PENDING, because a FAILED job is already on its way back there under backoff;
 * the operator is asking for it to happen now rather than for a different outcome.
 */
/**
 * May this caller mutate the queue, and as whom?
 *
 * A function rather than an `if` inside the route handler, because a decision expressed only as
 * a condition in a handler can only be tested by reading the source — and a source assertion
 * cannot tell `if (x)` from `if (false)`. That was measured: mutating the guard to `if (false)`
 * left every assertion about it passing.
 */
export type OperatorGate =
  | { readonly allowed: true; readonly attribution: Attribution }
  | { readonly allowed: false; readonly message: string };

export function operatorGate(
  claims: ActorClaims | null | undefined,
  isProduction: boolean
): OperatorGate {
  const attribution = attributionFor(claims);
  if (attribution.kind === 'UNATTRIBUTED' && mayActUnattributed(isProduction) === false) {
    return {
      allowed: false,
      message:
        'This action changes a customer-facing queue and must be attributable to an operator. ' +
        'The request carried no identity.',
    };
  }
  return { allowed: true, attribution };
}

/**
 * The reason an operator gave for a requeue.
 *
 * Required. A requeue is a decision to try again with something that already failed, and
 * recording it without why leaves the next operator the same question and no more information
 * than the first one had.
 */
export type RequeueReason =
  | { readonly ok: true; readonly reason: string }
  | { readonly ok: false; readonly message: string };

export function requeueReasonFrom(body: unknown): RequeueReason {
  const raw = (body as { reason?: unknown } | null | undefined)?.reason;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return { ok: true, reason: raw.trim() };
  }
  return {
    ok: false,
    message:
      'A requeue must say why. This job already failed, and the reason is what the next ' +
      'operator has to go on.',
  };
}

/** The minimum of a datastore transaction this module needs. */
export interface AuditWriter {
  set(ref: unknown, data: unknown): void;
}

/**
 * Write the audit row through the caller's transaction.
 *
 * Lives here rather than in the service so it can be called directly by a test: handed a null
 * collection it must throw, and handed a working one it must write exactly one record. Both of
 * those were previously asserted by grepping the service for a `throw`, which a mutant turning
 * the guard into `if (false)` walked straight past.
 *
 * @throws when there is nowhere to record the action. A queue change that succeeded while its
 *         record failed is a customer-facing change with nothing saying who made it.
 */
export function writeOperatorAction(
  tx: AuditWriter,
  target: { collection: unknown; newDocRef: (collection: unknown) => unknown } | null,
  input: {
    action: OperatorAction;
    organizationId: string;
    jobId: string;
    attribution: Attribution;
    fromStatus: string;
    toStatus: string;
    reason: string | null;
    at: number;
  }
): OperatorActionRecord {
  if (target === null) {
    throw new Error(
      '[operatorAction] the audit collection is unavailable, so this action would change the ' +
        'queue without leaving a record. Refusing.'
    );
  }
  const record = operatorActionRecord(input);
  tx.set(target.newDocRef(target.collection), record);
  return record;
}

export type RequeueTarget =
  | { readonly ok: true; readonly toStatus: 'HUMAN_REVIEW' | 'PENDING' }
  | { readonly ok: false; readonly message: string };

export function requeueTargetFor(currentStatus: string): RequeueTarget {
  if (currentStatus === 'DEAD_LETTER') return { ok: true, toStatus: 'HUMAN_REVIEW' };
  if (currentStatus === 'FAILED') return { ok: true, toStatus: 'PENDING' };
  return {
    ok: false,
    message:
      `Job is ${currentStatus}. Only a FAILED or DEAD_LETTER job can be requeued — ` +
      'a PENDING or CLAIMED job is already on its way, and PROCESSED and CANCELLED are terminal.',
  };
}
