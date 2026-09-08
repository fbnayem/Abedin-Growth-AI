/**
 * WHAT THE OPERATOR CONSOLE IS ALLOWED TO SAY ABOUT THE AUTONOMY LOCK.
 *
 * WHY THIS IS A MODULE AND NOT THREE TERNARIES IN A COMPONENT
 * -----------------------------------------------------------
 * `vitest.config.ts` is `environment: 'node'` and includes only `server/tests/**`, so there is
 * no way to render a React component here and assert on what it displays. A decision written
 * inline in `OutboxView.tsx` is a decision no test in this repository can reach — which is the
 * same reason `autonomyLock.service.ts` exists, and the same reason two mutations of the
 * autonomy route survived the whole gate before that split.
 *
 * So the decisions live here as pure functions over data, the component renders what they
 * return, and `autonomyDisplay.invariant.test.ts` calls them directly.
 *
 * THE INVARIANT THIS FILE CARRIES
 * -------------------------------
 * §14: unknown must never resolve to permission. On this surface "permission" means the row
 * that tells an operator autonomy is running and the approve button is safe to press.
 *
 * There are four separate ways this console can fail to know the state of a conversation, and
 * every one of them used to be indistinguishable from RUNNING because the console did not read
 * the lock at all:
 *
 *   1. The lock request has not returned yet (`locks` is null).
 *   2. The request failed, so there is no map.
 *   3. The request succeeded but this conversation is not in it.
 *   4. The entry is there and carries a state this build does not know.
 *
 * All four are UNKNOWN, and UNKNOWN is displayed as a refusal, not as a blank.
 *
 * THE SECOND THING THIS FIXES IS THE APPROVE BUTTON
 * -------------------------------------------------
 * `outbox.worker.ts:143-147` reads the lock immediately before dispatch and, when it does not
 * permit the send, calls `outboxService.markFailed(orgId, job.id, LOCK_STATUS, true)`. The
 * fourth argument is `terminal`, and `markFailed` branches on it to write `DEAD_LETTER`
 * directly — not FAILED, not a retry.
 *
 * So approving a message on a paused conversation does not hold it and does not send it: on
 * the next worker tick it is dead-lettered, and recovering it costs an operator a second
 * decision through `/requeue`. The console showed a green "Approve" and said none of this.
 * A control that quietly does something other than what its label says is worse than one that
 * is missing, which is the same finding as the lock itself.
 */

/**
 * The three states, defined HERE and re-exported by `server/domain/autonomyLock.ts`.
 *
 * One definition rather than two, because the alternative is a client union and a server union
 * that agree until someone adds a state to one of them. The direction is deliberate: `shared/`
 * is imported by both `src/` and `server/` throughout this repository, and `src/` importing
 * from `server/` is the dependency inversion S40 is about.
 */
export const LOCK_STATES = ['PAUSED', 'RUNNING', 'UNKNOWN'] as const;
export type LockState = (typeof LOCK_STATES)[number];

/** One conversation's lock, as the batch endpoint reports it. */
export interface ConversationLock {
  readonly state: LockState;
  readonly reason: string | null;
  readonly actor: string | null;
  readonly at: string | null;
}

export type LockMap = Readonly<Record<string, ConversationLock>>;

/** Narrow an untrusted value to a state this build knows. */
export function isLockState(value: unknown): value is LockState {
  return typeof value === 'string' && (LOCK_STATES as readonly string[]).includes(value);
}

/**
 * Turn the batch endpoint's response body into a map.
 *
 * THIS IS HERE AND NOT IN THE COMPONENT because it was in the component, and the mutation that
 * rebuilt the `__proto__` shape below survived the gate — nothing can import a decision that
 * lives inside a `.tsx` module under `environment: 'node'`. Parsing an untrusted network body
 * is a decision, not presentation.
 *
 * `Object.create(null)` and not `{}`: for a conversation whose id is the string `__proto__`,
 * `out[id] = entry` does not add a key. It invokes the `__proto__` setter and replaces this
 * object's PROTOTYPE with the entry, after which `locks['__proto__']` reads that entry back as
 * though the server had reported it. A null-prototype object has no such setter, so the key is
 * stored as an ordinary property and `lockStateAt`'s own-property check answers correctly.
 * Both halves are kept: this stops the shape existing, and `lockStateAt` refuses to read it.
 *
 * Every entry that is not an object carrying a state this build knows is DROPPED, which leaves
 * that conversation absent from the map — and absent is UNKNOWN, which refuses (§18: material
 * that arrived over the network has no authority here).
 */
export function parseLockMap(body: unknown): LockMap {
  const out: Record<string, ConversationLock> = Object.create(null);
  const raw = (body as { locks?: unknown } | null | undefined)?.locks;
  if (raw === null || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (!isLockState(entry.state)) continue;
    out[id] = {
      state: entry.state,
      reason: typeof entry.reason === 'string' ? entry.reason : null,
      actor: typeof entry.actor === 'string' ? entry.actor : null,
      at: typeof entry.at === 'string' ? entry.at : null,
    };
  }
  return out;
}

/**
 * The state to display for one conversation.
 *
 * EVERY WAY OF NOT KNOWING RETURNS `UNKNOWN`, and there is no fifth branch that returns
 * anything else. A null map is "not loaded or failed"; an absent key is "the server answered
 * and did not mention this conversation"; a present entry whose `state` is not one of the three
 * is a response this build cannot interpret.
 *
 * The last case is not defensive noise. This value arrives over the network, and §18 says
 * externally retrieved material carries no authority — a body that says
 * `{"state": "ACTIVE"}` must not become a green badge because `'ACTIVE' !== 'PAUSED'`.
 */
