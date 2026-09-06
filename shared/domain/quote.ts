import {
  PRICE_BOOK,
  addMoney,
  extractMoneyLiterals,
  formatMoney,
  money,
  multiplyMoney,
  sameMoney,
  type CurrencyCode,
  type Money,
} from './pricing';

/**
 * P1.7 — QUOTES, AND WHY LIST PRICING IS REMOVED RATHER THAN DEPRIORITISED (§25, §1, §24).
 *
 * There was no quote object anywhere in the repository — no type, no table, no collection. A
 * negotiated price existed only as a sentence inside a draft email, so nothing could check what
 * a customer had actually been offered, and nothing could tell whether an offer was still open.
 *
 * THE MECHANISM THAT MATTERS
 * --------------------------
 * When a customer has a negotiated quote, the reply must state the quote and not the list
 * price. The tempting implementation is to put both in the prompt and instruct the model that
 * the quote takes precedence. That is a request, not a control: the list price is still sitting
 * in the context, and a model that quotes it produces a commercially wrong email that goes to a
 * customer who was promised something else.
 *
 * So precedence is enforced by ABSENCE. When a binding quote exists, `pricingContextFor` emits
 * the quote alone and the price book is not in the prompt at all. A model cannot state a number
 * it was never shown. This is the same principle as the prompt-authority separation in P1.10:
 * a structural property beats an instruction, because instructions are advisory and structure
 * is not.
 */

export type QuoteStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'WITHDRAWN'
  | 'EXPIRED'
  | 'SUPERSEDED';

export interface QuoteLineItem {
  /** The price-book tier this line came from, or null for a bespoke line. */
  tierId: string | null;
  description: string;
  quantity: number;
  unitPrice: Money;
}

