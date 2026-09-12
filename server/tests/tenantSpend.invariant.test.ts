import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orgPath } from '../tenancy/orgScope';
import { memory } from './helpers/memoryDocumentStore';

/**
 * INVARIANTS FOR THE TENANT SPEND LEDGER AND ITS GATE (S37).
 *
 * `BudgetTracker` bounds one reply; nothing bounded a tenant, so a thousand inbound messages
 * were a thousand independently-bounded replies and the sum was nobody's number. The ledger is
 * two running totals per tenant — UTC day and UTC month, USD cents — written in one transaction
 * per run; the gate reads them before the first model call.
 *
 * The gate fails closed twice: when the ledger cannot be read, and while a spend write in this
 * process has failed and not since succeeded. Both are the same rule — a spend that cannot be
 * seen cannot be authorised — applied to the read side and the write side.
 */

vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);

const {
  tenantSpendGate,
  recordTenantSpend,
  tenantSpendView,
  spendKeys,
  _resetLedgerStateForTests,
  ledgerDegradedReason,
} = await import('../services/tenantSpend.service');

const ORG = 'org-a';
const LEDGER = orgPath(ORG, 'modelSpend');
const AT = new Date('2026-09-12T10:00:00Z');
const LIMITS = { dailyCents: 500, monthlyCents: 5000 } as const;

const entry = (id: string) => memory.docs[`${LEDGER}/${id}`];
const run = (costMinor: number, over: Partial<{ costIsUpperBound: boolean; tokens: number; calls: number }> = {}) => ({
  costMinor,
  costIsUpperBound: false,
  tokens: 1_000,
  calls: 2,
  ...over,
});

beforeEach(() => {
  memory.reset();
  _resetLedgerStateForTests();
});

// =============================================================================================
describe('1. the windows', () => {
  it('are UTC day and UTC month, from the instant of the call', () => {
    expect(spendKeys(new Date('2026-09-12T23:59:59Z'))).toEqual({ day: '2026-09-12', month: '2026-09' });
    expect(spendKeys(new Date('2026-09-13T00:00:00Z'))).toEqual({ day: '2026-09-13', month: '2026-09' });
    expect(spendKeys(new Date('2026-10-01T00:00:00Z'))).toEqual({ day: '2026-10-01', month: '2026-10' });
  });
});

// =============================================================================================
describe('2. the ledger', () => {
  it('THE INVARIANT — a run is added to both windows, once, under the tenant', async () => {
    const first = await recordTenantSpend(ORG, run(7), AT);
    expect(first.ok).toBe(true);
    const second = await recordTenantSpend(ORG, run(5, { costIsUpperBound: true, tokens: 300, calls: 1 }), AT);
    expect(second.ok).toBe(true);

    expect(entry('day-2026-09-12')).toMatchObject({
      window: 'DAY',
      key: '2026-09-12',
      costMinor: 12,
      currency: 'USD',
      costIsUpperBound: true,
      tokens: 1_300,
      calls: 3,
      runs: 2,
    });
    expect(entry('month-2026-09')).toMatchObject({ window: 'MONTH', key: '2026-09', costMinor: 12, runs: 2 });
    // Nothing else was written under the tenant, and nothing under any other.
    expect(Object.keys(memory.collection(LEDGER)).sort()).toEqual(['day-2026-09-12', 'month-2026-09']);
    expect(Object.keys(memory.docs).every((k) => k.startsWith(LEDGER + '/'))).toBe(true);
  });

  it('a new day is a new document; the month keeps counting', async () => {
    await recordTenantSpend(ORG, run(7), AT);
    await recordTenantSpend(ORG, run(3), new Date('2026-09-13T01:00:00Z'));
    expect(entry('day-2026-09-12').costMinor).toBe(7);
    expect(entry('day-2026-09-13').costMinor).toBe(3);
    expect(entry('month-2026-09').costMinor).toBe(10);
  });

  it('an upper bound, once recorded, marks the whole window', async () => {
    await recordTenantSpend(ORG, run(1, { costIsUpperBound: true }), AT);
    await recordTenantSpend(ORG, run(1), AT);
    expect(entry('day-2026-09-12').costIsUpperBound).toBe(true);
  });

  it('refuses to file spend under an invalid tenant', async () => {
    const r = await recordTenantSpend('', run(1), AT);
    expect(r.ok).toBe(false);
    expect(Object.keys(memory.docs)).toEqual([]);
  });
});

