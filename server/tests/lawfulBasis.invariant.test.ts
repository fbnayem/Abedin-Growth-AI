import { describe, it, expect } from 'vitest';
import {
  ADDRESS_TYPES,
  LAWFUL_BASES,
  OUTREACH_REGIMES,
  evaluateLawfulBasis,
  normaliseCountry,
  regimeFor,
  type BasisFacts,
} from '../domain/lawfulBasis';

/**
 * INVARIANTS (addendum §14, §26).
 *
 * §14 Unknown is never permission. Not an unknown basis, not an unknown country, not an
 *     unknown address type, not a consent flag that is merely truthy.
 * §26 A recipient may be sent commercial email only when a lawful basis is PROVEN. The
 *     default for every path through this function is refusal.
 *
 * WHY THIS SUITE EXISTS AT ALL
 * ---------------------------
 * The gate it replaces was a single `consentGiven !== true`. That was correct and it was also
 * unreachable: nothing in the system could set the field, so every lead was permanently
 * unmailable. Widening a safety gate is exactly where a regression would be invisible — the
 * product would start working, which looks like success — so every widening below is pinned to
 * the condition that justifies it.
 */

/** A contact that passes on CONSENT. Tests below remove exactly one thing from it. */
const CONSENTED: BasisFacts = {
  lawfulBasis: 'CONSENT',
  country: 'GB',
  consentGiven: true,
  consentEvidence: 'webform:pricing-page 2026-09-01T10:00:00.000Z ip=203.0.113.7',
  consentRecordedBy: 'operator:alice@abedin.example',
};

/** A contact that passes on LEGITIMATE_INTEREST. Tests below remove exactly one thing. */
const LEGITIMATE: BasisFacts = {
  lawfulBasis: 'LEGITIMATE_INTEREST',
  country: 'GB',
  addressType: 'ROLE',
  liaId: 'lia_2026_q3_uk_b2b',
  article14NoticeSentAt: '2026-09-02T09:00:00.000Z',
};

function refusal(facts: BasisFacts) {
  const verdict = evaluateLawfulBasis(facts);
  if (verdict.ok) throw new Error(`expected a refusal, got: ${JSON.stringify(verdict)}`);
  return verdict;
}

describe('lawful basis: the default is refusal', () => {
  it('an empty record refuses', () => {
    expect(refusal({}).code).toBe('COUNTRY_UNKNOWN');
  });

  it('a record with a country and nothing else refuses for want of a basis', () => {
    expect(refusal({ country: 'GB' }).code).toBe('NO_BASIS');
  });

  it('every refusal carries a message that names what is missing', () => {
    const cases: BasisFacts[] = [
      {},
      { country: 'GB' },
      { country: 'GB', lawfulBasis: 'VIBES' },
      { ...CONSENTED, consentGiven: undefined },
      { ...LEGITIMATE, liaId: undefined },
    ];
    for (const facts of cases) {
      const verdict = refusal(facts);
      expect(verdict.message.length).toBeGreaterThan(20);
    }
  });
});

describe('lawful basis: the country decides what is even available', () => {
  it('a missing or malformed country refuses rather than assuming a permissive one', () => {
    for (const country of [undefined, null, '', '  ', 'GBR', 'United Kingdom', 'g', 42, {}]) {
      expect(refusal({ ...CONSENTED, country }).code).toBe('COUNTRY_UNKNOWN');
    }
  });

  it('a country nobody has reviewed refuses rather than inheriting another country\'s rules', () => {
    // Deliberately a real ISO code that is absent from the table.
    expect(OUTREACH_REGIMES.JP).toBeUndefined();
    expect(refusal({ ...CONSENTED, country: 'JP' }).code).toBe('COUNTRY_NOT_REVIEWED');
  });

  it('normaliseCountry accepts only an ISO-3166 alpha-2 code, case-insensitively', () => {
    expect(normaliseCountry('gb')).toBe('GB');
    expect(normaliseCountry(' us ')).toBe('US');
    expect(normaliseCountry('GBR')).toBeNull();
    expect(normaliseCountry(undefined)).toBeNull();
  });

  it('every entry in the table is a valid code carrying a stated reason', () => {
    for (const [code, entry] of Object.entries(OUTREACH_REGIMES)) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(['GDPR_LI', 'OPT_OUT', 'CONSENT_REQUIRED']).toContain(entry.regime);
      expect(entry.note.length).toBeGreaterThan(20);
    }
  });

  it('regimeFor answers null for an unreviewed or malformed country', () => {
    expect(regimeFor('GB')).toBe('GDPR_LI');
    expect(regimeFor('JP')).toBeNull();
    expect(regimeFor('nonsense')).toBeNull();
  });
});

