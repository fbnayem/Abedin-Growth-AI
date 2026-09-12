import { store, doc, getDoc, runTransaction } from '../store';
import { orgPath, isValidOrgId } from '../tenancy/orgScope';
import { tenantSpendLimits, type TenantSpendLimits } from '../config/environment';

/**
 * S37 — per-tenant model spend: a ledger, and a gate that reads it before the first model call.
 *
 * WHAT WAS MISSING
 * ----------------
 * `BudgetTracker` bounds one reply. Nothing bounded a TENANT: a thousand inbound messages were
 * a thousand independently-bounded replies, and the sum was nobody's number. The addendum's
 * §46 asks for per-tenant, daily and monthly ceilings; the row said so and nothing enforced it.
 *
 * THE LEDGER
 * ----------
 * Two documents per tenant per window, under the tenant's own path so the tenancy rules apply
 * to spend as to everything else: `modelSpend/day-YYYY-MM-DD` and `modelSpend/month-YYYY-MM`,
 * UTC. Each is a running total in USD cents (the provider's currency — see modelPricing.ts),
 * updated in one serializable transaction per run so two concurrent runs cannot both read the
 * old total and both write it plus their own.
 *
 * THE GATE FAILS CLOSED, TWICE
 * ----------------------------
 * The gate refuses when the ledger cannot be read (no store, or a read error): a spend it cannot
 * see is not a spend it may authorise (§14). And it refuses while a spend WRITE has failed and
 * not since succeeded, because a ledger that missed a run is under-counting, and under-counting
 * is the permissive direction. That second refusal is process-local — it says "this process
 * has lost track", which is the truth this process can know.
 *
 * Limits are configuration with deliberately low defaults (environment.ts). Zero is a legal
 * limit and means what it says: no model spend for this deployment.
 */

const COLLECTION = 'modelSpend';

export type SpendWindow = 'DAY' | 'MONTH';

export interface SpendLedgerEntry {
  window: SpendWindow;
  key: string;
  costMinor: number;
  currency: 'USD';
  /** True when any run in the window was priced conservatively; the total is then a ceiling. */
  costIsUpperBound: boolean;
  tokens: number;
  calls: number;
  runs: number;
  updatedAt: string;
}

export interface RunSpend {
  costMinor: number;
  costIsUpperBound: boolean;
  tokens: number;
  calls: number;
}

export type SpendGate =
  | { allowed: true; day: number; month: number; limits: TenantSpendLimits }
  | { allowed: false; window: SpendWindow | 'UNAVAILABLE' | 'DEGRADED' | 'TENANT'; reason: string };

