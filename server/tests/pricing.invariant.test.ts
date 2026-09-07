import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PRICE_BOOK,
  PRICE_BOOK_CONFLICTS,
  PricingError,
  STANDARD_TIER,
  addMoney,
  extractMoneyLiterals,
  formatMoney,
  money,
  multiplyMoney,
  priceBookAmounts,
  sameMoney,
} from '../../shared/domain/pricing';
import {
  QUOTE_TRANSITIONS,
  auditPricingClaims,
  pricingContextFor,
  quoteBinding,
  quoteTotal,
  type Quote,
} from '../../shared/domain/quote';

/**
 * INVARIANTS (addendum §25, §1, §24 / P1.7).
 *
 * §25 One price, in one place, read by every surface that states it.
 * §1  A commercial commitment made to a customer is evidenced, not assumed.
 * §24 A negotiated price takes precedence over list pricing — mechanically, not by instruction.
 */

const NOW = '2026-09-06T12:00:00.000Z';

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    id: 'q_1',
    organizationId: 'org1',
    contactId: 'ct_1',
    conversationId: 'conv_1',
    currency: 'GBP',
    lineItems: [
      { tierId: 'standard', description: 'Standard subscription', quantity: 2, unitPrice: money(39_900) },
    ],
    status: 'APPROVED',
    version: 1,
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-12-31T00:00:00.000Z',
    approvedBy: 'nayem@abedin.tech',
    approvedAt: '2026-01-01T00:00:00.000Z',
    supersededBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('§25 — money is an integer amount with a currency, never a float', () => {
  it('REFUSES a fractional minor unit', () => {
    // Pounds as a float is how a total drifts by a penny and a customer is billed wrongly.
    expect(() => money(499.5)).toThrow(PricingError);
    expect(() => money(0.1 + 0.2)).toThrow(PricingError);
  });

  it('adds without drift', () => {
    let total = money(0);
    for (let i = 0; i < 10; i++) total = addMoney(total, money(10));
    expect(total.amountMinor).toBe(100);
    // The float equivalent of this loop does not equal 1.
    expect(formatMoney(total)).toBe('£1');
  });

  it('REFUSES to add different currencies', () => {
    expect(() => addMoney(money(1), { amountMinor: 1, currency: 'USD' as never })).toThrow(PricingError);
  });

  it('REFUSES a fractional or negative quantity', () => {
    expect(() => multiplyMoney(money(100), 1.5)).toThrow(PricingError);
    expect(() => multiplyMoney(money(100), -1)).toThrow(PricingError);
  });

  it('formats one way, everywhere', () => {
    expect(formatMoney(money(49_900))).toBe('£499');
    expect(formatMoney(money(12))).toBe('£0.12');
    expect(formatMoney(money(0))).toBe('£0');
    expect(formatMoney(money(1_800_000))).toBe('£18,000');
    expect(formatMoney(money(49_950))).toBe('£499.50');
  });
});

describe('§25 — the price book is the only place a price is written down', () => {
  it('states the standard tier once', () => {
    expect(STANDARD_TIER.monthly).toEqual({ amountMinor: 49_900, currency: 'GBP' });
    expect(STANDARD_TIER.includedVoiceMinutes).toBe(2_500);
  });

  it('RECORDS the contradictions instead of silently picking a winner', () => {
    // Three sources gave three different answers and one of them was a contract. A module that
    // quietly chose one would look authoritative while hiding that nobody has decided.
    expect(PRICE_BOOK_CONFLICTS.length).toBeGreaterThan(0);
    expect(PRICE_BOOK_CONFLICTS.join(' ')).toContain('£599');
    expect(PRICE_BOOK_CONFLICTS.join(' ')).toContain('£299');
  });

  it('does NOT contain the tiers nobody could evidence', () => {
    const ids = PRICE_BOOK.map((t) => t.id);
    expect(ids).not.toContain('growth');
    expect(ids).not.toContain('starter');
    expect(ids).not.toContain('partner');
    for (const tier of PRICE_BOOK) {
      expect(tier.monthly.amountMinor).not.toBe(59_900);
      expect(tier.monthly.amountMinor).not.toBe(29_900);
      expect(tier.monthly.amountMinor).not.toBe(149_900);
    }
  });

  it('is frozen, so a caller cannot edit the price at runtime', () => {
    expect(Object.isFrozen(PRICE_BOOK)).toBe(true);
    expect(Object.isFrozen(PRICE_BOOK[0])).toBe(true);
  });
});

