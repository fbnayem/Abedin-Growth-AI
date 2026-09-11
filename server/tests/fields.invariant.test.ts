import { INVESTOR_STAGES, INVESTOR_STATUSES, LEAD_STATUSES, memberOf } from '../../shared/domain/enums';
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fieldOf, flagField, numberField, stringField } from '../lib/fields';

/**
 * INVARIANTS FOR READING A STORED FIELD, AND FOR THE RATCHET ON `as any`.
 *
 * `DocumentSnapshot.data()` is `Record<string, unknown>`, because a document is whatever was written
 * to it — possibly by an older build. Eight call sites reached for a cast to get past that:
 *
 *     const status = (snap.data() as any)?.status;
 *     const raw = (snap.data() as any)?.inboundVersion;
 *
 * The cast does not make the value a string. It makes the compiler stop asking, and everything
 * downstream is then unchecked — which is how `d.accessToken` came to be compared against
 * `'mock_token'` while holding a number: a comparison that could never match, on a value that could
 * never work.
 *
 * The count of remaining casts is held by `scripts/check-no-new-casts.mjs`. Its first measurement
 * was wrong for an instructive reason: a plain `grep -c "as any"` over live code reported 67, and
 * the real number was 40. The difference was comments — the ones this codebase writes to record a
 * defect it has already fixed, quoting the cast that caused it. A rule that counts those punishes
 * the explanation.
 */

describe('1. a field is read, not asserted', () => {
  it('returns the stored value, and undefined when there is none', () => {
    expect(fieldOf({ status: 'ACTIVE' }, 'status')).toBe('ACTIVE');
    expect(fieldOf({}, 'status')).toBeUndefined();
  });

  it('reads nothing off a value that is not an object', () => {
    for (const value of [null, undefined, 42, 'ACTIVE', true]) {
      expect(fieldOf(value, 'status'), JSON.stringify(value) ?? 'undefined').toBeUndefined();
    }
  });

  it('does not read the prototype', () => {
    // `'toString' in {}` is true, and a bare index returns a function. A document that does not
    // carry `status` must not acquire one from Object.
    expect(fieldOf({}, 'toString')).toBeUndefined();
    expect(fieldOf({}, 'constructor')).toBeUndefined();
    expect(fieldOf({}, '__proto__')).toBeUndefined();
  });
});

describe('2. the typed readers answer null rather than lying', () => {
  it('stringField', () => {
    expect(stringField({ status: 'ACTIVE' }, 'status')).toBe('ACTIVE');
    expect(stringField({ status: 42 }, 'status')).toBeNull();
    expect(stringField({ status: null }, 'status')).toBeNull();
    expect(stringField({}, 'status')).toBeNull();
  });

  it('numberField refuses a numeric string', () => {
    // These fields are written as numbers by this system. Accepting "3" would let a document
    // written by something else decide a version comparison.
    expect(numberField({ v: 3 }, 'v')).toBe(3);
    expect(numberField({ v: '3' }, 'v')).toBeNull();
    expect(numberField({ v: Number.NaN }, 'v')).toBeNull();
    expect(numberField({ v: Number.POSITIVE_INFINITY }, 'v')).toBeNull();
  });

  it('flagField is true only for true', () => {
    // `unsubscribed: "false"` is a string, and every truthiness test in this repository would read
    // it as consent to keep sending.
    expect(flagField({ f: true }, 'f')).toBe(true);
    for (const value of ['true', 1, {}, [], 'yes']) {
      expect(flagField({ f: value }, 'f'), JSON.stringify(value)).toBe(false);
    }
    expect(flagField({}, 'f')).toBe(false);
  });
});

describe('3. the ratchet is wired, and it passes here', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

  it('runs as part of the gate', () => {
    expect(pkg.scripts.guardrails).toContain('check-no-new-casts.mjs');
  });

  it('and the tree is at its baseline', () => {
    // The proof that it CATCHES a new cast is the mutation run, not this: a mutant adds one and
    // the gate fails. Asserting a clean tree here only shows the count has not risen.
    const output = execFileSync(process.execPath, ['scripts/check-no-new-casts.mjs'], {
      encoding: 'utf8',
    });
    expect(output).toContain('ok');
  });
});

describe('4. the casts that came out of the security-relevant paths stay out', () => {
  const strip = (path: string) =>
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('the rate limiter reads the declared request fields', () => {
    const code = strip('server/middleware/rateLimit.ts');
    expect(code).not.toContain('(req as any)');
    expect(code).toContain('req.tenant');
    expect(code).toContain('req.user');
  });

  it('the kill switch writes its record without one', () => {
    expect(strip('server/services/circuitBreaker.service.ts')).not.toContain('record as any');
  });

  it('the tenant revocation check reads status through a narrowing reader', () => {
    const code = strip('server/middleware/tenant.ts');
    expect(code).not.toMatch(/snap\.data\(\) as any/);
    expect(code).toContain("stringField(snap.data(), 'status')");
  });

  it('and the draft-integrity version is read the same way', () => {
    const code = strip('server/services/draftIntegrity.service.ts');
    expect(code).not.toMatch(/snap\.data\(\) as any/);
    expect(code).toContain("fieldOf(snap.data(), 'inboundVersion')");
  });
});

describe('5. a union the system can check at runtime', () => {
  const strip = (path: string) =>
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*/g, '$1 ');

  it('a member passes through', () => {
    expect(memberOf(INVESTOR_STAGES, 'SEED', 'PRE_SEED')).toBe('SEED');
    expect(memberOf(LEAD_STATUSES, 'WON', 'NEW')).toBe('WON');
  });

  it('anything else becomes the fallback the caller chose', () => {
    for (const value of ['Series A', 'PROSPECTING', '', null, undefined, 42, {}, []]) {
      expect(
        memberOf(INVESTOR_STATUSES, value, 'DISCOVERED'),
        JSON.stringify(value) ?? 'undefined'
      ).toBe('DISCOVERED');
    }
  });

  it('near-misses are NOT repaired, deliberately', () => {
    // "seed" does not become SEED. These values arrive from a model, and quietly accepting a
    // near-miss is how one state comes to be spelled four ways in one table. A fallback is visible
    // in the record; a coerced value is not.
    expect(memberOf(INVESTOR_STAGES, 'seed', 'PRE_SEED')).toBe('PRE_SEED');
    expect(memberOf(INVESTOR_STAGES, ' SEED ', 'PRE_SEED')).toBe('PRE_SEED');
  });

  it('the three discovery agents validate model output instead of asserting it', () => {
    const sites: [string, string][] = [
      ['server/agents/investorAgent.ts', 'memberOf(INVESTOR_STATUSES, item.status'],
      ['server/agents/partnerAgent.ts', 'memberOf(PARTNER_STATUSES, item.status'],
      ['server/agents/leadScoringAgent.ts', 'memberOf(LEAD_STATUSES, item.status'],
    ];
    for (const [path, needle] of sites) {
      const code = strip(path);
      expect(code, path).toContain(needle);
      expect(code, path).not.toMatch(/status: \(item\.status as any\)/);
    }
  });
});
