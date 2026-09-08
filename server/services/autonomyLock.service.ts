import { store as defaultStore, doc, getDoc, runTransaction, type DocumentStore } from '../store';
import { orgPath } from '../tenancy/orgScope';
import type { Attribution } from '../domain/operatorAction';
import {
  conversationIdsFrom,
  lockChangeFrom,
  lockRecord,
  lockStateOf,
  stateAfter,
  type LockState,
} from '../domain/autonomyLock';
import type { ConversationLock } from '../../shared/domain/autonomyDisplay';

/**
 * READING AND CHANGING THE AUTONOMY LOCK, separated from the HTTP route.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * It was written because a mutant survived. The route originally held this logic inline, and
 * an edit that made it report a state it had not written — `const to = 'PAUSED'` regardless of
 * what the operator asked for — passed the entire gate. So did removing the attribution check.
 * Nothing exercised the handler, because exercising an express handler requires a request.
 *
 * A survivor is a statement about the tests, not the code: the behaviour was correct and
 * unprotected. Moving it here makes it a function that takes its inputs and returns its result,
 * which a test can call directly, and leaves the route as glue with nothing in it worth
 * mutating.
 *
 * THE STORE IS A PARAMETER, not an import used directly. That is the same reason: a test has to
 * be able to hand this an unavailable store and see what it does, because "there is no
 * datastore" is one of the states this has to answer for, and answering it wrong was one of the
 * original defects (`if (!store) return false` — no datastore meant "no human has taken this
 * conversation", and the send proceeded).
 */

export type LockReadResult =
  | {
      readonly ok: true;
      readonly conversationId: string;
      readonly state: LockState;
      readonly reason: string | null;
      readonly actor: string | null;
      readonly at: string | null;
    }
  | { readonly ok: false; readonly code: 'STORE_UNAVAILABLE'; readonly message: string };

export type LockChangeResult =
  | {
      readonly ok: true;
      readonly conversationId: string;
      readonly from: LockState;
      readonly to: LockState;
      readonly reason: string;
      readonly actor: string | null;
      readonly unattributedBecause: string | null;
      readonly at: string;
    }
  | {
      readonly ok: false;
      readonly code: 'STORE_UNAVAILABLE' | 'VALIDATION_ERROR';
      readonly message: string;
    };

const UNAVAILABLE =
  'The datastore is unavailable, so the autonomy lock can be neither read nor changed. ' +
  'Autonomous sending refuses while this is true, rather than proceeding as though nobody ' +
  'had paused the conversation.';

/** A string field off an untrusted document, or null. Never coerced. */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export async function readLock(
  orgId: string,
  conversationId: string,
  store: DocumentStore | null = defaultStore
): Promise<LockReadResult> {
  if (!store) return { ok: false, code: 'STORE_UNAVAILABLE', message: UNAVAILABLE };

  const snap = await getDoc(doc(store, orgPath(orgId, 'conversations'), conversationId));
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    conversationId,
    state: lockStateOf(snap.exists(), snap.data()),
    reason: stringOrNull(data.autonomyLockReason),
    actor: stringOrNull(data.autonomyLockActor),
    at: stringOrNull(data.autonomyLockAt),
  };
}

/**
 * Pause or resume autonomy for one conversation.
 *
 * `at` is passed in rather than read from the clock, so the audit timestamp is the caller's and
 * a test can hold time still (§30).
 *
 * The write MERGES, so the conversation's inbound version and approval digest survive a pause.
 * A pause that reset the draft-integrity fields would turn a safety action into a way of making
 * a stale draft look fresh.
 *
 * The resulting state is DERIVED through `stateAfter` rather than re-read, because
 * `server/store/index.ts` records that nothing in this repository reads a document after
 * writing it in the same transaction. That shortcut is only honest if a written record really
 * does read back as the state requested, which `autonomyLock.invariant.test.ts` asserts as a
 * round trip.
 */