describe('§25 — every amount in a body can be extracted, so a wrong price is detectable', () => {
  it('finds amounts in prose', () => {
    const found = extractMoneyLiterals('It is £499/mo, or £0.12 per extra minute, saving £18,000.');
    expect(found.map((m) => m.amountMinor)).toEqual([49_900, 12, 1_800_000]);
  });

  it('reads a single decimal digit as tens of pence, not units', () => {
    // '.5' is fifty pence. Reading it as five is the difference between £0.50 and £0.05.
    expect(extractMoneyLiterals('£1.5')[0].amountMinor).toBe(150);
    expect(extractMoneyLiterals('£1.05')[0].amountMinor).toBe(105);
  });

  it('does not confuse a larger number containing the expected one', () => {
    // The old check was `body.includes("£499")`, which "£4,499" satisfies.
    const found = extractMoneyLiterals('The figure was £4,499 last year.');
    expect(found.map((m) => m.amountMinor)).toEqual([449_900]);
    expect(found.some((m) => m.amountMinor === 49_900)).toBe(false);
  });

  it('handles no matches and non-strings', () => {
    expect(extractMoneyLiterals('no prices here')).toEqual([]);
    expect(extractMoneyLiterals(null)).toEqual([]);
    expect(extractMoneyLiterals(42)).toEqual([]);
  });
});

describe('§24 — a binding quote WITHHOLDS list pricing from the prompt', () => {
  it('emits the quote and NOT the price book', () => {
    // The mechanism: a model cannot state a number it was never shown. Putting both in the
    // prompt and instructing precedence is a request, not a control.
    const context = pricingContextFor(quote(), NOW);
    expect(context.listPricingWithheld).toBe(true);
    expect(context.promptBlock).toContain('£399');
    expect(context.promptBlock).not.toContain('£499');
    expect(context.promptBlock).not.toContain('LIST PRICING');
  });

  it('emits list pricing when there is no quote', () => {
    const context = pricingContextFor(null, NOW);
    expect(context.listPricingWithheld).toBe(false);
    expect(context.promptBlock).toContain('LIST PRICING');
    expect(context.promptBlock).toContain('£499');
  });

  it('permits the quote total as well as its line items', () => {
    const context = pricingContextFor(quote(), NOW);
    expect(context.quotableAmounts.some((m) => sameMoney(m, money(39_900)))).toBe(true);
    expect(context.quotableAmounts.some((m) => sameMoney(m, money(79_800)))).toBe(true);
  });

  it('computes the total from line items and quantity', () => {
    expect(quoteTotal(quote())).toEqual({ amountMinor: 79_800, currency: 'GBP' });
  });
});