describe('lawful basis: CONSENT', () => {
  it('a complete consent record passes', () => {
    const verdict = evaluateLawfulBasis(CONSENTED);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.basis).toBe('CONSENT');
  });

  it('a merely truthy consent flag is not consent', () => {
    // This is the §14 property in its sharpest form. Each of these would pass a `!!` test.
    for (const value of ['true', 'yes', 1, 'TRUE', [], {}, 'consented']) {
      expect(refusal({ ...CONSENTED, consentGiven: value }).code).toBe('CONSENT_NOT_RECORDED');
    }
  });

  it('a revocation outranks the consent, whatever order they were recorded in', () => {
    const verdict = refusal({ ...CONSENTED, consentRevokedAt: '2026-09-10T12:00:00.000Z' });
    expect(verdict.code).toBe('CONSENT_REVOKED');
  });

  it('consent without evidence does not count', () => {
    expect(refusal({ ...CONSENTED, consentEvidence: undefined }).code).toBe('CONSENT_UNEVIDENCED');
    expect(refusal({ ...CONSENTED, consentEvidence: '   ' }).code).toBe('CONSENT_UNEVIDENCED');
  });

  it('consent without an identified actor does not count', () => {
    expect(refusal({ ...CONSENTED, consentRecordedBy: undefined }).code).toBe('CONSENT_UNATTRIBUTED');
  });

  it('consent works in a country where legitimate interest does not', () => {
    const verdict = evaluateLawfulBasis({ ...CONSENTED, country: 'DE' });
    expect(verdict.ok).toBe(true);
  });
});

describe('lawful basis: LEGITIMATE_INTEREST', () => {
  it('a complete legitimate-interest record passes', () => {
    const verdict = evaluateLawfulBasis(LEGITIMATE);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.basis).toBe('LEGITIMATE_INTEREST');
  });

  it('it is unavailable in a country that requires consent', () => {
    for (const country of ['DE', 'CA']) {
      expect(OUTREACH_REGIMES[country].regime).toBe('CONSENT_REQUIRED');
      expect(refusal({ ...LEGITIMATE, country }).code).toBe('LI_NOT_AVAILABLE_IN_COUNTRY');
    }
  });

  it('an unstated address type is treated as personal and refuses', () => {
    for (const addressType of [undefined, null, '', 'business', 'CORPORATE', 7]) {
      expect(refusal({ ...LEGITIMATE, addressType }).code).toBe('LI_PERSONAL_ADDRESS');
    }
  });

  it('it refuses without a balancing assessment on file', () => {
    expect(refusal({ ...LEGITIMATE, liaId: undefined }).code).toBe('LI_NO_ASSESSMENT');
  });

  it('it refuses until the data-subject notice has been sent', () => {
    expect(refusal({ ...LEGITIMATE, article14NoticeSentAt: undefined }).code).toBe('LI_NOTICE_NOT_SENT');
    expect(refusal({ ...LEGITIMATE, article14NoticeSentAt: '  ' }).code).toBe('LI_NOTICE_NOT_SENT');
  });

  it('a personal address is permitted only because it is declared, not assumed', () => {
    // PERSONAL is a legal declaration, not a bypass: the country regime still governs, and the
    // notice and assessment are still required. What is refused is an UNSTATED type.
    const verdict = evaluateLawfulBasis({ ...LEGITIMATE, addressType: 'PERSONAL' });
    expect(verdict.ok).toBe(true);
    expect(ADDRESS_TYPES).toContain('PERSONAL');
  });
});

describe('lawful basis: no path grants permission without a recognised basis', () => {
  it('an unrecognised basis string always refuses, however complete the rest is', () => {
    for (const basis of ['consent', 'Consent', 'LEGIT', 'CONTRACT', 'VITAL_INTERESTS', '', 0, null]) {
      const verdict = refusal({ ...CONSENTED, ...LEGITIMATE, lawfulBasis: basis });
      expect(['NO_BASIS', 'UNKNOWN_BASIS']).toContain(verdict.code);
    }
  });

  it('every basis that can pass is one of the declared ones', () => {
    const passing = [CONSENTED, LEGITIMATE]
      .map((facts) => evaluateLawfulBasis(facts))
      .filter((v) => v.ok);
    expect(passing).toHaveLength(2);
    for (const verdict of passing) {
      if (verdict.ok) expect(LAWFUL_BASES).toContain(verdict.basis);
    }
  });

  it('a passing verdict always says why, so a send can be explained afterwards', () => {
    for (const facts of [CONSENTED, LEGITIMATE]) {
      const verdict = evaluateLawfulBasis(facts);
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        expect(verdict.why.length).toBeGreaterThan(20);
        expect(verdict.regime).toBeTruthy();
      }
    }
  });
});
