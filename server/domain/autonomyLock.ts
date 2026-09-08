import type { Attribution } from './operatorAction';

/**
 * THE PER-CONVERSATION AUTONOMY LOCK — a stop control that could not be engaged.
 *
 * WHAT WAS WRONG
 * --------------
 * Two places enforce it, and nothing could set it.
 *
 *   - `actionGateway.checkHumanOwnershipLock` reads `autonomyPausedByHuman` and refuses the
 *     dispatch when it is true.
 *   - `outbox.worker` reads it again before dispatch, so a lock set after queueing still stops
 *     the job.
 *
 * Both are correct. But the ONLY writer of that field was
 * `aiSafetyService.setHumanOwnershipLock`, and `aiSafetyService` had no callers anywhere in the
 * repository — it was imported by the worker and never used. There was no route, no service and
 * no operator surface that could pause a conversation. A human who saw the system about to say
 * the wrong thing to a customer had no way to stop it for that customer; the two guards read a
 * flag that nothing in the running system could ever set to true.
 *
 * That is worse than an absent control, because the enforcement made it look present. Both call
 * sites carry comments explaining how carefully they honour it.
 *
 * THREE INVERSIONS IN THE READS, AS WELL
 * --------------------------------------
 * All three read an unknown state as permission, which §14 forbids:
 *
 *   1. `if (!store) return false` — no datastore meant "not locked", so the send proceeded.
 *   2. A missing conversation document meant "not locked". We had read nothing at all.
 *   3. A malformed value — `autonomyPausedByHuman: "true"`, a string — is truthy in the worker
 *      and truthy in the gateway, but `autonomyPausedByHuman: "false"` is ALSO truthy, and
 *      `autonomyPausedByHuman: 0` is falsy. The stored value decided the outcome by JavaScript
 *      coercion rather than by anybody's intent.
 *
 * And the two readers disagreed: the worker honoured `status === 'AUTONOMY_PAUSED_BY_HUMAN'` as
 * well as the boolean, the gateway did not. A conversation paused by status alone was stopped
 * by the worker and permitted by the gateway.
 *
 * WHAT THIS IS
 * ------------
 * One place that answers "may autonomy proceed on this conversation?" as THREE states, and one
 * place that builds the write which changes it. `UNKNOWN` refuses. There is nothing downstream
 * of these two guards to defer to — they are the enforcement — so "we could not tell whether a
 * human has taken this conversation" cannot resolve to "no human has".
 */

/**
 * The three states, and the display decisions the operator console makes from them, live in
 * `shared/domain/autonomyDisplay.ts` and are re-exported here.
 *
 * They moved there when the outbox console started reading the lock. The console has to name
 * the same three states this module enforces, and `src/` importing from `server/` is the
 * dependency inversion S40 is about — so the union has one definition in `shared/`, which both
 * sides already import, rather than two that agree until someone adds a state to one of them.
 *
 * Re-exported rather than relocated at the call sites. `LockState` is imported from here by
 * `services/autonomyLock.service.ts` and `tests/autonomyLock.invariant.test.ts`, and the
 * module itself by `gateway/actionGateway.ts` and `workers/outbox.worker.ts`; rewriting four
 * import lines to say `shared/` would put churn in the diff around the one line that matters,
 * and this module is still where the ENFORCEMENT lives — `mayProceed` and `refusalFor` are
 * here, and a reader following the guard should land on them rather than on a display module.
 */
export { LOCK_STATES } from '../../shared/domain/autonomyDisplay';
export type { LockState } from '../../shared/domain/autonomyDisplay';
import type { LockState } from '../../shared/domain/autonomyDisplay';

/** The field a pause writes, and the legacy status the worker already honoured. */
export const LOCK_FIELD = 'autonomyPausedByHuman';
export const LOCK_STATUS = 'AUTONOMY_PAUSED_BY_HUMAN';

/**
 * Read the lock off a conversation document.
 *
 * `exists` is passed separately rather than inferred from `data`, because a document that
 * exists and is empty is a different fact from a document that is not there: the first says
 * nobody has paused this conversation, the second says we could not look.
 *
 * AN ABSENT FIELD IS `RUNNING`, AND THAT IS DELIBERATE. It is the one place here that reads a
 * missing value as permission, so it needs its reason. The field is written only by a pause or
 * a resume, so its absence is not a failed read — it is the positive fact that no operator has
 * ever acted on this conversation. Treating it as UNKNOWN would refuse every send in the
 * system forever, which is not a safer system but a stopped one, and a control that stops
 * everything gets switched off.
 */
