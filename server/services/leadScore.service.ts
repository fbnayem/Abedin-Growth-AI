import { collection, doc, getDoc, getDocs, runTransaction, store } from '../store';
import { orgPath } from '../tenancy/orgScope';
import {
  RUBRIC_VERSION,
  scoreLead,
  type IcpDefinition,
  type LeadScore,
  type ScorableContact,
} from '../domain/leadScore';
import type { Attribution } from '../domain/operatorAction';

/**
 * SCORING A CONTACT, AND STORING WHAT WAS SCORED (§8, §26).
 *
 * The decision is in `server/domain/leadScore.ts` and is pure. This file supplies its two
 * inputs from the store and writes the result back.
 *
 * WHY A STORED SCORE CARRIES ITS RUBRIC VERSION AND ITS CONFIDENCE
 * ---------------------------------------------------------------
 * A number in a list view outlives the reasoning that produced it. `aiScore: 87` on a record
 * scored eight months ago under a different rubric, against a company brain that has since been
 * rewritten, is not a fact about the lead — it is a fossil. So every stored score carries the
 * rubric version, the timestamp, the operator who ran it, and the confidence, and the console
 * is expected to show a score as stale when the rubric has moved on.
 *
 * WHY `aiScore` AND `scoreConfidence` ARE WRITTEN TOGETHER OR NOT AT ALL
 * ---------------------------------------------------------------------
 * `aiScore` is the percentage of the ASSESSABLE points a contact earned, which is not the same
 * as a mark out of 100 and renders identically to one. A record scored 90 on the ten points of
 * contactability alone looks, in a list view, exactly like a record that was researched
 * thoroughly and came out at 90. `scoreConfidence` is what tells them apart, so the patch
 * writes both and the console shows both.
 */

export interface ScoreOutcome {
  readonly contactId: string;
  readonly scored: boolean;
  readonly score: number | null;
  /** Null only where the contact did not exist; a scored contact always has both numbers. */
  readonly confidence: number;
  readonly reason: string;
}

/** The ideal customer profile, from the company brain. Absent brain means an empty profile. */
export async function readIcp(orgId: string): Promise<IcpDefinition> {
  if (!store) return {};
  const snap = await getDoc(doc(store, orgPath(orgId, 'company_brain'), 'main'));
  if (!snap.exists()) return {};
  const brain = snap.data() as Record<string, unknown>;
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return {
    targetIndustries: list(brain.targetIndustries),
    targetCountries: list(brain.targetCountries),
    targetPersonas: Array.isArray(brain.targetPersonas)
      ? (brain.targetPersonas as { title?: unknown; department?: unknown; painPoint?: unknown }[])
          .filter((p) => p !== null && typeof p === 'object')
          .map((p) => ({
            title: typeof p.title === 'string' ? p.title : undefined,
            department: typeof p.department === 'string' ? p.department : undefined,
            painPoint: typeof p.painPoint === 'string' ? p.painPoint : undefined,
          }))
      : [],
  };
}

/** What gets written onto a contact when a score is stored. Built field by field. */
export function scorePatch(result: LeadScore, actor: string, iso: string): Record<string, unknown> {
  return {
    // Written with its confidence, always. See the note at the top of this file.
    aiScore: result.score,
    scoreConfidence: result.confidence,
    scoreRubricVersion: result.rubricVersion,
    scoredAt: iso,
    scoredBy: actor,
    scoreBreakdown: {
      components: result.components.map((c) => ({ key: c.key, max: c.max, score: c.score, why: c.why })),
      earned: result.earned,
      assessable: result.assessable,
      notScored: result.notScored,
      signals: result.signals,
      risks: result.risks,
    },
  };
}

/**
 * Score one contact without storing anything.
 *
 * The read-only half, so an operator can ask "what would this score?" without changing a
 * record. The console uses it on a lead detail; the batch below uses the same computation.
 */
export async function previewScore(
  orgId: string,
  contactId: string
): Promise<{ ok: true; contactId: string; result: LeadScore } | { ok: false; code: 'NOT_FOUND' | 'STORE_UNAVAILABLE'; message: string }> {
  if (!store) return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  const snap = await getDoc(doc(store, orgPath(orgId, 'contacts'), contactId));
  if (!snap.exists()) {
    return { ok: false, code: 'NOT_FOUND', message: `No contact ${contactId} in this organisation.` };
  }
  const icp = await readIcp(orgId);
  return { ok: true, contactId, result: scoreLead(snap.data() as ScorableContact, icp) };
}

/**
 * Score contacts and store the result.
 *
 * Requires an identified actor. A score drives which people get contacted first, so who ran it
 * and when is part of the record — the same rule the lawful basis and quote approval use.
 *
 * `contactIds` empty means "every contact in this organisation", which is the normal case after
 * an import. It is bounded by `limit` and reports how many it did not reach, rather than
 * appearing to have scored everything.
 */
export async function scoreContacts(
  orgId: string,
  contactIds: readonly string[],
  by: Attribution,
  options: { limit?: number; now?: Date } = {}
): Promise<
  | { ok: true; rubricVersion: string; scored: number; unreachable: number; outcomes: ScoreOutcome[] }
  | { ok: false; code: 'ATTRIBUTION_REQUIRED' | 'STORE_UNAVAILABLE'; message: string }
> {
  if (!store) return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  if (by.kind !== 'IDENTIFIED') {
    return {
      ok: false,
      code: 'ATTRIBUTION_REQUIRED',
      message:
        `Scoring needs an identified operator: ${by.why}. A score decides who is contacted ` +
        `first, so who ran it is part of the record.`,
    };
  }
  const actor = by.actor;
  const iso = (options.now ?? new Date()).toISOString();
  const limit = options.limit ?? 500;
  const icp = await readIcp(orgId);

  let ids: string[];
  if (contactIds.length > 0) {
    ids = [...contactIds];
  } else {
    const snap = await getDocs(collection(store, orgPath(orgId, 'contacts')));
    ids = [];
    snap.forEach((d: any) => ids.push(d.id ?? (d.data() as Record<string, unknown>).id));
    ids = ids.filter((id): id is string => typeof id === 'string');
  }

  const unreachable = Math.max(0, ids.length - limit);
  const outcomes: ScoreOutcome[] = [];
  let scored = 0;

  for (const contactId of ids.slice(0, limit)) {
    const ref = doc(store, orgPath(orgId, 'contacts'), contactId);
    const outcome = await runTransaction(store, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        return { scored: false, score: null, confidence: 0, reason: `No contact ${contactId}.` };
      }
      const current = snap.data() as Record<string, unknown>;
      const result = scoreLead(current as ScorableContact, icp);
      tx.set(ref, {
        ...current,
        ...scorePatch(result, actor, iso),
        version: (typeof current.version === 'number' ? current.version : 0) + 1,
        updatedAt: iso,
      });
      return {
        scored: true,
        score: result.score,
        confidence: result.confidence,
        reason:
          `${result.score} on ${result.assessable} of 100 assessable points` +
          (result.notScored.length > 0 ? `; not scored: ${result.notScored.join(', ')}.` : '.'),
      };
    });
    if (outcome.scored) scored++;
    outcomes.push({ contactId, ...outcome });
  }

  return { ok: true, rubricVersion: RUBRIC_VERSION, scored, unreachable, outcomes };
}
