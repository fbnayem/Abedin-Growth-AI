import { store as defaultStore, doc, getDoc, runTransaction, type DocumentStore } from '../store';
import { orgPath } from '../tenancy/orgScope';
import type { Attribution } from '../domain/operatorAction';
import {
  lockChangeFrom,
  lockRecord,
  lockStateOf,
  stateAfter,
  type LockState,
} from '../domain/autonomyLock';

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
