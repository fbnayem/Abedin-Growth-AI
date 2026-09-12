import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { memory } from './helpers/memoryDocumentStore';
import {
  createQuote,
  submitQuote,
  approveQuote,
  withdrawQuote,
  quotesForEmail,
  activeQuoteFor,
  lookupQuotesForReply,
  priceLine,
  priceBookVersion,
  getQuote,
} from '../services/quote.service';
import { PRICE_BOOK } from '../../shared/domain/pricing';
import { quoteBinding, pricingContextFor, QUOTE_TRANSITIONS } from '../../shared/domain/quote';
import { QUOTE, legalStates } from '../domain/stateMachines';
import { createQuoteSchema } from '../domain/apiContracts';
import type { Attribution } from '../domain/operatorAction';

vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);

/**
 * QUOTES ARE WRITTEN, APPROVED BY SOMEBODY, AND READ ON THE REPLY PATH (S25).
 *
 * Every price on a quote comes from the book; every move asks the machine; an approval names
 * its approver or does not happen; approving one quote supersedes the other in force; and the
 * reply path is told LOADED or NOT_LOOKED_UP, never handed an empty list for "we did not look".
 */

const ORG = 'org-a';
const NOW = new Date('2026-09-12T12:00:00Z');
const LATER = new Date('2026-10-12T12:00:00Z');
const NAMED: Attribution = { kind: 'IDENTIFIED', actor: 'ops@abedin.example' };
const NOBODY: Attribution = { kind: 'UNATTRIBUTED', why: 'no verified identity on the request' };
const tier = PRICE_BOOK[0];
const line = { tierId: tier.id, component: 'monthly' as const, quantity: 2 };
const input = (overrides: Record<string, unknown> = {}) => ({
  email: 'Ada@Analytical.Example',
  contactId: 'ct_ada',
  lineItems: [line],
  validUntil: LATER.toISOString(),
  ...overrides,
});
const docs = () => Object.entries(memory.docs).filter(([k]) => k.startsWith(`organizations/${ORG}/quotes/`)).map(([, v]) => v as any);

beforeEach(() => memory.reset());

describe('1. a quote is priced from the book, never from the body', () => {
  it('a line names a tier and a component; the unit price is the book\'s', () => {
    const monthly = priceLine(line);
    expect(monthly).toEqual({ ok: true, line: { tierId: tier.id, description: expect.stringContaining(tier.name), quantity: 2, unitPrice: tier.monthly } });
    const setup = priceLine({ tierId: tier.id, component: 'setupFee', quantity: 1 });
    expect(setup.ok && setup.line.unitPrice).toEqual(tier.setupFee);
  });

  it('an unknown tier, an unknown component or a bad quantity is refused with the reason', () => {
    expect(priceLine({ tierId: 'platinum', component: 'monthly', quantity: 1 })).toMatchObject({ ok: false, message: expect.stringContaining('platinum') });
    expect(priceLine({ tierId: tier.id, component: 'discount' as any, quantity: 1 })).toMatchObject({ ok: false });
    for (const quantity of [0, -1, 1.5, 1001]) expect(priceLine({ tierId: tier.id, component: 'monthly', quantity }).ok, String(quantity)).toBe(false);
  });

  it('the contract carries no amount field, and refuses one', () => {
    expect(createQuoteSchema.safeParse({ lineItems: [line], validUntil: LATER.toISOString() }).success).toBe(true);
    expect(createQuoteSchema.safeParse({ lineItems: [{ ...line, unitPrice: 1 }], validUntil: LATER.toISOString() }).success).toBe(false);
    expect(createQuoteSchema.safeParse({ lineItems: [line], validUntil: LATER.toISOString(), amountMinor: 49900 }).success).toBe(false);
    expect(createQuoteSchema.safeParse({ lineItems: [], validUntil: LATER.toISOString() }).success).toBe(false);
    expect(createQuoteSchema.safeParse({ lineItems: [line], validUntil: 'next month' }).success).toBe(false);
  });

  it('the price-book version is a digest of the book, so a quote can say which book it came from', () => {
    expect(priceBookVersion()).toMatch(/^[0-9a-f]{16}$/);
    expect(priceBookVersion([{ ...tier, monthly: { ...tier.monthly, amountMinor: tier.monthly.amountMinor + 1 } }])).not.toBe(priceBookVersion());
  });

  it('created DRAFT, keyed by the normalised email, valid from now until the stated instant', async () => {
    const outcome = await createQuote(ORG, input(), NAMED, NOW);
    expect(outcome.ok).toBe(true);
    if (outcome.ok === false) return;
    expect(outcome.quote).toMatchObject({
      status: 'DRAFT',
      emailKey: 'ada@analytical.example',
      contactId: 'ct_ada',
      currency: 'GBP',
      validFrom: NOW.toISOString(),
      validUntil: LATER.toISOString(),
      approvedBy: null,
      createdBy: 'ops@abedin.example',
      pricingVersion: priceBookVersion(),
      version: 0,
    });
    expect(outcome.quote.lineItems[0].unitPrice).toEqual(tier.monthly);
    expect(docs()).toHaveLength(1);
    expect(QUOTE.initial).toContain(outcome.quote.status);
  });

  it('a quote that would already have expired, or with no line, or no usable email, is not made', async () => {
    expect(await createQuote(ORG, input({ validUntil: '2026-09-12T11:59:59Z' }), NAMED, NOW)).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(await createQuote(ORG, input({ lineItems: [] }), NAMED, NOW)).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(await createQuote(ORG, input({ email: 'not-an-address' }), NAMED, NOW)).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(docs()).toHaveLength(0);
  });
});

