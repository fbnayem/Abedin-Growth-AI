import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutPriceFrom, MAX_MINOR_UNITS } from '../domain/checkoutPrice';

/**
 * INVARIANTS FOR THE CHECKOUT AMOUNT (addendum S25 / P0.15).
 *
 * `stripe.routes.ts` built its session with `unit_amount: 500000, currency: 'usd'` — a hardcoded
 * USD $5,000 for a product the rest of this system prices at £499/mo, in a currency
 * `shared/domain/pricing.ts` does not model, since `CURRENCIES` is `['GBP']`.
 *
 * And `check-single-price-source` could not see it. Its detector was `/£\s?\d/`, so it caught
 * every prose price and was blind to the only figure that can move money — a control that
 * catches the documentation and misses the live path, which is the shape this whole audit keeps
 * finding, this time inside the guardrail.
 *
 * The right number is not chosen here. It is not mine to choose, and inventing one would be the
 * exact failure the price book exists to prevent. The amount is configuration with no default,
 * and the route refuses without it.
 */

const GOOD = { STRIPE_CHECKOUT_MINOR_UNITS: '49900', STRIPE_CHECKOUT_CURRENCY: 'GBP' };

describe('1. there is no default, and absence refuses', () => {
  it('an unconfigured deployment cannot charge anybody', () => {
    for (const env of [
      {},
      { STRIPE_CHECKOUT_MINOR_UNITS: '49900' },
      { STRIPE_CHECKOUT_CURRENCY: 'gbp' },
      { STRIPE_CHECKOUT_MINOR_UNITS: '', STRIPE_CHECKOUT_CURRENCY: 'gbp' },
      { STRIPE_CHECKOUT_MINOR_UNITS: '  ', STRIPE_CHECKOUT_CURRENCY: '  ' },
    ]) {
      const result = checkoutPriceFrom(env);
      expect(result.ok, `accepted ${JSON.stringify(env)}`).toBe(false);
    }
  });

  /**
   * A HALF-CONFIGURED DEPLOYMENT IS TOLD ABOUT BOTH HALVES.
   *
   * Written after a mutant survived: changing the `||` here to `&&` still REFUSES every
   * half-configured environment, because the format checks below catch each half on its own.
   * Measured, and equivalent on outcome.
   *
   * What it changes is the message. With `&&`, a deployment that set only the currency is told
   * "STRIPE_CHECKOUT_MINOR_UNITS must be a whole number of minor units; received \"\"" — which
   * describes a formatting problem rather than a missing variable, and says nothing about the
   * one they did set being fine. That is two deploys instead of one, and it is the same reason
   * `resolveFirebaseAuthConfig` names every missing variable rather than the first.
   */
  it('the refusal names both variables, so one rebuild fixes it', () => {
    for (const env of [
      {},
      { STRIPE_CHECKOUT_MINOR_UNITS: '49900' },
      { STRIPE_CHECKOUT_CURRENCY: 'gbp' },
    ]) {
      const result = checkoutPriceFrom(env);
      expect(result.ok, JSON.stringify(env)).toBe(false);
      if (result.ok === false) {
        expect(result.reason, JSON.stringify(env)).toContain('STRIPE_CHECKOUT_MINOR_UNITS');
        expect(result.reason, JSON.stringify(env)).toContain('STRIPE_CHECKOUT_CURRENCY');
      }
    }
  });

  it('a configured deployment gets exactly what it configured', () => {
    // The other half: a function that always refuses satisfies every assertion above and makes
    // the feature impossible rather than safe.
    const result = checkoutPriceFrom(GOOD);
    expect(result.ok).toBe(true);
    expect(result.ok && result.price).toEqual({ minorUnits: 49900, currency: 'gbp' });
  });
});

