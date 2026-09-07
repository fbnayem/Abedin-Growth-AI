import { createHash } from 'node:crypto';
import {
  collection,
  doc,
  getDocs,
  query as fsQuery,
  limit as fsLimit,
  runTransaction,
} from '../store';
import { store } from '../store';
import { orgPath } from '../tenancy/orgScope';
import {
  activeFacts,
  planFactWrite,
  type FactObservation,
  type FactRejection,
  type StoredFact,
} from '../domain/facts';

/**
 * P1.6 — The fact store, on the datastore that actually runs (addendum §20, §21).
 *
 * There was no fact collection on Firestore at all. The single write in the repository went to
 * PostgreSQL through the throwing Drizzle proxy, deleted every prior fact for the conversation,
 * and then crashed on `(memory as any).facts` before inserting anything — so an inbound message
 * erased a conversation's facts and wrote none back.
 *
 * Facts live under the conversation they belong to:
 *
 *     organizations/{orgId}/conversations/{conversationId}/facts/{factId}
 *
 * so listing a conversation's facts needs no composite index and no cross-tenant predicate —
 * the path itself carries the tenant, which is the same reason orgPath exists.
 */

/**
 * The cap on facts loaded for one conversation.
 *
 * NOT "the oldest are not loaded" — that was the old docstring and it was false. The window is
 * unordered, so which facts fall outside it is arbitrary. `listFactPage` reports when the cap
 * was exceeded so a caller can tell a complete history from a partial one.
 */
export const MAX_FACTS_PER_CONVERSATION = 500;

function factsPath(orgId: string, conversationId: string): string {
  return orgPath(orgId, 'conversations', conversationId, 'facts');
}

/**
 * A deterministic id for one observation.
 *
 * Derived from the conversation, key, source message and value, so REPROCESSING THE SAME
 * MESSAGE IS IDEMPOTENT. That matters more than it looks: the inbound pipeline can be retried
 * — a provider redelivery, a worker restart mid-run — and a random id would turn each retry
 * into a fresh "the customer changed their mind" entry in the history.
 *
 * The value is part of the id because the same key from the same message with a different
 * value is a genuinely different observation, not a retry of the first.
 */
export function factId(
  conversationId: string,
  key: string,
  sourceMessageId: string | null | undefined,
  value: string
): string {
  const material = [conversationId, key, sourceMessageId ?? 'no-source', value].join('\u0000');
  return `ft_${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32)}`;
}

export type FactWriteOutcome =
  | { ok: true; action: 'CREATE' | 'SUPERSEDE' | 'CONFIRM'; factId: string }
  | { ok: false; code: FactRejection['code']; message: string }
  | { ok: false; code: 'STORE_UNAVAILABLE'; message: string }
  | { ok: false; code: 'CONFLICT'; message: string }
  | { ok: false; code: 'HISTORY_TRUNCATED'; message: string };

/**
 * Read every fact for a conversation, history included.
 *
 * Callers that want only what is currently true use `activeFacts()` on the result. The default
 * is the full history because that is what a fact store is FOR — the previous implementation's
 * defining mistake was treating the current value as the only thing worth keeping.
 */
export async function listFacts(orgId: string, conversationId: string): Promise<StoredFact[]> {
  return (await listFactPage(orgId, conversationId)).facts;
}

/**
 * Was the loaded set cut short?
 *
 * Separated from the query so the decision is testable without Firestore. Mutating the inlined
 * form to `const truncated = false` made the refusal in `recordFact` unreachable and survived
 * the whole suite — the tests asserted the fetch limit and the branch, but nothing asserted the
 * value that reaches the branch.
 */
export function exceededCap(loadedCount: number): boolean {
  return loadedCount > MAX_FACTS_PER_CONVERSATION;
}

