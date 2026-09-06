import { createHash } from 'node:crypto';
import {
  collection,
  doc,
  getDocs,
  query as fsQuery,
  limit as fsLimit,
  runTransaction,
} from 'firebase/firestore';
import { firestore } from '../firebase';
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

/** A conversation's fact history is bounded; beyond this the oldest are not loaded. */
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
  | { ok: false; code: 'CONFLICT'; message: string };

/**
 * Read every fact for a conversation, history included.
 *
 * Callers that want only what is currently true use `activeFacts()` on the result. The default
 * is the full history because that is what a fact store is FOR — the previous implementation's
 * defining mistake was treating the current value as the only thing worth keeping.
 */
export async function listFacts(orgId: string, conversationId: string): Promise<StoredFact[]> {
  if (!firestore) return [];
  const snap = await getDocs(
    fsQuery(collection(firestore, factsPath(orgId, conversationId)), fsLimit(MAX_FACTS_PER_CONVERSATION))
  );
  const facts: StoredFact[] = [];
  snap.forEach((d: any) => facts.push({ ...(d.data() as StoredFact), id: d.id }));
  return facts;
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
  if (!firestore) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'Datastore unavailable.' };
  }

  const existing = await listFacts(orgId, conversationId);
  const current =
    activeFacts(existing).find((f) => f.key === observation.key?.trim?.()) ??
    activeFacts(existing).find((f) => f.key === observation.key) ??
    null;

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

  return await runTransaction(firestore, async (tx) => {
    if (plan.action === 'CONFIRM') {
      const ref = doc(firestore, path, plan.factId);
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        return { ok: false as const, code: 'CONFLICT' as const, message: 'The fact was removed while confirming it.' };
      }
      tx.update(ref, plan.patch);
      return { ok: true as const, action: 'CONFIRM' as const, factId: plan.factId };
    }

    const newRef = doc(firestore, path, newId);

    if (plan.action === 'SUPERSEDE') {
      const oldRef = doc(firestore, path, plan.supersededId);
      const [oldSnap, newSnap] = await Promise.all([tx.get(oldRef), tx.get(newRef)]);

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
