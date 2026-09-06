/**
 * P1.7 — ONE PRICING MODULE (addendum §25, §1, §24).
 *
 * WHAT WAS WRONG
 * --------------
 * The price of the product was written down in at least eleven places, as prose, and they did
 * not agree. "Growth Tier" costs £499/mo with 2,500 minutes in `seedLeadsGenerator.ts` and
 * £599/mo with 3,000 minutes in `dataStore.ts` — the company-brain document that is stringified
 * into every outbound prompt. The contract in `LiveMeetingRoomModal.tsx` states
 * "£499.00 GBP per month" as binding commercial terms. `multiAgentReplySystem.ts` carries a
 * bare `monthlyFee: 499` with no currency at all.
 *
 * `CANONICAL_KNOWLEDGE.pricing` in `salesDecisionEngine.ts` looks like the fix and is not: every
 * field is a human sentence ("£499 / month per clinic location"), so nothing can compute with
 * it, compare against it, or detect a departure from it. It is documentation that happens to
 * live in a variable.
 *
 * The one mechanism meant to catch a wrong price was this, in the independent auditor:
 *
 *     if (input.replyPlan.nextBestAction === "PROVIDE_PRICING") {
 *       if (sanitizedBody.includes("£499")) { ...pass... } else { score -= 20; }
 *     }
 *
 * It runs ONLY when the plan says the reply is about pricing, so a wrong price in any other
 * reply is unexamined. It is a substring test, so "our old price of £499" passes and "£4,499"
 * contains it. And it can only notice the ABSENCE of the expected string — it cannot notice the
 * PRESENCE of a price we never charged, which is the failure that actually reaches a customer.
 *
 * THE RULE
 * --------
 * Money is structured data in one module, in minor units, with a currency. Prose is generated
 * from it, never the other way round.
 */

/**
 * The closed set of currencies, as a RUNTIME value.
 *
 * `CurrencyCode` was type-only, so nothing could check a currency that arrived from outside the
 * program — a jsonb column, a request body, a provider response. A type that exists only at
 * compile time cannot validate data that only exists at run time, and money read from a blob is
 * exactly the case where the check has to be real.
 *
 * `CurrencyCode` is derived FROM this array rather than declared beside it, so the two cannot
 * drift: adding a currency here adds it to the type, and there is no way to add one to the type
 * without adding it here.
 */
export const CURRENCIES = ['GBP'] as const;

export type CurrencyCode = (typeof CURRENCIES)[number];

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

/**
 * An amount in MINOR units — pence, not pounds.
 *
 * Floating-point pounds are the classic way to bill someone the wrong number: 0.1 + 0.2 is not
 * 0.3, and a quote total assembled from decimal line items drifts. Integers cannot drift, and
 * the currency travels with the amount so a bare `499` can never be mistaken for dollars.
 */
export interface Money {
  amountMinor: number;
  currency: CurrencyCode;
}

export function money(amountMinor: number, currency: CurrencyCode = 'GBP'): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new PricingError(
      `Money must be an integer number of minor units; received ${amountMinor}. ` +
        'Pounds as a float is how a total drifts by a penny and a customer is billed wrongly.'
    );
  }
  return { amountMinor, currency };
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

const SYMBOLS: Record<CurrencyCode, string> = { GBP: '£' };

/** The single rendering of an amount. Every surface uses this, so they cannot disagree. */
export function formatMoney(value: Money): string {
  const symbol = SYMBOLS[value.currency] ?? '';
  const major = Math.trunc(Math.abs(value.amountMinor) / 100);
  const minor = Math.abs(value.amountMinor) % 100;
  const sign = value.amountMinor < 0 ? '-' : '';
  const grouped = major.toLocaleString('en-GB');
  return minor === 0
    ? `${sign}${symbol}${grouped}`
    : `${sign}${symbol}${grouped}.${String(minor).padStart(2, '0')}`;
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new PricingError(`Cannot add ${a.currency} to ${b.currency}.`);
  }
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function multiplyMoney(value: Money, quantity: number): Money {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new PricingError(`Quantity must be a non-negative integer; received ${quantity}.`);
  }
  return { amountMinor: value.amountMinor * quantity, currency: value.currency };
}