/**
 * A conversation's facts, and whether that is ALL of them.
 *
 * WHY THE TRUNCATION FLAG EXISTS
 * ------------------------------
 * The query was `fsQuery(collection(...), fsLimit(MAX_FACTS_PER_CONVERSATION))` with no
 * ordering, so the 500-document window was sliced by Firestore's implicit `__name__` order.
 * Document ids here are `ft_` + a sha256 prefix — uncorrelated with time, with the key, with
 * anything. The docstring on MAX_FACTS_PER_CONVERSATION said "beyond this the oldest are not
 * loaded"; which 500 survived was determined by a hash.
 *
 * That is not merely a stale read, because `recordFact` finds the fact to supersede from
 * exactly this list. If the currently-active fact for a key fell outside the window, `current`
 * was null, `planFactWrite` returned CREATE, and a SECOND ACTIVE DOCUMENT was written for the
 * same key — the first never given `validUntil`, never given `supersededBy`. Both would then
 * render into the same prompt as simultaneously in force, and the §20 supersession chain would
 * be broken with nothing reported to anyone.
 *
 * The fix is not a bigger limit; any limit has this edge. It is that a caller must be able to
 * tell a complete history from a partial one, so "I found no active fact for this key" can be
 * distinguished from "I did not look at all of them" (§14).
 *
 * NO `orderBy` IS ADDED, DELIBERATELY. Firestore EXCLUDES documents that lack the ordered
 * field, so ordering by `validFrom` would silently drop any legacy document written without it
 * — reintroducing this same class of defect through the fix for it. The truncation flag is the
 * property that makes the window safe; the ordering only decides which arbitrary subset is
 * loaded, and the caller is now told when the subset is arbitrary.
 */
export async function listFactPage(
  orgId: string,
  conversationId: string
): Promise<{ facts: StoredFact[]; truncated: boolean }> {
  if (!store) return { facts: [], truncated: false };
  // One more than the cap, so exceeding it is observable rather than inferred from a count
  // that happens to equal the limit.
  const snap = await getDocs(
    fsQuery(
      collection(store, factsPath(orgId, conversationId)),
      fsLimit(MAX_FACTS_PER_CONVERSATION + 1)
    )
  );
  const facts: StoredFact[] = [];
  snap.forEach((d: any) => facts.push({ ...(d.data() as StoredFact), id: d.id }));

  const truncated = exceededCap(facts.length);
  if (truncated) {
    console.warn(
      `[factStore] Conversation ${conversationId} has more than ${MAX_FACTS_PER_CONVERSATION} ` +
        'facts. The loaded set is a partial, unordered window: treat "not found" as unknown.'
    );
  }
  return { facts: truncated ? facts.slice(0, MAX_FACTS_PER_CONVERSATION) : facts, truncated };
}

/** The facts currently in force for a conversation. */
export async function listActiveFacts(orgId: string, conversationId: string): Promise<StoredFact[]> {
  return activeFacts(await listFacts(orgId, conversationId));
}

/**
 * Record one observation: create, confirm or supersede. Never delete, never overwrite.
 *
 * The active fact for the key is found by reading the conversation's facts first, because a
 * Firestore transaction cannot run a query. It is then re-read BY REFERENCE inside the
 * transaction and re-checked to be still active — if another writer superseded it in between,
 * this returns CONFLICT rather than closing a fact twice or writing a second active row for
 * the same key.
 */