export async function changeLock(input: {
  orgId: string;
  conversationId: string;
  body: unknown;
  attribution: Attribution;
  at: string;
  store?: DocumentStore | null;
}): Promise<LockChangeResult> {
  const store = input.store === undefined ? defaultStore : input.store;
  if (!store) return { ok: false, code: 'STORE_UNAVAILABLE', message: UNAVAILABLE };

  const parsed = lockChangeFrom(input.body);
  if (parsed.ok === false) {
    return { ok: false, code: 'VALIDATION_ERROR', message: parsed.message };
  }

  const ref = doc(store, orgPath(input.orgId, 'conversations'), input.conversationId);

  const from = await runTransaction(store, async (tx) => {
    const snap = await tx.get(ref);
    const before = lockStateOf(snap.exists(), snap.data());
    await tx.set(
      ref,
      lockRecord({ change: parsed.value, attribution: input.attribution, at: input.at }),
      { merge: true }
    );
    return before;
  });

  return {
    ok: true,
    conversationId: input.conversationId,
    from,
    to: stateAfter(parsed.value),
    reason: parsed.value.reason,
    actor: input.attribution.kind === 'IDENTIFIED' ? input.attribution.actor : null,
    unattributedBecause: input.attribution.kind === 'IDENTIFIED' ? null : input.attribution.why,
    at: input.at,
  };
}

export type LockBatchResult =
  | { readonly ok: true; readonly locks: Record<string, ConversationLock> }
  | {
      readonly ok: false;
      readonly code: 'STORE_UNAVAILABLE' | 'VALIDATION_ERROR';
      readonly message: string;
    };

/**
 * The batch read as the ROUTE needs it: raw query value in, answer out.
 *
 * This exists because a mutant survived. The route used to parse the id list itself and branch
 * on the result, and replacing that branch with `if (false)` — accepting `a/b`, `a,,b`, and a
 * list of any length — passed the entire gate. Nothing exercised it, because exercising an
 * express handler requires a request.
 *
 * That is the third time on this control that moving a decision out of a handler was the fix.
 * The route is glue now: it maps `code` to a status and has nothing left worth mutating.
 */
export async function readLocksFor(
  orgId: string,
  rawConversationIds: unknown,
  store: DocumentStore | null = defaultStore
): Promise<LockBatchResult> {
  const parsed = conversationIdsFrom(rawConversationIds);
  if (parsed.ok === false) {
    return { ok: false, code: 'VALIDATION_ERROR', message: parsed.message };
  }
  return readLocks(orgId, parsed.ids, store);
}

/**
 * Read the lock for several conversations at once, for the operator console.
 *
 * ONE REQUEST, NOT ONE PER ROW. The outbox console renders a queue and needs a badge on every
 * row; per-row requests make the cost of drawing the page a function of how much mail is
 * waiting, which is the shape P0.5 was about even when the caller is trusted.
 *
 * A CONVERSATION THAT COULD NOT BE READ IS OMITTED, NOT DEFAULTED. There is no entry for it in
 * the returned map, and `lockStateAt` in `shared/domain/autonomyDisplay.ts` reads an absent
 * conversation as UNKNOWN, which the console renders as a refusal. The alternative — an entry
 * saying RUNNING because the read threw — is the §14 inversion this whole control was built to
 * remove, and it would appear at the exact moment the datastore is in trouble.
 *
 * `Promise.allSettled` and not `Promise.all` for the same reason: with `all`, one unreadable
 * conversation would reject the batch and the console would lose the states it DID read,
 * including the paused ones. A partial answer where every gap reads as UNKNOWN is strictly
 * more informative than no answer, and no less safe, because both refuse.
 */
export async function readLocks(
  orgId: string,
  conversationIds: readonly string[],
  store: DocumentStore | null = defaultStore
): Promise<LockBatchResult> {
  if (!store) return { ok: false, code: 'STORE_UNAVAILABLE', message: UNAVAILABLE };

  const settled = await Promise.allSettled(
    conversationIds.map((id) => readLock(orgId, id, store))
  );

  const locks: Record<string, ConversationLock> = {};
  settled.forEach((outcome, index) => {
    const conversationId = conversationIds[index];
    if (outcome.status !== 'fulfilled') {
      console.warn(
        `[autonomyLock] Could not read the lock for conversation ${conversationId}; it is ` +
          'omitted from the batch and will display as unreadable.',
        outcome.reason instanceof Error ? outcome.reason.message : outcome.reason
      );
      return;
    }
    const result = outcome.value;
    if (result.ok === false) return;
    locks[conversationId] = {
      state: result.state,
      reason: result.reason,
      actor: result.actor,
      at: result.at,
    };
  });

  return { ok: true, locks };
}
