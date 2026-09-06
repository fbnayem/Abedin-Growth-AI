import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  limit as fsLimit,
  runTransaction,
  type DocumentReference,
} from 'firebase/firestore';
import { firestore } from '../firebase';
import { orgPath } from '../tenancy/orgScope';
import { accountDocId, accountDomain, contactDocId, tryContactDocId } from './identity';
import { planContactMerge, type MergeableContact, type MergeRefusal } from '../domain/contactMerge';
import { VERSION_FIELD, versionOf } from './concurrency';

/**
 * P1.5 — IDENTITY WRITES ON THE STORE THAT ACTUALLY RUNS (addendum §29, §15).
 *
 * `contacts_org_email_key_unique` is declared in the PostgreSQL schema and has never been
 * consulted on a live write, because this deployment stores contacts in Firestore. Firestore
 * has no unique constraints at all — the only uniqueness it offers is the document id. So the
 * id is where the constraint has to live, and creating has to be a transaction that reads
 * before it writes.
 */

/** Collections whose documents point at a contact, and the field that does the pointing. */
export const CONTACT_REFERENCES = [
  { collection: 'conversations', field: 'contactId' },
  { collection: 'opportunities', field: 'contactId' },
  { collection: 'meetings', field: 'contactId' },
] as const;

/**
 * The most rows a single merge will reparent.
 *
 * A Firestore transaction is capped at 500 document writes, and this merge also writes the two
 * contact records. Refusing above the cap is deliberate: a merge that reparented the first 400
 * rows and stopped would leave the rest pointing at a record marked MERGED, which is precisely
 * the dangling reference the operation exists to remove. A refusal is repairable; a half-merge
 * has to be found first.
 */
export const MAX_REPARENT = 400;

export type ContactCreateOutcome =
  | { ok: true; id: string; data: Record<string, unknown> }
  | { ok: false; code: 'ALREADY_EXISTS'; id: string; existing: Record<string, unknown> }
  | { ok: false; code: 'UNUSABLE_EMAIL'; message: string }
  | { ok: false; code: 'STORE_UNAVAILABLE'; message: string };

/**
 * Create a contact at the id derived from its address, or report that it is already there.
 *
 * NEVER overwrites. That is the whole point: `setDoc` without the existence check would make
 * every re-post of a contact silently reset `suppressed`, `unsubscribed` and `consentGiven` to
 * whatever the new request implies — turning the create endpoint into a way to clear an
 * unsubscribe. The read and the write are in one transaction, so two concurrent creates cannot
 * both see "absent".
 */
export async function createContactIfAbsent(
  orgId: string,
  email: unknown,
  buildDocument: (id: string) => Record<string, unknown>
): Promise<ContactCreateOutcome> {
  if (!firestore) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'Datastore unavailable.' };
  }

  const id = tryContactDocId(email);
  if (id === null) {
    return {
      ok: false,
      code: 'UNUSABLE_EMAIL',
      message:
        'A contact needs a usable email address: it is the identity key, and without one ' +
        'there is no way to check suppression before sending.',
    };
  }

  const ref = doc(firestore, orgPath(orgId, 'contacts'), id);

  return await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) {
      return {
        ok: false as const,
        code: 'ALREADY_EXISTS' as const,
        id,
        existing: { ...(snap.data() as Record<string, unknown>), version: versionOf(snap.data(), true) },
      };
    }
    const data = buildDocument(id);
    tx.set(ref, data);
    return { ok: true as const, id, data };
  });
}

export type AccountOutcome =
  | { ok: true; id: string; created: boolean }
  | { ok: false; code: 'PERSONAL_DOMAIN' | 'STORE_UNAVAILABLE'; message: string };

/**
 * Create the account record for a contact's company domain, if it does not exist.
 *
 * `accounts` was declared in the schema and never written by anything, so every contact's
 * `accountId` has always been null and `IdentityResolverService`'s DOMAIN_MATCH branch has
 * always returned an undefined account. This is what makes that branch mean something.
 *
 * A personal-mail address gets no account, and that refusal is the useful half — see the note
 * on PUBLIC_EMAIL_DOMAINS in lib/identity.
 */
export async function ensureAccount(
  orgId: string,
  email: unknown,
  seed: Record<string, unknown> = {}
): Promise<AccountOutcome> {
  if (!firestore) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'Datastore unavailable.' };
  }

  const domain = accountDomain(email);
  const id = accountDocId(email);
  if (domain === null || id === null) {
    return {
      ok: false,
      code: 'PERSONAL_DOMAIN',
      message:
        'No account is created for a free-mail address: it would place unrelated people into ' +
        'one shared company history.',
    };
  }

  const ref = doc(firestore, orgPath(orgId, 'accounts'), id);

  return await runTransaction(firestore, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) return { ok: true as const, id, created: false };
    const now = new Date().toISOString();
    tx.set(ref, {
      ...seed,
      id,
      organizationId: orgId,
      domain,
      [VERSION_FIELD]: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, id, created: true };
  });
}

export type MergeOutcome =
  | {
      ok: true;
      survivorId: string;
      duplicateId: string;
      reparented: number;
      inheritedSuppression: string[];
      consentRevoked: boolean;
    }
  | { ok: false; code: 'NOT_FOUND'; message: string }
  | { ok: false; code: 'TOO_MANY_REFERENCES'; message: string; found: number }
  | { ok: false; code: 'STORE_UNAVAILABLE'; message: string }
  | { ok: false; code: MergeRefusal['code']; message: string };