describe('§1 — a quote that is not evidenced does not bind', () => {
  it('REFUSES an APPROVED quote that names no approver', () => {
    // A record saying APPROVED with nobody accountable is a record of an approval that may
    // never have happened. Unknown is not permission.
    const verdict = quoteBinding(quote({ approvedBy: null }), NOW);
    expect(verdict.binding).toBe(false);
    if (verdict.binding === false) expect(verdict.reason).toContain('names no approver');
  });

  it('REFUSES an EXPIRED quote and falls back to list pricing', () => {
    const expired = quote({ validUntil: '2026-01-02T00:00:00.000Z' });
    expect(quoteBinding(expired, NOW).binding).toBe(false);
    const context = pricingContextFor(expired, NOW);
    expect(context.listPricingWithheld).toBe(false);
    expect(context.promptBlock).toContain('£499');
  });

  it('REFUSES a quote that has not taken effect yet', () => {
    expect(quoteBinding(quote({ validFrom: '2027-01-01T00:00:00.000Z' }), NOW).binding).toBe(false);
  });

  it('REFUSES a WITHDRAWN, DRAFT or PENDING quote', () => {
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'WITHDRAWN', 'EXPIRED', 'SUPERSEDED'] as const) {
      expect(quoteBinding(quote({ status }), NOW).binding, status).toBe(false);
    }
  });

  it('REFUSES a superseded quote', () => {
    expect(quoteBinding(quote({ supersededBy: 'q_2' }), NOW).binding).toBe(false);
  });

  it('treats an absent quote as no quote, not as an error', () => {
    expect(quoteBinding(null, NOW).binding).toBe(false);
    expect(quoteBinding(undefined, NOW).binding).toBe(false);
  });

  it('does NOT let an approved quote return to DRAFT to be edited', () => {
    // The customer is holding the version they were sent.
    expect(QUOTE_TRANSITIONS.APPROVED).not.toContain('DRAFT');
    expect(QUOTE_TRANSITIONS.WITHDRAWN).toEqual([]);
    expect(QUOTE_TRANSITIONS.EXPIRED).toEqual([]);
  });
});

describe('§25 — the auditor detects a price we never agreed to', () => {
  const permitted = priceBookAmounts();

  it('CATCHES a hallucinated price', () => {
    // The old check could only notice the ABSENCE of £499. It had no way to notice the
    // PRESENCE of £299 — which is the failure that reaches a customer.
    const findings = auditPricingClaims('Our price is £299/mo for your clinic.', permitted);
    expect(findings).toHaveLength(1);
    expect(findings[0].stated.amountMinor).toBe(29_900);
  });

  it('CATCHES the stale £599 from the old company-brain document', () => {
    expect(auditPricingClaims('Growth Tier is £599/mo.', permitted)).toHaveLength(1);
  });

  it('CATCHES list pricing quoted over a negotiated rate', () => {
    // The customer was offered £399. Stating £499 is a commercial error even though £499 is a
    // real price — it is not THIS customer's price.
    const context = pricingContextFor(quote(), NOW);
    const findings = auditPricingClaims('The standard rate is £499/mo.', context.quotableAmounts);
    expect(findings).toHaveLength(1);
    expect(findings[0].stated.amountMinor).toBe(49_900);
  });

  it('PASSES a body stating only permitted amounts', () => {
    expect(auditPricingClaims('It is £499 per month, £0.12 per extra minute.', permitted)).toEqual([]);
  });

  it('PASSES a body with no prices at all', () => {
    // The old check penalised this whenever the plan said PROVIDE_PRICING.
    expect(auditPricingClaims('Happy to walk you through it on a call.', permitted)).toEqual([]);
  });

  it('does not report an approved non-price figure', () => {
    // "recovers £18,000 monthly" is money and is not a price. A check that reports it cries
    // wolf, and a check that cries wolf gets switched off.
    const findings = auditPricingClaims(
      'Clinics recover £18,000 monthly. Our price is £499.',
      permitted,
      [money(1_800_000)]
    );
    expect(findings).toEqual([]);
  });

  it('reports each distinct wrong amount once', () => {
    const findings = auditPricingClaims('£299 now, £299 later, and £599 after that.', permitted);
    expect(findings.map((f) => f.stated.amountMinor).sort()).toEqual([29_900, 59_900]);
  });
});

