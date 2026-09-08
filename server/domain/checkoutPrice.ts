/**
 * S25 / P0.15 — THE ONLY AMOUNT THIS SYSTEM CAN CHARGE ANYBODY, AND WHERE IT COMES FROM.
 *
 * WHAT WAS WRONG
 * --------------
 * `server/routes/stripe.routes.ts` built its checkout session with
 * `unit_amount: 500000, currency: 'usd'` — a hardcoded USD $5,000, for a product every other
 * part of this system prices at £499/mo.
 *
 * Three separate problems in that one line, and the third is the reason this module exists.
 *
 *   1. It is not in the price book. P1.7 established `shared/domain/pricing.ts` as the one
 *      module permitted to contain a price, because the figure had been written down in eleven
 *      places as prose and they did not agree.
 *   2. It is in a CURRENCY the price book does not model. `CURRENCIES` is `['GBP']`, so the
 *      charge is not merely a different number — it is denominated in something the rest of the
 *      system has no representation for.
 *   3. `check-single-price-source` could not see it. That guardrail's detector is `/£\s?\d/`,
 *      so it catches every prose price and is blind to the only figure that can actually move
 *      money. A control that cannot see the live path is the thing this audit keeps finding.
 *
 * WHY THIS DOES NOT SIMPLY SET THE RIGHT PRICE
 * -------------------------------------------
 * Because I do not know it. "Enterprise Onboarding" at $5,000 may be a legitimate one-off that
 * has nothing to do with the £499/mo subscription tier, or it may be a leftover from a template.
 * Choosing between those is a commercial decision, and inventing a number here would be exactly
 * the failure the price book was built to stop — a figure that looks authoritative because it is
 * in code.
 *
 * So the amount becomes CONFIGURATION WITH NO DEFAULT, and the checkout refuses without it.
 * That is the same move P0.0 made with the committed credential file: a value that must be
 * decided is not a value to hardcode, and refusing is what makes the decision happen rather
 * than being inherited.
 *
 * FAIL CLOSED, INDEPENDENTLY OF THE FLAG
 * --------------------------------------
 * `REAL_PAYMENT_ENABLED` is false and the route already refuses on it. This is a second,
 * independent refusal, because the failure being prevented is somebody enabling payments — the
 * one deliberate act that turns this on — and thereby charging a stranger $5,000 that nobody
 * chose. A flag flip should not be able to do that on its own.
 */

/** Amounts are integers in MINOR units — cents, pence — for the reason `pricing.ts` records. */
export interface CheckoutPrice {
  readonly minorUnits: number;
  /** ISO 4217, lowercase, as Stripe expects it. */
  readonly currency: string;
}

export type CheckoutPriceResolution =
  | { readonly ok: true; readonly price: CheckoutPrice }
  | { readonly ok: false; readonly reason: string };

/** Above this, a misplaced digit is a five-figure charge. Deliberately not a business rule. */
export const MAX_MINOR_UNITS = 10_000_00;

const MISSING =
  'Checkout is not configured. STRIPE_CHECKOUT_MINOR_UNITS (an integer in minor units — ' +
  'pence or cents) and STRIPE_CHECKOUT_CURRENCY (ISO 4217) must both be set. There is no ' +
  'default: this route used to carry a hardcoded amount in a currency the price book does ' +
  'not model, for a product priced from shared/domain/pricing.ts everywhere else. A number ' +
  'nobody chose is not a number to charge anybody.';

/**
 * The amount to charge, from the environment, or the reason there is not one.
 *
 * Read at CALL time rather than at module load, for the reason S46 records: ES module imports
 * are hoisted above `dotenv.config()`, so a module-level snapshot reads the value from before
 * `.env` was loaded.
 */
export function checkoutPriceFrom(
  env: NodeJS.ProcessEnv = process.env
): CheckoutPriceResolution {
  const rawAmount = typeof env.STRIPE_CHECKOUT_MINOR_UNITS === 'string'
    ? env.STRIPE_CHECKOUT_MINOR_UNITS.trim()
    : '';
  const rawCurrency = typeof env.STRIPE_CHECKOUT_CURRENCY === 'string'
    ? env.STRIPE_CHECKOUT_CURRENCY.trim().toLowerCase()
    : '';

  if (rawAmount.length === 0 || rawCurrency.length === 0) {
    return { ok: false, reason: MISSING };
  }

  // `/^\d+$/` and not `parseInt`: `parseInt('500000abc')` is 500000, and `Number('5e5')` is
  // 500000 as well. Money read from a string should refuse anything that is not the digits of
  // an integer, because every lenient parse here has a reading in which somebody is charged a
  // number they did not write.
  if (!/^\d+$/.test(rawAmount)) {
    return {
      ok: false,
      reason:
        `STRIPE_CHECKOUT_MINOR_UNITS must be a whole number of minor units; received ` +
        `${JSON.stringify(rawAmount)}. Decimals are refused because "4.99" is ambiguous ` +
        'between pounds and pence, and one of those readings is a hundredfold error.',
    };
  }

  const minorUnits = Number(rawAmount);
  if (minorUnits <= 0) {
    return { ok: false, reason: 'STRIPE_CHECKOUT_MINOR_UNITS must be greater than zero.' };
  }
  if (minorUnits > MAX_MINOR_UNITS) {
    return {
      ok: false,
      reason:
        `STRIPE_CHECKOUT_MINOR_UNITS is ${minorUnits} minor units, above the ${MAX_MINOR_UNITS} ` +
        'ceiling. This is a typo guard, not a business rule: raise it deliberately in ' +
        'server/domain/checkoutPrice.ts if the charge really is that large.',
    };
  }

  if (!/^[a-z]{3}$/.test(rawCurrency)) {
    return {
      ok: false,
      reason:
        `STRIPE_CHECKOUT_CURRENCY must be a three-letter ISO 4217 code; received ` +
        `${JSON.stringify(rawCurrency)}.`,
    };
  }

  return { ok: true, price: { minorUnits, currency: rawCurrency } };
}