export function lockStateOf(exists: boolean, data: unknown): LockState {
  if (!exists) return 'UNKNOWN';
  if (data === null || typeof data !== 'object') return 'UNKNOWN';

  const record = data as Record<string, unknown>;
  const flag = record[LOCK_FIELD];
  const status = record.status;

  if (flag === true) return 'PAUSED';

  // AN EXPLICIT `false` BEATS THE LEGACY STATUS, and the order here is the whole reason this
  // function exists rather than two truthiness tests.
  //
  // The worker honoured `status === 'AUTONOMY_PAUSED_BY_HUMAN'` as a pause. If that were still
  // checked first, a conversation paused by status could never be resumed: an operator would
  // set the flag to false, this would keep reading the status, and the resume would silently
  // do nothing while reporting success. Deliberately writing `false` is the most recent
  // statement anyone made about this conversation, so it is the one that counts.
  if (flag === false) return 'RUNNING';

  if (status === LOCK_STATUS) return 'PAUSED';

  // Anything that is neither `true`, `false` nor absent was not written by this module, and a
  // value nobody here wrote is a value nobody here can interpret. `"false"` is truthy and `0`
  // is falsy; letting either decide would be letting coercion decide.
  if (flag !== undefined && flag !== null) return 'UNKNOWN';

  return 'RUNNING';
}

/**
 * The only sanctioned way to turn a lock state into a decision.
 *
 * Written as `=== 'RUNNING'` rather than `!== 'PAUSED'` so that adding a fourth state fails
 * closed. `!== 'PAUSED'` would let a new state through by default, which is how the dispatch
 * gate's `default: return true` came to exist.
 */
export function mayProceed(state: LockState): boolean {
  return state === 'RUNNING';
}

/** Why a send was refused. Throws for RUNNING: there is no refusal to explain. */
export function refusalFor(state: LockState, conversationId: string): string {
  switch (state) {
    case 'PAUSED':
      return `A human has taken ownership of conversation ${conversationId}; autonomy is paused.`;
    case 'UNKNOWN':
      return (
        `Cannot determine whether a human has taken ownership of conversation ${conversationId}. ` +
        'Refusing rather than assuming nobody has.'
      );
    case 'RUNNING':
      throw new Error('[autonomyLock] refusalFor called for a state that permits the send');
  }
}

export interface LockChangeRequest {
  readonly paused: boolean;
  readonly reason: string;
}

export type LockChangeParse =
  | { readonly ok: true; readonly value: LockChangeRequest }
  | { readonly ok: false; readonly message: string };

/** Longer than this is a document, not a reason, and it is stringified into an audit record. */
export const MAX_REASON_LENGTH = 500;

/**
 * Validate a request to change the lock.
 *
 * A REASON IS REQUIRED IN BOTH DIRECTIONS, and required most for resuming. Pausing is the safe
 * direction — it only ever stops something — while resuming hands a customer conversation back
 * to an autonomous system, and "why did we start sending to this person again?" is the question
 * an audit record has to be able to answer. `paused` must be a real boolean: accepting
 * `"false"` would resume a conversation for anyone who sent the string.
 */
export function lockChangeFrom(body: unknown): LockChangeParse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'Expected an object with `paused` and `reason`.' };
  }
  const record = body as Record<string, unknown>;

  if (typeof record.paused !== 'boolean') {
    return {
      ok: false,
      message:
        '`paused` must be true or false. A string is refused: "false" is truthy, and a resume ' +
        'must be something somebody meant.',
    };
  }

  const reason = record.reason;
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return {
      ok: false,
      message:
        '`reason` is required. Pausing and resuming a customer conversation are both operator ' +
        'decisions, and an audit record without a reason cannot answer why.',
    };
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return { ok: false, message: `\`reason\` must be at most ${MAX_REASON_LENGTH} characters.` };
  }

  return { ok: true, value: { paused: record.paused, reason: reason.trim() } };
}

/**
 * The state a conversation is in once a change has been applied.
 *
 * Derived rather than re-read. It is here and not in the caller because it has to agree with
 * `lockStateOf` reading back what `lockRecord` wrote, and keeping the two halves of that round
 * trip in one file is what lets a single test assert they agree.
 */
export function stateAfter(change: LockChangeRequest): LockState {
  return change.paused ? 'PAUSED' : 'RUNNING';
}

export interface LockRecord {
  readonly autonomyPausedByHuman: boolean;
  readonly autonomyLockReason: string;
  readonly autonomyLockActor: string | null;
  readonly autonomyLockUnattributedReason: string | null;
  readonly autonomyLockAt: string;
}