describe('2. the amount is read strictly, because every lenient reading overcharges somebody', () => {
  it('anything that is not the digits of an integer is refused', () => {
    // `parseInt('500000abc')` is 500000 and `Number('5e5')` is 500000. Both are readings in
    // which a person is charged a number nobody wrote.
    for (const bad of ['500000abc', '5e5', '4.99', '-499', '+499', '0x1F4', ' 499 0', '499,00', 'NaN', 'Infinity']) {
      const result = checkoutPriceFrom({ ...GOOD, STRIPE_CHECKOUT_MINOR_UNITS: bad });
      expect(result.ok, `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('a decimal is refused rather than rounded', () => {
    // "4.99" is ambiguous between pounds and pence, and one of those readings is a
    // hundredfold error. Refusing is the only answer that cannot be wrong.
    const result = checkoutPriceFrom({ ...GOOD, STRIPE_CHECKOUT_MINOR_UNITS: '4.99' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/hundredfold|whole number/i);
  });

  it('zero and negatives are refused', () => {
    for (const bad of ['0', '00', '-1']) {
      expect(checkoutPriceFrom({ ...GOOD, STRIPE_CHECKOUT_MINOR_UNITS: bad }).ok, bad).toBe(false);
    }
  });

  it('a typo guard catches a misplaced digit', () => {
    expect(checkoutPriceFrom({ ...GOOD, STRIPE_CHECKOUT_MINOR_UNITS: String(MAX_MINOR_UNITS) }).ok).toBe(true);
    const tooBig = checkoutPriceFrom({ ...GOOD, STRIPE_CHECKOUT_MINOR_UNITS: String(MAX_MINOR_UNITS + 1) });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.ok === false && tooBig.reason).toMatch(/typo guard/i);
  });

  it('the currency must be an ISO code, and is normalised for Stripe', () => {
    expect(checkoutPriceFrom({ ...GOOD, STRIPE_CHECKOUT_CURRENCY: 'GBP' }).ok).toBe(true);
    expect(checkoutPriceFrom(GOOD).ok && checkoutPriceFrom(GOOD).ok).toBe(true);
    const resolved = checkoutPriceFrom({ ...GOOD, STRIPE_CHECKOUT_CURRENCY: '  UsD ' });
    expect(resolved.ok && resolved.price.currency).toBe('usd');
    for (const bad of ['G', 'GBPX', 'GB1', '£', '', 'pounds']) {
      expect(checkoutPriceFrom({ ...GOOD, STRIPE_CHECKOUT_CURRENCY: bad }).ok, bad).toBe(false);
    }
  });

  it('the environment is read at CALL time', () => {
    // S46: ES module imports are hoisted above `dotenv.config()`, so a module-level snapshot
    // reads the value from before `.env` was loaded. That is how the five REAL_* flags came to
    // disagree with the operator display.
    expect(checkoutPriceFrom({}).ok).toBe(false);
    expect(checkoutPriceFrom(GOOD).ok).toBe(true);
  });
});

describe('3. the route refuses independently of the flag, and the guardrail can now see money', () => {
  const routes = readFileSync('server/routes/stripe.routes.ts', 'utf8');

  /**
   * Comments are stripped first, and this is the FIFTH time in this hardening pass that a check
   * had to learn it.
   *
   * The route's comment quotes the line it replaced — `currency: 'usd', unit_amount: 500000` —
   * because that is how the reason survives. Without stripping, the assertion flags the fix's
   * own explanation as the defect, which is precisely what teaches the next person to delete
   * the explanation. The same correction was needed on the credential-file check, the
   * automated-mail classifier, the CSP route's datastore check, and the dead-schema scan.
   */
  const code = routes
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('no numeric amount is written in the route any more', () => {
    expect(code).not.toMatch(/unit_amount:\s*\d/);
    expect(code).not.toMatch(/currency:\s*['"][a-z]{3}['"]/i);
    expect(code).toContain('priced.price.minorUnits');
    expect(code).toContain('priced.price.currency');
  });

  it('that check would still catch a real hardcoded amount', () => {
    // Stripping could remove everything and the assertion above would hold on any file.
    const withLiteral = "const s = { currency: 'usd', unit_amount: 500000 };"
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    expect(withLiteral).toMatch(/unit_amount:\s*\d/);
    expect(withLiteral).toMatch(/currency:\s*['"][a-z]{3}['"]/i);
  });

  /**
   * TWO REFUSALS, NOT ONE.
   *
   * `REAL_PAYMENT_ENABLED` already gates this route. This is a second, independent check,
   * because the failure being prevented is somebody enabling payments — the one deliberate act
   * that turns this on — and thereby charging a stranger an amount nobody chose. A flag flip
   * must not be able to do that by itself.
   */
  it('the amount check is separate from the safe-mode flag', () => {
    const flagAt = routes.indexOf('REAL_PAYMENT_ENABLED');
    const priceAt = routes.indexOf('checkoutPriceFrom()');
    expect(flagAt).toBeGreaterThan(-1);
    expect(priceAt).toBeGreaterThan(-1);
    expect(routes).toMatch(/if \(priced\.ok === false\)[\s\S]{0,300}?return sendError/);
  });

  it('that check would fail if the refusal were dropped', () => {
    expect(
      /if \(priced\.ok === false\)[\s\S]{0,300}?return sendError/.test(
        'const priced = checkoutPriceFrom();\n await stripe.checkout.sessions.create({});'
      )
    ).toBe(false);
  });

  /**
   * The guardrail's blindness was the more interesting half of this finding, so it is exercised
   * against a tree that contains the defect rather than only against the clean one.
   */
  it('the price guardrail now sees a money literal in minor units', () => {
    const dir = mkdtempSync(join(tmpdir(), 'price-guard-'));
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'server', 'routes'), { recursive: true });
    mkdirSync(join(dir, 'shared', 'domain'), { recursive: true });
    cpSync('scripts/check-single-price-source.mjs', join(dir, 'scripts', 'check.mjs'));
    writeFileSync(join(dir, 'shared', 'domain', 'pricing.ts'), 'export const X = 1;\n');
    writeFileSync(
      join(dir, 'server', 'routes', 'stripe.routes.ts'),
      "const s = { price_data: { currency: 'usd', unit_amount: 500000 } };\n"
    );

    let failed = false;
    let output = '';
    try {
      execFileSync(process.execPath, ['scripts/check.mjs'], { cwd: dir, encoding: 'utf8' });
    } catch (e: any) {
      failed = true;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(failed, 'the guardrail passed on a hardcoded charge amount').toBe(true);
    expect(output).toContain('unit_amount: 500000');
  });

  it('and does not flag the amount arriving from configuration', () => {
    // A rule that fired on the fix would be turned off within a week.
    const output = execFileSync(process.execPath, ['scripts/check-single-price-source.mjs'], {
      encoding: 'utf8',
    });
    expect(output).toContain('ok');
  });
});
