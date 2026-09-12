import { createHash } from 'node:crypto';
import { collection, doc, getDocs, query, where, runTransaction, store } from '../store';
import { orgPath } from '../tenancy/orgScope';
import { assertTransition, creationState, QUOTE } from '../domain/stateMachines';
import { normalizeEmailKey } from '../lib/emailKey';
import { PRICE_BOOK, type Money, type PriceTier } from '../../shared/domain/pricing';
import { quoteBinding, type Quote, type QuoteLineItem } from '../../shared/domain/quote';
import type { Attribution } from '../domain/operatorAction';

/**
 * S25 — QUOTES: written, approved by somebody, read on the live reply path.
 *
 * WHAT WAS THERE
 * --------------
 * A `Quote` type with a state machine, a binding rule ("APPROVED, approver named, in force,
 * not superseded"), a pricing context the composer builds from it and an auditor that clears
 * stated amounts against it — and no quote was ever written. The reader on the reply path read
 * a relational `quote_snapshots` table nothing inserted into, keyed by a contact id from a
 * different population than the API's contacts, and passed raw rows into the prompt. The
 * auditor was told NOT_LOOKED_UP on every run, which it treats correctly as "cannot clear".
 *
 * WHAT THIS IS
 * ------------
 * Quotes are documents under `organizations/<org>/quotes`, keyed for lookup by the customer's
 * normalised email — the one identity both the API's contacts and the inbound pipeline's
 * resolved senders share — and covered by the tenant policy S4 put on the store. Prices are
 * never typed in: a line item names a tier and a component (`monthly`, `setupFee`) and the unit
 * price is read from the price book, so a quote cannot state an amount the book does not hold
 * (`check-single-price-source` is the guardrail; this is the design that makes it easy to obey).
 * `pricingVersion` is a digest of the price book at the time of quoting, so a quote can say
 * which book it was made from after the book changes.
 *
 * Every move asks the quote machine. Approval needs an identified approver — a quote APPROVED
 * by nobody is not binding, by the shared rule — and approving one quote supersedes any other
 * APPROVED quote for the same customer in the same transaction, so there is never a moment with
 * two offers in force.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It does not send a quote to anyone, and it does not charge: an approved quote is what the
 * composer may state and what the auditor clears amounts against. The checkout amount stays
 * configuration (S25's earlier finding), and reconciling it with an approved quote is a step
 * this module makes possible rather than performs.
 */

export const QUOTES = 'quotes';
export const QUOTE_COMPONENTS = ['monthly', 'setupFee'] as const;
export type QuoteComponent = (typeof QUOTE_COMPONENTS)[number];

export interface QuoteLineInput {
  readonly tierId: string;
  readonly component: QuoteComponent;
  readonly quantity: number;
}

export interface CreateQuoteInput {
  readonly email: string;
  readonly contactId: string | null;
  readonly conversationId?: string | null;
  readonly lineItems: readonly QuoteLineInput[];
  /** ISO instant; must be after `now`. Stated by the operator, never defaulted. */
  readonly validUntil: string;
}

/** A stored quote: the shared shape, plus the key it is found by and who made it. */
export interface QuoteDoc extends Quote {
  readonly emailKey: string;
  readonly createdBy: string;
  readonly pricingVersion: string;
  readonly submittedAt: string | null;
  readonly withdrawnAt: string | null;
  readonly withdrawnBy: string | null;
}

export type QuoteOutcome =
  | { ok: true; quote: QuoteDoc }
  | { ok: false; code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'ILLEGAL_TRANSITION' | 'ATTRIBUTION_REQUIRED' | 'STORE_UNAVAILABLE'; message: string };

/** The price book as it is now, named so a quote can say which book it came from. */
export function priceBookVersion(book: readonly PriceTier[] = PRICE_BOOK): string {
  return createHash('sha256').update(JSON.stringify(book)).digest('hex').slice(0, 16);
}

/** A line item priced from the book, or the reason it cannot be. */
export function priceLine(input: QuoteLineInput, book: readonly PriceTier[] = PRICE_BOOK): { ok: true; line: QuoteLineItem } | { ok: false; message: string } {
  const tier = book.find((t) => t.id === input.tierId);
  if (!tier) return { ok: false, message: `no tier ${JSON.stringify(input.tierId)} in the price book` };
  if (!(QUOTE_COMPONENTS as readonly string[]).includes(input.component)) {
    return { ok: false, message: `no component ${JSON.stringify(input.component)}; a line is 'monthly' or 'setupFee'` };
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 1000) {
    return { ok: false, message: 'quantity must be a whole number from 1 to 1000' };
  }
  const unitPrice: Money = input.component === 'monthly' ? tier.monthly : tier.setupFee;
  const description = input.component === 'monthly' ? `${tier.name} — monthly subscription, per clinic location` : `${tier.name} — onboarding and setup fee`;
  return { ok: true, line: { tierId: tier.id, description, quantity: input.quantity, unitPrice } };
}

function quotesCollection(orgId: string) {
  return collection(store, orgPath(orgId, QUOTES));
}