// =============================================================================================
describe('3. the gate', () => {
  it('allows a tenant under both limits, and reports where it stands', async () => {
    await recordTenantSpend(ORG, run(100), AT);
    const gate = await tenantSpendGate(ORG, AT, LIMITS);
    expect(gate).toEqual({ allowed: true, day: 100, month: 100, limits: LIMITS });
  });

  it('THE INVARIANT — refuses at the daily limit, and says which window and how much', async () => {
    await recordTenantSpend(ORG, run(500), AT);
    const gate = await tenantSpendGate(ORG, AT, LIMITS);
    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.window).toBe('DAY');
    expect(gate.allowed === false && gate.reason).toContain('500¢');
    expect(gate.allowed === false && gate.reason).toContain('2026-09-12');
  });

  it('refuses at the monthly limit even when today is quiet', async () => {
    await recordTenantSpend(ORG, run(5000), new Date('2026-09-01T10:00:00Z'));
    const gate = await tenantSpendGate(ORG, AT, LIMITS);
    expect(gate.allowed === false && gate.window).toBe('MONTH');
  });

  it('a limit of zero means no model spend at all', async () => {
    const gate = await tenantSpendGate(ORG, AT, { dailyCents: 0, monthlyCents: 0 });
    expect(gate.allowed).toBe(false);
  });

  it('a tenant that has never spent is allowed — an absent ledger is zero, not unknown', async () => {
    expect((await tenantSpendGate(ORG, AT, LIMITS)).allowed).toBe(true);
  });

  it('spend under one tenant never counts against another', async () => {
    await recordTenantSpend(ORG, run(500), AT);
    expect((await tenantSpendGate('org-b', AT, LIMITS)).allowed).toBe(true);
  });

  it('refuses an invalid tenant: unattributable spend is unauthorised spend', async () => {
    const gate = await tenantSpendGate('', AT, LIMITS);
    expect(gate.allowed === false && gate.window).toBe('TENANT');
  });
});

// =============================================================================================
describe('4. the gate fails closed', () => {
  it('while a spend write has failed and none has succeeded since', async () => {
    await recordTenantSpend(ORG, run(1), AT);
    expect((await tenantSpendGate(ORG, AT, LIMITS)).allowed).toBe(true);

    // The failure here is the datastore itself, mid-transaction.
    memory.failTransactionsWith = 'connection reset';
    const failed = await recordTenantSpend(ORG, run(1), AT);
    expect(failed.ok).toBe(false);
    expect(ledgerDegradedReason()).toContain('connection reset');

    const gate = await tenantSpendGate(ORG, AT, LIMITS);
    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.window).toBe('DEGRADED');

    // A later successful write clears it: the ledger is trusted again once it is whole.
    memory.failTransactionsWith = null;
    expect((await recordTenantSpend(ORG, run(1), AT)).ok).toBe(true);
    expect(ledgerDegradedReason()).toBeNull();
    expect((await tenantSpendGate(ORG, AT, LIMITS)).allowed).toBe(true);
  });

  it('when the ledger cannot be read', async () => {
    memory.failReadsWith = 'read timed out';
    const gate = await tenantSpendGate(ORG, AT, LIMITS);
    memory.failReadsWith = null;
    expect(gate.allowed === false && gate.window).toBe('UNAVAILABLE');
    expect(gate.allowed === false && gate.reason).toContain('read timed out');
  });
});

// =============================================================================================
describe('5. the operator can see it', () => {
  it('the view carries both windows, the limits, the gate, and the degraded flag', async () => {
    await recordTenantSpend(ORG, run(42), AT);
    const view = await tenantSpendView(ORG, AT);
    expect(view.day?.costMinor).toBe(42);
    expect(view.month?.costMinor).toBe(42);
    expect(view.currency).toBe('USD');
    expect(view.limits.dailyCents).toBeGreaterThanOrEqual(0);
    expect(view.gate.allowed).toBe(true);
    expect(view.ledgerDegraded).toBeNull();
  });
});

// =============================================================================================
describe('6. the pipeline is wired to it, in the right places', () => {
  const strip = (p: string) =>
    readFileSync(p, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*/g, '$1 ');
  const pipeline = strip('server/services/inboundPipeline.ts');

  it('the gate is asked after the store-dependent steps and before the first model call', () => {
    const identity = pipeline.indexOf('identityService.resolve(');
    const gate = pipeline.indexOf('await tenantSpendGate(organizationId)');
    const firstModelCall = pipeline.indexOf('await extractAndSynthesizeMemory(');
    expect(identity).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(identity);
    expect(firstModelCall).toBeGreaterThan(gate);
  });

  it('a refusal is a BUDGET failure carrying the reason, not a silent skip', () => {
    const gate = pipeline.indexOf('await tenantSpendGate(organizationId)');
    const block = pipeline.slice(gate, gate + 700);
    expect(block).toContain("stage: 'BUDGET'");
    expect(block).toContain('detail: spendGate.reason');
  });

  it('every call is priced on the record the provider produced, and the ledger is charged beside the run log', () => {
    expect(pipeline).toContain('const cost = costOfCall(call);');
    expect(pipeline).toContain('budgetTracker.recordModelCall(call.totalTokens, cost.costMinor, cost.upperBound)');
    const log = pipeline.indexOf('await writeRunLog({');
    const ledger = pipeline.indexOf('await recordTenantSpend(organizationId, ledgerChargeFor(spend))');
    expect(log).toBeGreaterThan(-1);
    expect(ledger).toBeGreaterThan(log);
  });

  it('the spend route is mounted and read-only', () => {
    // Raw, not stripped: server.ts contains the string '*/*' (a raw-body content type), whose
    // `/*` the comment stripper reads as opening a block comment and eats to the next `*/` —
    // eighty lines that include the router mounts. A statement cannot hide in a comment here
    // because the line is checked to start with `app.use`.
    const server = readFileSync('server.ts', 'utf8').replace(/\r\n/g, '\n');
    const mount = server.split('\n').find((line) => line.includes('app.use("/api/spend", spendRouter)'));
    expect(mount?.trim().startsWith('app.use(')).toBe(true);
    const route = strip('server/routes/spend.routes.ts');
    expect(route).toContain('spendRouter.get(');
    expect(route).not.toMatch(/spendRouter\.(post|put|patch|delete)\(/);
  });
});