/** UTC window keys for an instant. */
export function spendKeys(at: Date): { day: string; month: string } {
  const iso = at.toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

function emptyEntry(window: SpendWindow, key: string, at: Date): SpendLedgerEntry {
  return {
    window,
    key,
    costMinor: 0,
    currency: 'USD',
    costIsUpperBound: false,
    tokens: 0,
    calls: 0,
    runs: 0,
    updatedAt: at.toISOString(),
  };
}

function entryFrom(data: unknown, window: SpendWindow, key: string, at: Date): SpendLedgerEntry {
  const base = emptyEntry(window, key, at);
  if (data === null || typeof data !== 'object') return base;
  const d = data as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
  return {
    ...base,
    costMinor: int(d.costMinor),
    costIsUpperBound: d.costIsUpperBound === true,
    tokens: int(d.tokens),
    calls: int(d.calls),
    runs: int(d.runs),
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : base.updatedAt,
  };
}

/**
 * Set when a spend write fails; cleared by the next success. While set, the gate refuses.
 * Exported for tests and the spend view only.
 */
let ledgerDegraded: string | null = null;

export function ledgerDegradedReason(): string | null {
  return ledgerDegraded;
}

/** Tests only: a fresh process has no failed write behind it. */
export function _resetLedgerStateForTests(): void {
  ledgerDegraded = null;
}

function refs(organizationId: string, at: Date) {
  const keys = spendKeys(at);
  const path = orgPath(organizationId, COLLECTION);
  return {
    keys,
    day: doc(store, path, `day-${keys.day}`),
    month: doc(store, path, `month-${keys.month}`),
  };
}

/** May this tenant make a model call right now? */
export async function tenantSpendGate(
  organizationId: string,
  at: Date = new Date(),
  limits: TenantSpendLimits = tenantSpendLimits()
): Promise<SpendGate> {
  if (!isValidOrgId(organizationId)) {
    return { allowed: false, window: 'TENANT', reason: 'No valid organisation id; spend cannot be attributed, so none is authorised.' };
  }
  if (!store) {
    return {
      allowed: false,
      window: 'UNAVAILABLE',
      reason: 'The spend ledger is unavailable (no document store). A spend that cannot be read cannot be authorised.',
    };
  }
  if (ledgerDegraded !== null) {
    return {
      allowed: false,
      window: 'DEGRADED',
      reason: `A spend write failed in this process and none has succeeded since (${ledgerDegraded}). The ledger may be under-counting, so no model call is authorised until a write succeeds.`,
    };
  }
  let day: SpendLedgerEntry;
  let month: SpendLedgerEntry;
  try {
    const r = refs(organizationId, at);
    const [d, m] = await Promise.all([getDoc(r.day), getDoc(r.month)]);
    day = entryFrom(d.exists() ? d.data() : null, 'DAY', r.keys.day, at);
    month = entryFrom(m.exists() ? m.data() : null, 'MONTH', r.keys.month, at);
  } catch (e: any) {
    return {
      allowed: false,
      window: 'UNAVAILABLE',
      reason: `The spend ledger could not be read (${e?.message ?? e}). A spend that cannot be read cannot be authorised.`,
    };
  }
  if (day.costMinor >= limits.dailyCents) {
    return {
      allowed: false,
      window: 'DAY',
      reason: `Daily model spend for ${organizationId} is ${day.costMinor}¢ against a limit of ${limits.dailyCents}¢ (UTC day ${day.key}${day.costIsUpperBound ? ', an upper bound' : ''}).`,
    };
  }
  if (month.costMinor >= limits.monthlyCents) {
    return {
      allowed: false,
      window: 'MONTH',
      reason: `Monthly model spend for ${organizationId} is ${month.costMinor}¢ against a limit of ${limits.monthlyCents}¢ (UTC month ${month.key}${month.costIsUpperBound ? ', an upper bound' : ''}).`,
    };
  }
  return { allowed: true, day: day.costMinor, month: month.costMinor, limits };
}

/**
 * Add one run's spend to both windows, atomically. A failure is returned, logged, and remembered:
 * the gate refuses until a later write succeeds.
 */
export async function recordTenantSpend(
  organizationId: string,
  spend: RunSpend,
  at: Date = new Date()
): Promise<{ ok: true; day: SpendLedgerEntry; month: SpendLedgerEntry } | { ok: false; reason: string }> {
  if (!isValidOrgId(organizationId)) {
    return { ok: false, reason: 'No valid organisation id to record spend under.' };
  }
  if (!store) {
    ledgerDegraded = 'no document store';
    return { ok: false, reason: 'The spend ledger is unavailable (no document store); this run\'s spend was NOT recorded.' };
  }
  try {
    const r = refs(organizationId, at);
    const result = await runTransaction(store, async (tx) => {
      const [d, m] = await Promise.all([tx.get(r.day), tx.get(r.month)]);
      const add = (entry: SpendLedgerEntry): SpendLedgerEntry => ({
        ...entry,
        costMinor: entry.costMinor + spend.costMinor,
        costIsUpperBound: entry.costIsUpperBound || spend.costIsUpperBound,
        tokens: entry.tokens + spend.tokens,
        calls: entry.calls + spend.calls,
        runs: entry.runs + 1,
        updatedAt: at.toISOString(),
      });
      const day = add(entryFrom(d.exists() ? d.data() : null, 'DAY', r.keys.day, at));
      const month = add(entryFrom(m.exists() ? m.data() : null, 'MONTH', r.keys.month, at));
      tx.set(r.day, day);
      tx.set(r.month, month);
      return { day, month };
    });
    ledgerDegraded = null;
    return { ok: true, ...result };
  } catch (e: any) {
    const reason = String(e?.message ?? e);
    ledgerDegraded = reason;
    console.error(
      `[TenantSpend] Spend for ${organizationId} was NOT recorded (${reason}). The gate will refuse ` +
        'model calls in this process until a spend write succeeds.'
    );
    return { ok: false, reason: `This run's spend was not recorded: ${reason}` };
  }
}

/** What an operator sees: both windows, the limits, and whether this process has lost track. */
export async function tenantSpendView(organizationId: string, at: Date = new Date()) {
  const limits = tenantSpendLimits();
  const gate = await tenantSpendGate(organizationId, at, limits);
  const r = store && isValidOrgId(organizationId) ? refs(organizationId, at) : null;
  const read = async (ref: any, window: SpendWindow, key: string) => {
    if (!ref) return null;
    const snap = await getDoc(ref);
    return entryFrom(snap.exists() ? snap.data() : null, window, key, at);
  };
  return {
    organizationId,
    currency: 'USD' as const,
    limits,
    day: r ? await read(r.day, 'DAY', r.keys.day) : null,
    month: r ? await read(r.month, 'MONTH', r.keys.month) : null,
    gate,
    ledgerDegraded,
  };
}