function quoteRef(orgId: string, id: string) {
  return doc(store, orgPath(orgId, QUOTES), id);
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function readQuote(raw: Record<string, unknown> | undefined): QuoteDoc {
  const d = raw ?? {};
  const items = Array.isArray(d.lineItems) ? d.lineItems : [];
  return {
    id: str(d.id),
    organizationId: str(d.organizationId),
    contactId: str(d.contactId),
    conversationId: strOrNull(d.conversationId),
    currency: (str(d.currency, 'GBP') as Quote['currency']),
    lineItems: items.filter((i): i is QuoteLineItem => i !== null && typeof i === 'object'),
    status: str(d.status, 'DRAFT') as Quote['status'],
    version: typeof d.version === 'number' ? d.version : 0,
    validFrom: str(d.validFrom),
    validUntil: strOrNull(d.validUntil),
    approvedBy: strOrNull(d.approvedBy),
    approvedAt: strOrNull(d.approvedAt),
    supersededBy: strOrNull(d.supersededBy),
    createdAt: str(d.createdAt),
    updatedAt: str(d.updatedAt),
    emailKey: str(d.emailKey),
    createdBy: str(d.createdBy),
    pricingVersion: str(d.pricingVersion),
    submittedAt: strOrNull(d.submittedAt),
    withdrawnAt: strOrNull(d.withdrawnAt),
    withdrawnBy: strOrNull(d.withdrawnBy),
  };
}

function actorOf(attribution: Attribution): string | null {
  return attribution.kind === 'IDENTIFIED' ? attribution.actor : null;
}

// =============================================================================================

export async function createQuote(orgId: string, input: CreateQuoteInput, createdBy: Attribution, now: Date = new Date()): Promise<QuoteOutcome> {
  if (!store) return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  const emailKey = normalizeEmailKey(input.email);
  if (emailKey === null) return { ok: false, code: 'VALIDATION_ERROR', message: 'A quote needs the customer\'s email address.' };
  if (input.lineItems.length === 0) return { ok: false, code: 'VALIDATION_ERROR', message: 'A quote needs at least one line item.' };
  const lines: QuoteLineItem[] = [];
  for (const item of input.lineItems) {
    const priced = priceLine(item);
    if (priced.ok === false) return { ok: false, code: 'VALIDATION_ERROR', message: priced.message };
    lines.push(priced.line);
  }
  const until = Date.parse(input.validUntil);
  if (!Number.isFinite(until)) return { ok: false, code: 'VALIDATION_ERROR', message: 'validUntil must be an ISO instant.' };
  if (until <= now.getTime()) return { ok: false, code: 'VALIDATION_ERROR', message: 'validUntil must be later than now: a quote that has already expired cannot be made.' };
  const currencies = new Set(lines.map((l) => l.unitPrice.currency));
  if (currencies.size !== 1) return { ok: false, code: 'VALIDATION_ERROR', message: 'A quote is in one currency.' };
  const creation = creationState(QUOTE, undefined);
  if (creation.ok === false) return { ok: false, code: 'VALIDATION_ERROR', message: creation.message };
  const id = `quo_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const iso = now.toISOString();
  const quote: QuoteDoc = {
    id,
    organizationId: orgId,
    contactId: input.contactId ?? '',
    conversationId: input.conversationId ?? null,
    currency: [...currencies][0],
    lineItems: lines,
    status: creation.state as Quote['status'],
    version: 0,
    validFrom: iso,
    validUntil: new Date(until).toISOString(),
    approvedBy: null,
    approvedAt: null,
    supersededBy: null,
    createdAt: iso,
    updatedAt: iso,
    emailKey,
    createdBy: actorOf(createdBy) ?? 'unattributed',
    pricingVersion: priceBookVersion(),
    submittedAt: null,
    withdrawnAt: null,
    withdrawnBy: null,
  };
  await runTransaction(store, async (tx) => {
    tx.set(quoteRef(orgId, id), quote);
  });
  return { ok: true, quote };
}

async function move(orgId: string, id: string, to: Quote['status'], patch: Partial<QuoteDoc>, now: Date): Promise<QuoteOutcome> {
  if (!store) return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  return runTransaction(store, async (tx) => {
    const snap = await tx.get(quoteRef(orgId, id));
    if (!snap.exists()) return { ok: false as const, code: 'NOT_FOUND' as const, message: 'No such quote.' };
    const current = readQuote(snap.data());
    const verdict = assertTransition(QUOTE, current.status, to);
    if (verdict.ok === false) return { ok: false as const, code: 'ILLEGAL_TRANSITION' as const, message: verdict.message };
    if (verdict.changed === false) return { ok: true as const, quote: current };
    const next: QuoteDoc = { ...current, ...patch, status: to, version: current.version + 1, updatedAt: now.toISOString() };
    tx.set(quoteRef(orgId, id), next);
    return { ok: true as const, quote: next };
  });
}

export function submitQuote(orgId: string, id: string, now: Date = new Date()): Promise<QuoteOutcome> {
  return move(orgId, id, 'PENDING_APPROVAL', { submittedAt: now.toISOString() }, now);
}

export function withdrawQuote(orgId: string, id: string, by: Attribution, now: Date = new Date()): Promise<QuoteOutcome> {
  return move(orgId, id, 'WITHDRAWN', { withdrawnAt: now.toISOString(), withdrawnBy: actorOf(by) ?? 'unattributed' }, now);
}

/**
 * Approve: the approver must be identified (the binding rule refuses an APPROVED quote that
 * names nobody, so approving without a name would make a quote that binds nothing), and any
 * other APPROVED quote for the same customer is superseded in the same transaction.
 */
export async function approveQuote(orgId: string, id: string, by: Attribution, now: Date = new Date()): Promise<QuoteOutcome> {
  if (!store) return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  const approver = actorOf(by);
  if (approver === null) {
    return { ok: false, code: 'ATTRIBUTION_REQUIRED', message: `Approval needs an identified approver: ${by.kind === 'UNATTRIBUTED' ? by.why : 'nobody is named'}.` };
  }
  const iso = now.toISOString();
  return runTransaction(store, async (tx) => {
    const snap = await tx.get(quoteRef(orgId, id));
    if (!snap.exists()) return { ok: false as const, code: 'NOT_FOUND' as const, message: 'No such quote.' };
    const current = readQuote(snap.data());
    const verdict = assertTransition(QUOTE, current.status, 'APPROVED');
    if (verdict.ok === false) return { ok: false as const, code: 'ILLEGAL_TRANSITION' as const, message: verdict.message };
    if (verdict.changed === false) return { ok: true as const, quote: current };
    if (current.validUntil !== null && Date.parse(current.validUntil) <= now.getTime()) {
      return { ok: false as const, code: 'ILLEGAL_TRANSITION' as const, message: `Quote ${id} expired on ${current.validUntil}; an expired draft cannot be approved.` };
    }
    // Every other APPROVED quote for this customer is superseded by this one, in this transaction.
    const others = await tx.getAll(query(quotesCollection(orgId), where('emailKey', '==', current.emailKey), where('status', '==', 'APPROVED')));
    others.forEach((d) => {
      const other = readQuote(d.data());
      if (other.id === id) return;
      const move = assertTransition(QUOTE, other.status, 'SUPERSEDED');
      if (move.ok === false) throw new Error(move.message);
      tx.set(quoteRef(orgId, other.id), { ...other, status: 'SUPERSEDED', supersededBy: id, version: other.version + 1, updatedAt: iso });
    });
    const next: QuoteDoc = { ...current, status: 'APPROVED', approvedBy: approver, approvedAt: iso, version: current.version + 1, updatedAt: iso };
    tx.set(quoteRef(orgId, id), next);
    return { ok: true as const, quote: next };
  });
}

export async function quotesForEmail(orgId: string, email: string): Promise<QuoteDoc[]> {
  if (!store) return [];
  const emailKey = normalizeEmailKey(email);
  if (emailKey === null) return [];
  const snap = await getDocs(query(quotesCollection(orgId), where('emailKey', '==', emailKey)));
  const out: QuoteDoc[] = [];
  snap.forEach((d) => out.push(readQuote(d.data())));
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getQuote(orgId: string, id: string): Promise<QuoteDoc | null> {
  if (!store) return null;
  const snap = await getDocs(query(quotesCollection(orgId), where('id', '==', id)));
  let found: QuoteDoc | null = null;
  snap.forEach((d) => {
    found = readQuote(d.data());
  });
  return found;
}

/**
 * The quote in force for a customer now, by the shared binding rule, or null. Throws when the
 * store cannot be read: the caller must say NOT_LOOKED_UP, not "none".
 */
export async function activeQuoteFor(orgId: string, email: string, now: Date = new Date()): Promise<QuoteDoc | null> {
  const iso = now.toISOString();
  const binding = (await quotesForEmail(orgId, email)).filter((q) => quoteBinding(q, iso).binding);
  if (binding.length === 0) return null;
  return binding.sort((a, b) => (b.approvedAt ?? '').localeCompare(a.approvedAt ?? ''))[0];
}

export type QuoteLookup =
  | { availability: 'LOADED'; activeQuote: QuoteDoc | null; quotes: QuoteDoc[] }
  | { availability: 'NOT_LOOKED_UP'; reason: string };

/** What the reply path asks: looked up, or why not — never an empty list standing in for "we did not look". */
export async function lookupQuotesForReply(orgId: string, email: string | null | undefined, now: Date = new Date()): Promise<QuoteLookup> {
  if (typeof email !== 'string' || normalizeEmailKey(email) === null) {
    return { availability: 'NOT_LOOKED_UP', reason: 'no usable sender address to look quotes up by' };
  }
  try {
    const quotes = await quotesForEmail(orgId, email);
    const iso = now.toISOString();
    const binding = quotes.filter((q) => quoteBinding(q, iso).binding).sort((a, b) => (b.approvedAt ?? '').localeCompare(a.approvedAt ?? ''));
    return { availability: 'LOADED', activeQuote: binding[0] ?? null, quotes };
  } catch (e: unknown) {
    return { availability: 'NOT_LOOKED_UP', reason: e instanceof Error ? e.message : String(e) };
  }
}