export interface Quote {
  id: string;
  organizationId: string;
  contactId: string;
  conversationId?: string | null;
  currency: CurrencyCode;
  lineItems: QuoteLineItem[];
  status: QuoteStatus;
  version: number;
  /** When the offer opens and closes. An offer with no end date never expires by accident. */
  validFrom: string;
  validUntil: string | null;
  /** Who approved it. An APPROVED quote with no approver is not approved (§14). */
  approvedBy?: string | null;
  approvedAt?: string | null;
  supersededBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Quote lifecycle. Mirrors the shape of the P1.4 machines so the same checker can drive it. */
export const QUOTE_TRANSITIONS: Readonly<Record<QuoteStatus, readonly QuoteStatus[]>> =
  Object.freeze({
    DRAFT: ['PENDING_APPROVAL', 'WITHDRAWN'],
    PENDING_APPROVAL: ['APPROVED', 'DRAFT', 'WITHDRAWN'],
    // An approved quote is an offer that has been made to a customer. It can lapse, be
    // withdrawn, or be replaced — but it cannot quietly return to DRAFT and be edited, because
    // the customer is holding the version they were sent.
    APPROVED: ['SUPERSEDED', 'EXPIRED', 'WITHDRAWN'],
    WITHDRAWN: [],
    EXPIRED: [],
    SUPERSEDED: [],
  });

export function quoteTotal(quote: Pick<Quote, 'lineItems' | 'currency'>): Money {
  let total = money(0, quote.currency);
  for (const item of quote.lineItems) {
    total = addMoney(total, multiplyMoney(item.unitPrice, item.quantity));
  }
  return total;
}

export type QuoteBindingVerdict =
  | { binding: true }
  | { binding: false; reason: string };

/**
 * Is this quote an offer we are currently standing behind?
 *
 * Every negative answer is explicit, because "not binding" and "binding" must never be decided
 * by a truthiness check on an object. Absence of a quote is handled by the caller; absence of
 * an APPROVAL on a quote that claims to be approved is handled here.
 */
export function quoteBinding(quote: Quote | null | undefined, now: string): QuoteBindingVerdict {
  if (!quote) return { binding: false, reason: 'No quote exists for this conversation.' };

  if (quote.status !== 'APPROVED') {
    return { binding: false, reason: `Quote ${quote.id} is ${quote.status}, not APPROVED.` };
  }

  // §14 applied to commercial state: a record that says APPROVED but names nobody is a record
  // of an approval that may never have happened. That is unknown, and unknown is not permission.
  if (typeof quote.approvedBy !== 'string' || quote.approvedBy.length === 0) {
    return {
      binding: false,
      reason:
        `Quote ${quote.id} is marked APPROVED but names no approver. An approval nobody is ` +
        'accountable for is not an approval.',
    };
  }

  if (typeof quote.supersededBy === 'string' && quote.supersededBy.length > 0) {
    return { binding: false, reason: `Quote ${quote.id} was superseded by ${quote.supersededBy}.` };
  }

  if (quote.validFrom > now) {
    return { binding: false, reason: `Quote ${quote.id} does not take effect until ${quote.validFrom}.` };
  }

  if (quote.validUntil !== null && quote.validUntil !== undefined && quote.validUntil <= now) {
    return {
      binding: false,
      reason:
        `Quote ${quote.id} expired on ${quote.validUntil}. An expired offer must not be ` +
        'restated as though it were still open.',
    };
  }

  return { binding: true };
}

export interface PricingContext {
  /**
   * The prompt text describing what may be offered. When a quote binds, this contains the
   * quote and NOT the price book — see the note at the top of this file.
   */
  promptBlock: string;
  /** Every amount a reply is permitted to state. The auditor checks the body against this. */
  quotableAmounts: Money[];
  /** True when list pricing was withheld because a quote takes precedence. */
  listPricingWithheld: boolean;
  /** Why the context looks the way it does. Recorded on the run log, not shown to the model. */
  rationale: string;
}

/**
 * Build the pricing context for a reply.
 *
 * `quote` is the most recent quote for the conversation, or null. The caller does not decide
 * precedence — this function does, and it does it by choosing what to emit.
 */
export function pricingContextFor(quote: Quote | null | undefined, now: string): PricingContext {
  const verdict = quoteBinding(quote, now);

  if (verdict.binding && quote) {
    const total = quoteTotal(quote);
    const lines = quote.lineItems
      .map(
        (item) =>
          `  - ${item.description}: ${item.quantity} x ${formatMoney(item.unitPrice)} = ` +
          `${formatMoney(multiplyMoney(item.unitPrice, item.quantity))}`
      )
      .join('\n');

    return {
      promptBlock:
        `AGREED PRICING FOR THIS CUSTOMER (quote ${quote.id}, version ${quote.version}, ` +
        `approved by ${quote.approvedBy}):\n${lines}\n  TOTAL: ${formatMoney(total)}` +
        (quote.validUntil ? `\n  Valid until: ${quote.validUntil}` : '') +
        '\n\nThese are the only prices that may be stated. No other pricing is available to ' +
        'you for this customer.',
      quotableAmounts: [...quote.lineItems.map((i) => i.unitPrice), total],
      listPricingWithheld: true,
      rationale:
        `Binding quote ${quote.id} v${quote.version}. List pricing withheld from the prompt so ` +
        'the model cannot state a number this customer was not offered.',
    };
  }

  // No binding quote: list pricing is what may be stated.
  const tierLines = PRICE_BOOK.map(
    (tier) =>
      `  - ${tier.name}: ${formatMoney(tier.monthly)} per month, ` +
      `${tier.includedVoiceMinutes.toLocaleString('en-GB')} voice minutes included, ` +
      `${formatMoney(tier.overagePerMinute)} per additional minute, ` +
      `setup fee ${formatMoney(tier.setupFee)}` +
      (tier.trialDays ? `, ${tier.trialDays}-day trial` : '')
  ).join('\n');

  const amounts: Money[] = [];
  for (const tier of PRICE_BOOK) {
    amounts.push(tier.monthly, tier.overagePerMinute, tier.setupFee);
  }

  return {
    promptBlock:
      `LIST PRICING:\n${tierLines}\n\nThese are the only prices that may be stated. Do not ` +
      'compute, estimate or offer any other figure.',
    quotableAmounts: amounts,
    listPricingWithheld: false,
    // `=== false` rather than a ternary on the discriminant: TypeScript does not narrow the
    // union in the negative arm here, and the cast that would silence it is what hid the
    // ConversationMemory.facts crash in P1.6.
    rationale: verdict.binding === false ? verdict.reason : 'No quote for this conversation.',
  };
}

export type PricingAuditFinding = {
  stated: Money;
  message: string;
};

/**
 * Check a draft body against what this customer may be quoted.
 *
 * This asks the question the old check could not. `sanitizedBody.includes("£499")` could only
 * detect the ABSENCE of an expected string; it had no way to notice the PRESENCE of a price we
 * never charged, which is the failure that reaches a customer. Here every amount in the body is
 * extracted and compared against the permitted set, so a hallucinated £299, a stale £599, or a
 * list price quoted over a negotiated one are all caught by the same rule.
 *
 * `additionalGroundedAmounts` carries figures that are legitimately money but are not prices —
 * an approved ROI claim such as "recovers £18,000 monthly". Without it every such sentence
 * would be reported, and a check that cries wolf gets switched off.
 */
export function auditPricingClaims(
  body: string,
  permitted: readonly Money[],
  additionalGroundedAmounts: readonly Money[] = []
): PricingAuditFinding[] {
  const allowed = [...permitted, ...additionalGroundedAmounts];
  const findings: PricingAuditFinding[] = [];
  const seen = new Set<number>();

  for (const stated of extractMoneyLiterals(body)) {
    if (seen.has(stated.amountMinor)) continue;
    seen.add(stated.amountMinor);
    if (allowed.some((a) => sameMoney(a, stated))) continue;
    findings.push({
      stated,
      message:
        `The draft states ${formatMoney(stated)}, which is not a price this customer may be ` +
        'quoted. It is not in the price book, not on their quote, and not an approved figure.',
    });
  }

  return findings;
}

