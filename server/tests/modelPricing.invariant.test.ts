import { describe, it, expect } from 'vitest';
import {
  MODEL_PRICES,
  PRICING_SOURCE,
  billableTokens,
  costOfCall,
  priceFor,
  ratesFor,
  type CallUsage,
} from '../policies/modelPricing';

/**
 * INVARIANTS FOR THE PRICE TABLE (S37).
 *
 * The figures are the provider's and will change; nothing here asserts a dollar amount is
 * "right". What is pinned is what the table promises: that it is dated and sourced, that every
 * arithmetic path rounds in the direction a budget can survive, that an unknown is never a
 * zero, and that a model the table does not know is charged at the dearest rate it does.
 */

const usage = (over: Partial<CallUsage> = {}): CallUsage => ({
  model: 'gemini-3.1-pro-preview',
  promptTokens: 1_000,
  outputTokens: 500,
  thoughtsTokens: 200,
  totalTokens: 1_700,
  ...over,
});

const T = new Date('2026-09-12T12:00:00Z');

// =============================================================================================
describe('1. the table is sourced, dated, and shaped for every failover candidate', () => {
  it('names its source and both dates', () => {
    expect(PRICING_SOURCE.url).toMatch(/^https:\/\/ai\.google\.dev\//);
    expect(PRICING_SOURCE.pageDated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRICING_SOURCE.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRICING_SOURCE.readOn >= PRICING_SOURCE.pageDated).toBe(true);
    expect(PRICING_SOURCE.currency).toBe('USD');
  });

  it('every row is whole cents per million, positive, with a coherent long-context tier', () => {
    for (const p of MODEL_PRICES) {
      expect(Number.isInteger(p.inputCentsPerMillion) && p.inputCentsPerMillion > 0, p.model).toBe(true);
      expect(Number.isInteger(p.outputCentsPerMillion) && p.outputCentsPerMillion > 0, p.model).toBe(true);
      if (p.longContextAbove !== null) {
        expect(p.longContextInputCentsPerMillion, p.model).not.toBeNull();
        expect(p.longContextOutputCentsPerMillion, p.model).not.toBeNull();
        // Long context is never cheaper: a tier that lowered the price would be a discount
        // the provider does not offer, and a budget that believed it would under-count.
        expect(p.longContextInputCentsPerMillion!, p.model).toBeGreaterThanOrEqual(p.inputCentsPerMillion);
        expect(p.longContextOutputCentsPerMillion!, p.model).toBeGreaterThanOrEqual(p.outputCentsPerMillion);
      }
      if (p.changesOn !== null) {
        expect(p.changesOn.date, p.model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('the models the client fails over between are either listed or fall to the dearest rate', () => {
    // These four are the client's candidate list. Three are on the page; the alias is not.
    const candidates = ['gemini-3.1-pro-preview', 'gemini-3.7-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
    const listed = candidates.filter((m) => priceFor(m).listed);
    expect(listed).toEqual(['gemini-3.1-pro-preview', 'gemini-3.7-flash', 'gemini-3.1-flash-lite']);
    const alias = priceFor('gemini-flash-latest');
    expect(alias.listed).toBe(false);
    expect(alias.price.outputCentsPerMillion).toBe(Math.max(...MODEL_PRICES.map((p) => p.outputCentsPerMillion)));
  });
});

// =============================================================================================
describe('2. billable tokens: thinking is output, and a missing breakdown is not a zero', () => {
  it('output includes thoughts when both are reported', () => {
    expect(billableTokens(usage())).toEqual({ input: 1_000, output: 700, outputInferred: false });
  });

  it('with thoughts unreported and a total known, output is total minus prompt — which includes them', () => {
    const t = billableTokens(usage({ thoughtsTokens: null, totalTokens: 1_700 }));
    expect(t).toEqual({ input: 1_000, output: 700, outputInferred: true });
  });

  it('with only candidates reported, output is candidates and nothing is inferred', () => {
    expect(billableTokens(usage({ thoughtsTokens: null, totalTokens: null }))).toEqual({
      input: 1_000,
      output: 500,
      outputInferred: false,
    });
  });

  it('with no output and no total, output is unknown — not zero', () => {
    expect(billableTokens(usage({ outputTokens: null, thoughtsTokens: null, totalTokens: null })).output).toBeNull();
  });
});

// =============================================================================================
describe('3. rates: the tier comes from the call, not from a flag', () => {
  const pro = priceFor('gemini-3.1-pro-preview').price;
  const flash = priceFor('gemini-3.7-flash').price;

  it('a prompt within the long-context threshold pays standard rates', () => {
    expect(ratesFor(pro, 200_000, T)).toMatchObject({ inputCentsPerMillion: 200, tier: 'standard' });
  });

  it('a prompt above it pays the long-context rates', () => {
    expect(ratesFor(pro, 200_001, T)).toMatchObject({ inputCentsPerMillion: 400, outputCentsPerMillion: 1800 });
  });

  it('an announced change applies from its date, by the call’s own clock', () => {
    expect(ratesFor(flash, 1_000, new Date('2026-12-31T23:59:59Z')).inputCentsPerMillion).toBe(75);
    expect(ratesFor(flash, 1_000, new Date('2027-01-01T00:00:00Z')).inputCentsPerMillion).toBe(150);
  });
});

// =============================================================================================
describe('4. cost of a call: integer cents, rounded up, honest about what it is', () => {
  it('THE INVARIANT — the arithmetic, on the pro model', () => {
    // 1,000 input × 200¢/M = 0.2¢; 700 output × 1,200¢/M = 0.84¢; 1.04¢ → 2¢.
    expect(costOfCall(usage(), T)).toMatchObject({ costMinor: 2, currency: 'USD', upperBound: false });
  });

  it('a tiny call is still one cent, never zero', () => {
    expect(costOfCall(usage({ promptTokens: 1, outputTokens: 1, thoughtsTokens: 0, totalTokens: 2 }), T).costMinor).toBe(1);
  });

  it('a large call is exact when it divides evenly', () => {
    // 1,000,000 input × 200¢/M = 200¢; 1,000,000 output × 1,200¢/M = 1,200¢.
    const c = costOfCall(
      usage({ promptTokens: 1_000_000, outputTokens: 1_000_000, thoughtsTokens: 0, totalTokens: 2_000_000 }),
      T
    );
    // Above the 200k threshold, so long-context rates: 400¢ + 1,800¢.
    expect(c.costMinor).toBe(2_200);
    expect(c.basis).toContain('long-context');
  });

  it('an unlisted model is an upper bound at the dearest rate, and says so', () => {
    const c = costOfCall(usage({ model: 'gemini-flash-latest' }), T);
    expect(c.upperBound).toBe(true);
    expect(c.basis).toContain('not listed');
    expect(c.costMinor).toBe(costOfCall(usage({ model: 'gemini-3.1-pro-preview' }), T).costMinor);
  });

  it('a model of null (a total failover) is priced as unlisted, not as free', () => {
    const c = costOfCall(usage({ model: null }), T);
    expect(c.upperBound).toBe(true);
    expect(c.costMinor).toBeGreaterThan(0);
  });

  it('output inferred from a total is marked an upper bound', () => {
    expect(costOfCall(usage({ thoughtsTokens: null }), T).upperBound).toBe(true);
  });

  it('a call the provider did not report enough about is unpriced: null, not zero', () => {
    const c = costOfCall(usage({ promptTokens: null }), T);
    expect(c.costMinor).toBeNull();
    expect(c.basis).toContain('unpriced');
  });

  it('the cheapest listed model is cheaper than the dearest for the same call', () => {
    const lite = costOfCall(usage({ model: 'gemini-3.1-flash-lite', promptTokens: 100_000, outputTokens: 50_000, thoughtsTokens: 0, totalTokens: 150_000 }), T);
    const pro = costOfCall(usage({ model: 'gemini-3.1-pro-preview', promptTokens: 100_000, outputTokens: 50_000, thoughtsTokens: 0, totalTokens: 150_000 }), T);
    expect(lite.costMinor!).toBeLessThan(pro.costMinor!);
  });
});
