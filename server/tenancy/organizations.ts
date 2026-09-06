import { collection, getDocs } from 'firebase/firestore';
import { firestore } from '../firebase';
import { isValidOrgId } from './orgScope';

/**
 * P1.1 — Which tenants do background workers serve?
 *
 * `orgScope(req)` answers the question for a request. A worker has no request: nobody
 * authenticated it, and there is no token to read a claim from. Until now that gap was filled
 * by a module-level literal, so the outbox worker served exactly one organisation and would
 * have silently ignored every other tenant's queued mail forever.
 *
 * Two sources, in order:
 *
 *   1. WORKER_ORG_IDS — a comma-separated list. An explicit operator declaration of which
 *      tenants this process serves. This exists so that sharding ("this replica handles these
 *      three tenants") is expressible without a code change, and so that a deployment can be
 *      pinned during an incident.
 *
 *   2. The `organizations` collection in Firestore. Used when no declaration is present.
 *
 * If neither yields anything the answer is an EMPTY LIST, and callers do nothing. That is the
 * fail-closed direction: a worker that cannot establish whose work it is holding should hold
 * it, not pick a tenant. The queue is durable, so nothing is lost while this is unresolved.
 *
 * NOTE ON TRUST: the `organizations` collection is world-writable until firestore.rules is
 * closed (P0.0). A hostile write there can add an organisation id to this list. The blast
 * radius is bounded — the worker would poll an empty queue for a tenant nobody uses — but it
 * is another reason the explicit WORKER_ORG_IDS declaration is preferred in production.
 */

const CACHE_TTL_MS = 60_000;

let cache: { ids: string[]; at: number } | null = null;

function fromEnvironment(): string[] | null {
  const raw = process.env.WORKER_ORG_IDS;
  if (!raw || raw.trim() === '') return null;

  const declared = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const valid = declared.filter(isValidOrgId);
  const rejected = declared.filter((id) => !isValidOrgId(id));

  if (rejected.length > 0) {
    // Loud, because a typo here silently stops serving a real tenant.
    console.error(
      `[tenancy] WORKER_ORG_IDS contains ${rejected.length} invalid organisation id(s): ` +
        `${JSON.stringify(rejected)}. They are ignored.`
    );
  }
  return valid;
}

async function fromDatastore(): Promise<string[]> {
  if (!firestore) return [];
  try {
    const snap = await getDocs(collection(firestore, 'organizations'));
    const ids: string[] = [];
    snap.forEach((d) => {
      if (isValidOrgId(d.id)) ids.push(d.id);
    });
    return ids;
  } catch (e: any) {
    console.error('[tenancy] Could not enumerate organisations:', e?.message);
    return [];
  }
}

/**
 * The tenants this process should do background work for.
 *
 * Cached briefly: the outbox worker asks once every five seconds, and the answer changes when
 * a tenant is created, not between ticks.
 */
export async function listServiceableOrgIds(): Promise<string[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.ids;

  const declared = fromEnvironment();
  const ids = declared !== null ? declared : await fromDatastore();

  if (ids.length === 0) {
    console.warn(
      '[tenancy] No serviceable organisations. Background workers will idle. Set ' +
        'WORKER_ORG_IDS, or create organisation documents in the datastore. Queued work is ' +
        'durable and will be processed once this is resolved.'
    );
  }

  cache = { ids, at: now };
  return ids;
}

/** Tests and operational tooling; the cache is otherwise invisible. */
export function _resetOrganizationCache() {
  cache = null;
}