export function lockStateAt(
  locks: LockMap | null | undefined,
  conversationId: string | null | undefined
): LockState {
  if (!locks || typeof conversationId !== 'string' || conversationId.length === 0) {
    return 'UNKNOWN';
  }
  // `Object.prototype.hasOwnProperty` and not a bare lookup, and this guard is LOAD-BEARING
  // rather than defensive habit. Removing it was mutation-tested, and it is not an equivalent
  // mutant: the distinguishing input is a conversation whose id is `__proto__`.
  //
  // A map built by assignment — `out[id] = entry`, which is what a parser writes — does not
  // create an own property for that key. It invokes the `__proto__` setter and moves the
  // object's PROTOTYPE. A bare `locks['__proto__']` then reads that entry back, it is an
  // object, its `state` is a real state, and the console shows "autonomy active" for a
  // conversation nobody read. Measured both ways: with the guard UNKNOWN, without it RUNNING.
  //
  // `assertDocumentId` in `server/store/index.ts` admits `__proto__` — it is a non-empty
  // string containing no `/` — so the id is reachable rather than hypothetical.
  if (!Object.prototype.hasOwnProperty.call(locks, conversationId)) return 'UNKNOWN';
  const entry = locks[conversationId];
  if (entry === null || typeof entry !== 'object') return 'UNKNOWN';
  return isLockState(entry.state) ? entry.state : 'UNKNOWN';
}

/** The metadata behind a lock, when the entry is one this build can read. */
export function lockDetailAt(
  locks: LockMap | null | undefined,
  conversationId: string | null | undefined
): ConversationLock | null {
  if (lockStateAt(locks, conversationId) === 'UNKNOWN') {
    // Deliberately null even when an UNKNOWN entry carries a reason: the reason describes a
    // state we could not confirm, and showing it beside "unknown" reads as an explanation.
    return null;
  }
  return (locks as LockMap)[conversationId as string];
}

/**
 * What pressing Approve will actually cause, given the lock.
 *
 * Named for the outcome rather than for permission, because the operator's question is not
 * "am I allowed" — the button is always allowed — but "what happens to this message".
 */
export type ApprovalEffect = 'SENDS' | 'DEAD_LETTERS';

/**
 * `RUNNING` is the only state under which approval reaches a provider.
 *
 * Written as an equality on RUNNING rather than as `state === 'PAUSED' ? … : 'SENDS'`, so that
 * a fourth lock state added later dead-letters rather than sends. The same reasoning as
 * `mayProceed`, and for the same reason: the failure of the original dispatch gate was a
 * `default:` that permitted.
 */
export function approvalEffectFor(state: LockState): ApprovalEffect {
  return state === 'RUNNING' ? 'SENDS' : 'DEAD_LETTERS';
}

/**
 * The sentence shown beside Approve when approval will not send.
 *
 * `null` for the case where it will, so the component has nothing to render rather than an
 * empty string that still occupies a line.
 */
export function approvalWarningFor(state: LockState): string | null {
  switch (state) {
    case 'RUNNING':
      return null;
    case 'PAUSED':
      return (
        'Autonomy is paused on this conversation. Approving will NOT send it — the worker ' +
        'dead-letters the message immediately before dispatch. Resume the conversation first.'
      );
    case 'UNKNOWN':
      return (
        'The autonomy lock for this conversation could not be read, so the worker will refuse ' +
        'rather than assume nobody has taken it. Approving will dead-letter the message.'
      );
  }
}

export type LockTone = 'running' | 'paused' | 'unknown';

export interface LockDisplay {
  readonly label: string;
  readonly detail: string;
  readonly tone: LockTone;
  /** Whether the resume control is the one to offer. False means offer pause. */
  readonly offerResume: boolean;
}

/**
 * How the badge reads.
 *
 * UNKNOWN GETS ITS OWN TONE AND ITS OWN LABEL. Folding it into the paused styling would be
 * safe for dispatch — both refuse — but it would tell the operator a human paused this
 * conversation, and nobody did. The two facts lead to different actions: one is resolved by
 * resuming, the other by finding out why the datastore did not answer.
 *
 * `offerResume` is FALSE for UNKNOWN. Offering "Resume" for a conversation whose state was
 * never read invites an operator to clear a condition they cannot see, and a resume written
 * against an unread lock is an explicit `false` that outranks the legacy status — the one write
 * in this system that can turn a paused conversation back on by accident.
 */
export function lockDisplayFor(state: LockState): LockDisplay {
  switch (state) {
    case 'RUNNING':
      return {
        label: 'Autonomy active',
        detail: 'No human has taken this conversation. Approved messages will dispatch.',
        tone: 'running',
        offerResume: false,
      };
    case 'PAUSED':
      return {
        label: 'Paused by human',
        detail: 'Autonomy is stopped for this conversation. Nothing will dispatch.',
        tone: 'paused',
        offerResume: true,
      };
    case 'UNKNOWN':
      return {
        label: 'Lock unreadable',
        detail:
          'The lock state could not be read. Sending refuses rather than assuming nobody has ' +
          'taken this conversation.',
        tone: 'unknown',
        offerResume: false,
      };
  }
}