describe('2. every move asks the machine, and approval names its approver', () => {
  async function draft() {
    const outcome = await createQuote(ORG, input(), NAMED, NOW);
    if (outcome.ok === false) throw new Error(outcome.message);
    return outcome.quote.id;
  }

  it('the QUOTE machine is the shared transition map', () => {
    expect(QUOTE.transitions).toBe(QUOTE_TRANSITIONS);
    expect(legalStates(QUOTE)).toEqual(['APPROVED', 'DRAFT', 'EXPIRED', 'PENDING_APPROVAL', 'SUPERSEDED', 'WITHDRAWN']);
  });

  it('DRAFT -> PENDING_APPROVAL -> APPROVED, each a version', async () => {
    const id = await draft();
    const submitted = await submitQuote(ORG, id, NOW);
    expect(submitted).toMatchObject({ ok: true, quote: { status: 'PENDING_APPROVAL', version: 1, submittedAt: NOW.toISOString() } });
    const approved = await approveQuote(ORG, id, NAMED, NOW);
    expect(approved).toMatchObject({ ok: true, quote: { status: 'APPROVED', version: 2, approvedBy: 'ops@abedin.example', approvedAt: NOW.toISOString() } });
  });

  it('THE INVARIANT — a DRAFT cannot be approved (the map has no such edge), and an APPROVED quote cannot return to DRAFT', async () => {
    const id = await draft();
    expect(await approveQuote(ORG, id, NAMED, NOW)).toMatchObject({ ok: false, code: 'ILLEGAL_TRANSITION' });
    await submitQuote(ORG, id, NOW);
    await approveQuote(ORG, id, NAMED, NOW);
    expect(await submitQuote(ORG, id, NOW)).toMatchObject({ ok: false, code: 'ILLEGAL_TRANSITION' });
    expect((await getQuote(ORG, id))!.status).toBe('APPROVED');
  });

  it('THE INVARIANT — approval by nobody is refused, because a quote APPROVED by nobody binds nothing', async () => {
    const id = await draft();
    await submitQuote(ORG, id, NOW);
    expect(await approveQuote(ORG, id, NOBODY, NOW)).toMatchObject({ ok: false, code: 'ATTRIBUTION_REQUIRED' });
    expect((await getQuote(ORG, id))!.status).toBe('PENDING_APPROVAL');
    expect(quoteBinding({ ...(await getQuote(ORG, id))!, status: 'APPROVED', approvedBy: null }, NOW.toISOString()).binding).toBe(false);
  });

  it('an expired draft cannot be approved', async () => {
    const id = await draft();
    await submitQuote(ORG, id, NOW);
    expect(await approveQuote(ORG, id, NAMED, new Date('2026-11-01T00:00:00Z'))).toMatchObject({ ok: false, code: 'ILLEGAL_TRANSITION', message: expect.stringContaining('expired') });
  });

  it('THE INVARIANT — approving a second quote supersedes the first in the same transaction; one offer is in force', async () => {
    const first = await draft();
    await submitQuote(ORG, first, NOW);
    await approveQuote(ORG, first, NAMED, NOW);
    const second = await draft();
    await submitQuote(ORG, second, NOW);
    const t2 = new Date(NOW.getTime() + 60_000);
    await approveQuote(ORG, second, NAMED, t2);
    expect((await getQuote(ORG, first))).toMatchObject({ status: 'SUPERSEDED', supersededBy: second });
    expect((await getQuote(ORG, second))).toMatchObject({ status: 'APPROVED' });
    const active = await activeQuoteFor(ORG, 'ada@analytical.example', t2);
    expect(active?.id).toBe(second);
    expect((await quotesForEmail(ORG, 'ADA@analytical.example')).map((q) => q.status)).toEqual(['SUPERSEDED', 'APPROVED']);
  });

  it('withdraw records who and when; a withdrawn quote is not in force', async () => {
    const id = await draft();
    await submitQuote(ORG, id, NOW);
    await approveQuote(ORG, id, NAMED, NOW);
    expect(await withdrawQuote(ORG, id, NAMED, NOW)).toMatchObject({ ok: true, quote: { status: 'WITHDRAWN', withdrawnBy: 'ops@abedin.example' } });
    expect(await activeQuoteFor(ORG, 'ada@analytical.example', NOW)).toBeNull();
  });

  it('an unknown quote is NOT_FOUND, not a new one', async () => {
    expect(await submitQuote(ORG, 'quo_nope', NOW)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await approveQuote(ORG, 'quo_nope', NAMED, NOW)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(docs()).toHaveLength(0);
  });
});

describe('3. the reply path is told what was found, or that nothing was looked', () => {
  it('LOADED with the quote in force, and the pricing context states its amounts and withholds the list', async () => {
    const outcome = await createQuote(ORG, input(), NAMED, NOW);
    if (outcome.ok === false) throw new Error(outcome.message);
    await submitQuote(ORG, outcome.quote.id, NOW);
    await approveQuote(ORG, outcome.quote.id, NAMED, NOW);
    const lookup = await lookupQuotesForReply(ORG, 'ada@analytical.example', NOW);
    expect(lookup.availability).toBe('LOADED');
    if (lookup.availability !== 'LOADED') return;
    expect(lookup.activeQuote?.id).toBe(outcome.quote.id);
    expect(lookup.quotes).toHaveLength(1);
    const context = pricingContextFor(lookup.activeQuote, NOW.toISOString());
    expect(context.listPricingWithheld).toBe(true);
    expect(context.quotableAmounts.length).toBeGreaterThan(0);
    expect(context.promptBlock).toContain(`quote ${outcome.quote.id}`);
    expect(context.promptBlock).toContain('ops@abedin.example');
  });

  it('LOADED with no quote in force is a different fact from NOT_LOOKED_UP', async () => {
    const none = await lookupQuotesForReply(ORG, 'nobody@analytical.example', NOW);
    expect(none).toEqual({ availability: 'LOADED', activeQuote: null, quotes: [] });
    const unusable = await lookupQuotesForReply(ORG, 'not an address', NOW);
    expect(unusable).toMatchObject({ availability: 'NOT_LOOKED_UP' });
    expect(await lookupQuotesForReply(ORG, null, NOW)).toMatchObject({ availability: 'NOT_LOOKED_UP' });
  });

  it('THE INVARIANT — a store that cannot be read is NOT_LOOKED_UP with the reason, never an empty LOADED', async () => {
    memory.failReadsWith = 'store down';
    try {
      const lookup = await lookupQuotesForReply(ORG, 'ada@analytical.example', NOW);
      expect(lookup).toEqual({ availability: 'NOT_LOOKED_UP', reason: 'store down' });
    } finally {
      memory.failReadsWith = null;
    }
  });

  it('an expired approved quote is not in force, and the lookup says so by returning none', async () => {
    const outcome = await createQuote(ORG, input({ validUntil: '2026-09-13T00:00:00Z' }), NAMED, NOW);
    if (outcome.ok === false) throw new Error(outcome.message);
    await submitQuote(ORG, outcome.quote.id, NOW);
    await approveQuote(ORG, outcome.quote.id, NAMED, NOW);
    const before = await lookupQuotesForReply(ORG, 'ada@analytical.example', NOW);
    expect(before.availability === 'LOADED' ? before.activeQuote?.id : null).toBe(outcome.quote.id);
    const later = await lookupQuotesForReply(ORG, 'ada@analytical.example', new Date('2026-09-14T00:00:00Z'));
    expect(later).toMatchObject({ availability: 'LOADED', activeQuote: null });
  });
});

// =============================================================================================
describe('4. the reply path passes what it found down, in the shape each consumer was written for', () => {
  // Two mutants survived the behavioural suites: the pipeline telling the auditor
  // NOT_LOOKED_UP whatever the lookup found, and passing the composer no quote at all. The
  // pipeline is the one module this repository pins by text rather than by calling it (see
  // livePath.invariant); these are the same kind of pin, on the four hand-offs.
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const pipeline = stripComments(readFileSync('server/services/inboundPipeline.ts', 'utf8'));

  it('looks quotes up by the address the customer wrote from, before planning', () => {
    expect(pipeline).toContain('const quoteLookup = await lookupQuotesForReply(organizationId, email.from);');
    expect(pipeline.indexOf('lookupQuotesForReply(organizationId, email.from)')).toBeLessThan(pipeline.indexOf('buildContextBundle({'));
  });

  it('THE INVARIANT — the auditor is told what the lookup found, not a constant', () => {
    expect(pipeline).toContain('quoteAvailability: quoteLookup.availability,');
    expect(pipeline).not.toMatch(/quoteAvailability:\s*'NOT_LOOKED_UP'/);
    expect(pipeline).toContain("quote: quoteLookup.availability === 'LOADED' ? quoteLookup.activeQuote : null,");
  });

  it('THE INVARIANT — the composer receives the quote in force, and a reader that throws when the lookup did not run', () => {
    expect(pipeline).toContain("activeQuote: quoteLookup.availability === 'LOADED' ? quoteLookup.activeQuote : null,");
    expect(pipeline).toContain('throw new Error(quoteLookup.reason);');
    expect(pipeline).toContain("quotes: quoteLookup.availability === 'LOADED' ? quoteLookup.quotes : [],");
  });
});