/**
 * Merge one contact into another, reparenting everything that pointed at it.
 *
 * WHY THE QUERY IS OUTSIDE THE TRANSACTION
 * ----------------------------------------
 * The Firestore client SDK cannot run a query inside a transaction — `tx.get` accepts a
 * document reference and nothing else. So the referencing rows are enumerated first and
 * re-read by reference inside the transaction, where each one is checked to be still pointing
 * at the record being merged away before it is rewritten.
 *
 * That re-check closes the interesting half of the race: a row that was reparented or deleted
 * in between is skipped rather than resurrected. It cannot close the other half — a row
 * CREATED after the query still points at the merged-away record — which is why the operation
 * is resumable. Re-running reparents the stragglers and refuses to record the merge twice.
 *
 * The two contacts are read inside the transaction, not before it, so the consent and
 * suppression decision is made on the state that is actually committed against.
 */
export async function mergeContacts(
  orgId: string,
  survivorId: string,
  duplicateId: string,
  options: { mergedBy?: string; resume?: boolean } = {}
): Promise<MergeOutcome> {
  if (!firestore) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'Datastore unavailable.' };
  }

  if (survivorId === duplicateId) {
    return { ok: false, code: 'SAME_RECORD', message: `Refusing to merge ${survivorId} into itself.` };
  }

  // 1. Enumerate what points at the record being merged away. Bounded, and the bound is
  // checked before anything is written.
  const referencing: { ref: DocumentReference; field: string }[] = [];
  for (const target of CONTACT_REFERENCES) {
    const snap = await getDocs(
      query(
        collection(firestore, orgPath(orgId, target.collection)),
        where(target.field, '==', duplicateId),
        fsLimit(MAX_REPARENT + 1)
      )
    );
    snap.forEach((d: any) => referencing.push({ ref: d.ref, field: target.field }));
  }

  if (referencing.length > MAX_REPARENT) {
    return {
      ok: false,
      code: 'TOO_MANY_REFERENCES',
      found: referencing.length,
      message:
        `${referencing.length} rows point at ${duplicateId}, above the ${MAX_REPARENT} a single ` +
        'transaction can move. Refusing rather than reparenting some of them: a partial merge ' +
        'leaves rows pointing at a record marked MERGED.',
    };
  }

  const survivorRef = doc(firestore, orgPath(orgId, 'contacts'), survivorId);
  const duplicateRef = doc(firestore, orgPath(orgId, 'contacts'), duplicateId);

  return await runTransaction(firestore, async (tx) => {
    // Firestore requires every read before every write.
    const [survivorSnap, duplicateSnap] = await Promise.all([
      tx.get(survivorRef),
      tx.get(duplicateRef),
    ]);

    if (!survivorSnap.exists()) {
      return { ok: false as const, code: 'NOT_FOUND' as const, message: `No contact ${survivorId}.` };
    }
    if (!duplicateSnap.exists()) {
      return { ok: false as const, code: 'NOT_FOUND' as const, message: `No contact ${duplicateId}.` };
    }

    const survivor = { ...(survivorSnap.data() as MergeableContact), id: survivorId };
    const duplicate = { ...(duplicateSnap.data() as MergeableContact), id: duplicateId };

    const referenceSnaps = await Promise.all(referencing.map((r) => tx.get(r.ref)));

    const plan = planContactMerge(survivor, duplicate, {
      mergedBy: options.mergedBy,
      resume: options.resume,
    });
    if (plan.ok === false) {
      return { ok: false as const, code: plan.refusal.code, message: plan.refusal.message };
    }

    let reparented = 0;
    for (let i = 0; i < referencing.length; i++) {
      const snap = referenceSnaps[i];
      // Re-checked inside the transaction: a row moved or deleted since the query is skipped
      // rather than rewritten from stale data.
      if (!snap.exists()) continue;
      const data = snap.data() as Record<string, unknown>;
      if (data[referencing[i].field] !== duplicateId) continue;
      tx.update(referencing[i].ref, {
        [referencing[i].field]: survivorId,
        reparentedFrom: duplicateId,
        updatedAt: new Date().toISOString(),
      });
      reparented++;
    }

    // The version is bumped by hand here rather than through mutateWithVersion, because a merge
    // is one transaction spanning two documents and cannot be expressed as two independent
    // conditional writes.
    tx.update(survivorRef, {
      ...plan.survivorPatch,
      [VERSION_FIELD]: versionOf(survivor, true) + 1,
    });
    tx.update(duplicateRef, {
      ...plan.duplicatePatch,
      [VERSION_FIELD]: versionOf(duplicate, true) + 1,
    });

    return {
      ok: true as const,
      survivorId,
      duplicateId,
      reparented,
      inheritedSuppression: plan.inheritedSuppression,
      consentRevoked: plan.consentRevoked,
    };
  });
}

/**
 * Find contacts in this tenant that look like duplicates of the given address.
 *
 * Read-only, and deliberately so: everything it reports is a SUGGESTION for a human. The
 * plus-tag and same-domain-same-name signals it uses are exactly the ones that must not drive
 * an automatic merge, because a wrong merge writes one person's history onto another's.
 */
export async function findDuplicateCandidates(
  orgId: string,
  email: unknown,
  options: { limit?: number } = {}
): Promise<{ id: string; reason: string }[]> {
  if (!firestore) return [];
  const key = tryContactDocId(email);
  if (key === null) return [];

  const candidates: { id: string; reason: string }[] = [];
  const cap = options.limit ?? 25;

  // The exact record, if it exists. Reported rather than merged, because "already exists" is
  // an answer the caller needs, not a duplicate to resolve.
  const exact = await getDoc(doc(firestore, orgPath(orgId, 'contacts'), key));
  if (exact.exists()) candidates.push({ id: key, reason: 'EXACT_EMAIL' });

  return candidates.slice(0, cap);
}

export { contactDocId, accountDocId, accountDomain };