export async function recordFact(
  orgId: string,
  conversationId: string,
  observation: FactObservation
): Promise<FactWriteOutcome> {
  if (!store) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'Datastore unavailable.' };
  }

  const { facts: existing, truncated } = await listFactPage(orgId, conversationId);
  const current =
    activeFacts(existing).find((f) => f.key === observation.key?.trim?.()) ??
    activeFacts(existing).find((f) => f.key === observation.key) ??
    null;

  // The dangerous conclusion is CREATE-because-nothing-was-found, drawn from a window we know
  // is incomplete: that writes a second active document for a key that already has one, with
  // the first never superseded. Absence of evidence is not evidence of absence when the
  // evidence is known to be partial (§14).
  //
  // Scoped to exactly that case. If a current fact WAS found, superseding it is correct
  // whether or not the window was complete, so a long conversation keeps working.
  if (current === null && truncated) {
    return {
      ok: false,
      code: 'HISTORY_TRUNCATED',
      message:
        `Conversation ${conversationId} holds more than ${MAX_FACTS_PER_CONVERSATION} facts, so ` +
        `no active fact for '${String(observation.key)}' could be ruled out. Refusing to create ` +
        'a second active fact for a key that may already have one.',
    };
  }

  const newId = factId(conversationId, String(observation.key), observation.sourceMessageId, String(observation.value));

  const plan = planFactWrite(current, observation, {
    organizationId: orgId,
    conversationId,
    nextId: newId,
  });

  if (plan.ok === false) {
    return { ok: false, code: plan.rejection.code, message: plan.rejection.message };
  }

  const path = factsPath(orgId, conversationId);

  return await runTransaction(store, async (tx) => {
    if (plan.action === 'CONFIRM') {
      const ref = doc(store, path, plan.factId);
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        return { ok: false as const, code: 'CONFLICT' as const, message: 'The fact was removed while confirming it.' };
      }
      tx.update(ref, plan.patch);
      return { ok: true as const, action: 'CONFIRM' as const, factId: plan.factId };
    }

    const newRef = doc(store, path, newId);

    if (plan.action === 'SUPERSEDE') {
      const oldRef = doc(store, path, plan.supersededId);
      const [oldSnap, newSnap] = await Promise.all([
        tx.get<StoredFact>(oldRef),
        tx.get<StoredFact>(newRef),
      ]);

      if (!oldSnap.exists()) {
        return { ok: false as const, code: 'CONFLICT' as const, message: 'The fact being superseded no longer exists.' };
      }
      const old = oldSnap.data() as StoredFact;
      if (old.validUntil !== null && old.validUntil !== undefined) {
        return {
          ok: false as const,
          code: 'CONFLICT' as const,
          message: 'Another writer superseded this fact first. Re-read and retry.',
        };
      }
      // The same observation arriving twice is a retry, not a second change of mind.
      if (newSnap.exists()) {
        return { ok: true as const, action: 'CONFIRM' as const, factId: newId };
      }

      tx.update(oldRef, plan.supersededPatch);
      tx.set(newRef, { ...plan.insert, id: newId });
      return { ok: true as const, action: 'SUPERSEDE' as const, factId: newId };
    }

    const newSnap = await tx.get(newRef);
    if (newSnap.exists()) {
      return { ok: true as const, action: 'CONFIRM' as const, factId: newId };
    }
    tx.set(newRef, { ...plan.insert, id: newId });
    return { ok: true as const, action: 'CREATE' as const, factId: newId };
  });
}

/**
 * Record several observations, reporting what happened to each.
 *
 * Sequential rather than parallel, deliberately: two observations of the SAME key in one batch
 * must supersede in order, and firing them concurrently would race to close the same fact.
 * A rejection does not stop the batch — one malformed fact from a model should not discard the
 * well-formed ones alongside it.
 */
export async function recordFacts(
  orgId: string,
  conversationId: string,
  observations: readonly FactObservation[]
): Promise<{ recorded: number; rejected: { key: unknown; code: string; message: string }[] }> {
  let recorded = 0;
  const rejected: { key: unknown; code: string; message: string }[] = [];

  for (const observation of observations) {
    const outcome = await recordFact(orgId, conversationId, observation);
    // `outcome.ok === false` rather than an `else` branch: TypeScript does not narrow a
    // discriminated union through the negative arm of a truthiness test here, and the `as any`
    // that would silence it is what hid the ConversationMemory.facts crash for this long.
    if (outcome.ok === false) {
      rejected.push({ key: observation?.key, code: outcome.code, message: outcome.message });
    } else {
      recorded++;
    }
  }

  return { recorded, rejected };
}
