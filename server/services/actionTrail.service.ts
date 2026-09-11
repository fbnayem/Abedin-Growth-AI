import { store, collection, getDocs, query, where } from '../store';
import { orgPath } from '../tenancy/orgScope';

/**
 * S10 — READING THE TRAIL THE GATEWAY WRITES.
 *
 * The audit log had exactly one writer and NO reader, anywhere in the repository — a fact
 * `docs/production/active-code-graph.md` already recorded and nothing acted on. A record nobody can
 * read is not an audit trail; it is a write that makes people feel audited. The first question
 * anyone actually asks of it — "what happened to this action, in what order?" — had no answer,
 * because every status was merged onto one document and only the last one survived.
 *
 * Events are ordered HERE rather than by the datastore. `orderBy('seq')` would compare
 * `data->>'seq'` as text, where "10" sorts before "2" — an ordering bug that would only appear on
 * the tenth event of an action, which is exactly the kind nobody sees in testing.
 */

export interface ActionTrailEvent {
  readonly seq: number;
  readonly status: string;
  readonly [field: string]: unknown;
}

export type ActionTrailResult =
  | { readonly ok: true; readonly events: ActionTrailEvent[] }
  | {
      readonly ok: false;
      readonly code: 'VALIDATION_ERROR' | 'STORE_UNAVAILABLE';
      readonly reason: string;
    };

/** Ids are minted as `action_<millis>_<base36>`; nothing else is a shape we wrote. */
const ACTION_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export async function readActionTrail(
  organizationId: string,
  actionId: unknown
): Promise<ActionTrailResult> {
  if (typeof actionId !== 'string' || !ACTION_ID.test(actionId)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      reason: 'That is not a usable action id.',
    };
  }

  if (!store) {
    return {
      ok: false,
      code: 'STORE_UNAVAILABLE',
      // An empty trail and an unreadable one are different facts, and answering `[]` for both is
      // how an operator concludes that nothing happened (§14).
      reason: 'The datastore is not available, so no trail can be read. This is not an empty trail.',
    };
  }

  try {
    const snapshot = await getDocs(
      query(collection(store, orgPath(organizationId, 'actionLogs')), where('actionId', '==', actionId))
    );

    const events: ActionTrailEvent[] = [];
    snapshot.forEach((document) => {
      const data = document.data() as Record<string, unknown>;
      const seq = typeof data.seq === 'number' && Number.isFinite(data.seq) ? data.seq : -1;
      const status = typeof data.status === 'string' ? data.status : 'UNKNOWN';
      events.push({ ...data, seq, status });
    });

    events.sort((a, b) => a.seq - b.seq);
    return { ok: true, events };
  } catch (e: any) {
    return {
      ok: false,
      code: 'STORE_UNAVAILABLE',
      reason: `The trail could not be read: ${e?.message ?? 'unknown error'}`,
    };
  }
}