describe('P1.7 — every surface reads the module rather than a literal', () => {
  const read = (p: string) => readFileSync(p, 'utf8');

  it('the auditor no longer substring-matches a price, and reaches the module through one check', () => {
    const source = read('server/agents/independentAuditor.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^\/:])\/\/[^\n]*/g, '$1');
    expect(source).not.toContain('sanitizedBody.includes("£499")');
    expect(source).toContain('pricingContextFor(');

    // S24 — this asserted `auditPricingClaims(` appeared in the auditor. It did, twice: once
    // directly and once through ClaimGroundingEngine.verifyClaims, which is that same
    // function with the same three arguments and nothing else. Measured over 1,350 drafts the
    // two never disagreed, so the auditor was scoring one computation as if it were two
    // independent opinions.
    //
    // The property this test is for is that the check comes from the shared module rather
    // than a literal, so it now follows the single remaining call through the delegation
    // instead of pinning which of the two names appears. Asserting the direct call is ABSENT
    // is what stops the duplicate being reintroduced.
    expect(source).toContain('verifyClaims(');
    expect(source).toContain('pricingContext.quotableAmounts');
    expect(source).not.toContain('auditPricingClaims(');

    const engine = read('server/policies/claimGrounding.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^\/:])\/\/[^\n]*/g, '$1');
    expect(engine).toContain('auditPricingClaims(');
  });

  it('the contract UI renders from the price book', () => {
    const source = read('src/components/LiveMeetingRoomModal.tsx');
    expect(source).toContain('formatMoney(STANDARD_TIER.monthly)');
    // The binding commercial term must not be a typed-in string.
    //
    // Both JSX comments and line comments are stripped: the replacements document the old
    // literals by quoting them, and a check that cannot tell a render site from a description
    // of one is not a check. That distinction has bitten three guardrails in this branch.
    const stripped = source
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(stripped).not.toContain('£499.00 GBP');
    expect(stripped).not.toContain('Growth Tier (£499/mo)');
    // Every price OF OURS in this file — contract terms, payment button, settlement
    // confirmation, the breakdown — renders from the module. This is the surface where a wrong
    // number is a signed commitment.
    //
    // The simulated call transcript is excluded: it quotes a CLINIC's own consultation fee to
    // a patient, which is third-party content and not ours to render from our price book.
    const withoutTranscript = stripped.replace(/text: `[^`]*`/g, '');
    expect(withoutTranscript).not.toMatch(/£\d/);
  });

  it('the composer no longer hardcodes a price in its prompt', () => {
    // Was asserted against multiAgentReplySystem.ts, which held `${pricingBlock}` inside
    // `executeMultiAgentReplyPipeline` — a function nothing called. P1.7's precedence rule was
    // in the repository and absent from every prompt the system actually sent. The live
    // planner now applies it (S21).
    const source = read('server/agents/salesDecisionEngine.ts');
    expect(source).not.toContain('Pricing is £499/mo per clinic');
    expect(source).toContain('${pricingContext.promptBlock}');
    expect(source).toContain('pricingContextFor(input.activeQuote ?? null, nowIso)');
  });

  it('the live prompt does not carry list pricing alongside the decided pricing block', () => {
    // `CANONICAL_KNOWLEDGE` contains list pricing. Emitting it whole would defeat
    // `pricingContextFor` entirely: withholding list pricing means the model cannot see it,
    // not that it is shown twice with one copy deprioritised.
    const source = read('server/agents/salesDecisionEngine.ts');
    expect(source).toContain('const knowledgeWithoutPricing = { ...CANONICAL_KNOWLEDGE, pricing: undefined }');
    expect(source).toContain('${JSON.stringify(knowledgeWithoutPricing)}');
    expect(source).not.toContain('${JSON.stringify(CANONICAL_KNOWLEDGE)}');
  });

  it('the removed composer is gone rather than merely unused', () => {
    const source = read('server/agents/multiAgentReplySystem.ts');
    expect(source).not.toContain('monthlyFee: conversation.category === "PARTNER" ? 1499 : 499');
    expect(source).not.toContain('export async function executeMultiAgentReplyPipeline');
  });

  it('canonical knowledge is generated, not written beside the price book', () => {
    const source = read('server/agents/salesDecisionEngine.ts');
    expect(source).not.toContain('standardPackage: "£499 / month per clinic location"');
    expect(source).toContain('formatMoney(STANDARD_TIER.monthly)');
  });

  it('the company-brain knowledge item renders from the price book', () => {
    const source = read('server/dataStore.ts');
    expect(source).toContain('content: describePriceBook()');
    const stripped = source.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(stripped).not.toContain('Growth Tier: £599/mo');
    expect(stripped).not.toContain('Starter Tier: £299/mo');
  });
});