/**
 * The fields a lock change writes.
 *
 * `at` is passed in rather than read from the clock here, so the record is a pure function of
 * its inputs and a test can hold the time still (§30).
 *
 * The attribution is written as TWO fields that cannot both be populated, rather than one
 * string with a fallback. `actor: 'unknown-operator'` reads in an audit log exactly like a user
 * account of that name; "nobody could be identified" is a different fact and is recorded as
 * one — the same shape S38 established for the outbox.
 */
export function lockRecord(input: {
  change: LockChangeRequest;
  attribution: Attribution;
  at: string;
}): LockRecord {
  const { change, attribution, at } = input;
  return {
    autonomyPausedByHuman: change.paused,
    autonomyLockReason: change.reason,
    autonomyLockActor: attribution.kind === 'IDENTIFIED' ? attribution.actor : null,
    autonomyLockUnattributedReason: attribution.kind === 'IDENTIFIED' ? null : attribution.why,
    autonomyLockAt: at,
  };
}

/**
 * THE IDS THE OPERATOR CONSOLE MAY ASK ABOUT IN ONE REQUEST.
 *
 * The console shows a queue of messages and needs the lock state for each one's conversation.
 * Asking per row is one request per message from a browser that has just rendered them all;
 * asking for everything is an endpoint whose cost is set by the caller, which is exactly what
 * P0.5 was about.
 *
 * So the caller names the conversations, and this decides whether that list is answerable.
 *
 * IT REFUSES RATHER THAN TRUNCATES. A cap that silently drops the tail returns a map missing
 * the conversations it dropped, and `lockStateAt` reads an absent conversation as UNKNOWN —
 * so the console would show "lock unreadable" on rows that were simply never asked about, and
 * the operator would go looking for a datastore fault that does not exist. Refusing names the
 * problem at the caller, which is where the fix is.
 */
export const MAX_BATCH_IDS = 100;

/** The longest a conversation id may be before this is a payload rather than an identifier. */
export const MAX_ID_LENGTH = 200;

export type ConversationIdsParse =
  | { readonly ok: true; readonly ids: string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Parse `?conversationIds=a,b,c`.
 *
 * An ABSENT parameter and an EMPTY one both mean "no conversations", which is a legitimate
 * request that returns an empty map — the console renders an empty queue and asks about
 * nothing. That is not the same as a malformed list, which is refused.
 *
 * An EMPTY SEGMENT — `a,,b` — is refused rather than skipped. Skipping it means the caller
 * asked about three conversations, got two, and is told nothing; the third then renders as
 * UNKNOWN for a reason that is a typo in a query string.
 *
 * The segment rules mirror `assertDocumentId` in `server/store/index.ts` deliberately. Without
 * them a `/` in an id reaches the store, throws `StorePathError`, and `sendCaught` answers 500
 * — an input error reported as a server fault, with the operator told to check the logs.
 */
export function conversationIdsFrom(
  raw: unknown,
  max: number = MAX_BATCH_IDS
): ConversationIdsParse {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };

  if (typeof raw !== 'string') {
    // Express turns a repeated query parameter into an array. Refusing rather than joining:
    // `?conversationIds=a&conversationIds=b` and `?conversationIds=a,b` should not be two
    // spellings of one request, because only one of them is bounded by this parser.
    return {
      ok: false,
      message:
        '`conversationIds` must be a single comma-separated string. Repeat the parameter and ' +
        'the request means two different things depending on which one is read.',
    };
  }

  if (raw.trim().length === 0) return { ok: true, ids: [] };

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const segment of raw.split(',')) {
    const id = segment.trim();
    if (id.length === 0) {
      return {
        ok: false,
        message:
          '`conversationIds` contains an empty entry. Refusing rather than skipping it: a ' +
          'dropped id comes back as an unreadable lock, which reads as a datastore fault.',
      };
    }
    if (id.length > MAX_ID_LENGTH) {
      return {
        ok: false,
        message: `A conversation id may be at most ${MAX_ID_LENGTH} characters.`,
      };
    }
    if (id.includes('/') || id === '.' || id === '..') {
      return {
        ok: false,
        message: `Conversation id ${JSON.stringify(id)} would change the shape of a store path.`,
      };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  if (ids.length > max) {
    return {
      ok: false,
      message:
        `At most ${max} conversations may be read at once; ${ids.length} were requested. ` +
        'The list is refused rather than truncated, because a dropped conversation is ' +
        'indistinguishable from one whose lock could not be read.',
    };
  }

  return { ok: true, ids };
}