export interface PriceTier {
  id: string;
  name: string;
  /** Recurring price per billing period. */
  monthly: Money;
  includedVoiceMinutes: number;
  /** Charged per minute beyond the included allowance. */
  overagePerMinute: Money;
  includedPhoneLines: number;
  setupFee: Money;
  /** Present only where a real trial exists. Absent is not "no trial offered" — it is unknown. */
  trialDays?: number;
}

/**
 * The price book. The ONE place a price is written down.
 *
 * The numbers below are taken from `CANONICAL_KNOWLEDGE.pricing` and the auditor's canonical
 * check, which are the two places that agreed with each other and with the signed contract in
 * the meeting-room modal. The £599 Growth Tier in `dataStore.ts` contradicted all three; it is
 * NOT adopted here, because adopting the higher of two conflicting prices for a tier that is
 * already quoted at the lower one in a contract would change what customers are charged.
 * Resolving that contradiction is a commercial decision, not a refactor — see
 * `PRICE_BOOK_CONFLICTS` below, which records it rather than silently picking a winner.
 */
export const PRICE_BOOK: readonly PriceTier[] = Object.freeze([
  Object.freeze({
    id: 'standard',
    name: 'Standard',
    monthly: { amountMinor: 49_900, currency: 'GBP' as const },
    includedVoiceMinutes: 2_500,
    overagePerMinute: { amountMinor: 12, currency: 'GBP' as const },
    includedPhoneLines: 1,
    setupFee: { amountMinor: 0, currency: 'GBP' as const },
    trialDays: 14,
  }),
]);

/**
 * Contradictions found in the source material, recorded rather than resolved.
 *
 * A pricing module that quietly picked one of two conflicting figures would look authoritative
 * while hiding the fact that nobody has decided. §2's rule applies to prices as much as to
 * statuses: this is a claim about the world, and the evidence is contradictory.
 */
export const PRICE_BOOK_CONFLICTS: readonly string[] = Object.freeze([
  'server/dataStore.ts describes a "Growth Tier" at £599/mo with 3,000 minutes and 3 lines, ' +
    'and a "Starter Tier" at £299/mo. seedLeadsGenerator.ts describes a "Growth Tier" at ' +
    '£499/mo with 2,500 minutes. The signed contract text in LiveMeetingRoomModal.tsx states ' +
    '£499.00 GBP. These cannot all be true. Only the £499 standard package is in this price ' +
    'book; the £299 and £599 tiers are NOT quotable until somebody decides what they are.',
  'multiAgentReplySystem.ts carried `monthlyFee: category === "PARTNER" ? 1499 : 499` with no ' +
    'currency and no tier definition. There is no partner tier in this price book.',
]);

/**
 * The tier every current surface quotes.
 *
 * Named rather than `PRICE_BOOK[0]`, so adding a tier cannot silently change what the contract
 * and the composer state.
 */
export const STANDARD_TIER: PriceTier = PRICE_BOOK[0];

export function tierById(id: string): PriceTier | null {
  return PRICE_BOOK.find((tier) => tier.id === id) ?? null;
}

/** Every amount the price book permits a reply to state. Used to detect a price we never set. */
export function priceBookAmounts(): Money[] {
  const amounts: Money[] = [];
  for (const tier of PRICE_BOOK) {
    amounts.push(tier.monthly, tier.overagePerMinute, tier.setupFee);
  }
  return amounts;
}

/**
 * Extract every currency amount from a body of text.
 *
 * This is what makes a real pricing check possible. The auditor could previously only ask "does
 * the expected string appear"; with this it can ask the question that matters — "does any
 * amount appear that we never agreed to" — which is the direction a hallucinated price fails in.
 *
 * Amounts are returned in minor units so they compare exactly against the price book.
 */
export function extractMoneyLiterals(text: unknown): Money[] {
  if (typeof text !== 'string' || text.length === 0) return [];

  const found: Money[] = [];
  // A symbol, then digits with optional thousands separators, then optional pence. The decimal
  // part is bounded to two digits so a version number or a date cannot be read as an amount.
  const pattern = /£\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const major = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(major)) continue;
    const minorDigits = match[2] ?? '';
    // '.5' means fifty pence, not five. Padding right is the difference between £0.50 and £0.05.
    const minor = minorDigits.length === 0 ? 0 : Number(minorDigits.padEnd(2, '0'));
    found.push({ amountMinor: major * 100 + minor, currency: 'GBP' });
  }

  return found;
}

export function sameMoney(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}
