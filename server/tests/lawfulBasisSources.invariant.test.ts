import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  OUTREACH_REGIMES,
  isReviewed,
  ruleFor,
  unreviewedCountries,
  type CountryRule,
} from '../domain/lawfulBasisSources';
import { evaluateLawfulBasis, regimeFor } from '../domain/lawfulBasis';

/**
 * THE COUNTRY TABLE, AND THE REVIEW NOBODY HAD DONE (§14).
 *
 * The table used to be six entries of regime-plus-prose under a comment reading "THIS TABLE
 * NEEDS LEGAL REVIEW BEFORE IT IS RELIED ON". That comment was true and it was also the entire
 * control: nothing stopped a seventh country being added with no source, and nothing anywhere
 * could tell a reviewed row from an unreviewed one.
 *
 * WHAT THIS SUITE OWNS
 * --------------------
 * 1. THE CITATION IS THE ROW. Every entry carries at least one instrument, provision and what
 *    that provision says. This is checked at runtime as well as in the type, because a `Record`
 *    cast anywhere upstream would make the type a suggestion.
 * 2. AN UNREVIEWED ROW REFUSES WHEN REAL SENDING IS ON, and works when it is not. Both halves
 *    matter: the first is the safety property, the second is why the safety property survives
 *    contact with a developer who needs to get something done today.
 * 3. THE DEFAULT IS THE PERMISSIVE ONE, DELIBERATELY, and the argument for that is written down
 *    where the option is declared. A test asserting only the strict half would pass on a version
 *    that broke every preview in the system.
 * 4. EVERY ROW STILL DENIES BY DEFAULT. A country absent from the table refuses; nothing
 *    inherits another country's rules.
 */

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const entries = Object.entries(OUTREACH_REGIMES) as [string, CountryRule][];

/** A contact that is mailable in GB on every axis except whatever a test changes. */
const MAILABLE = {
  lawfulBasis: 'LEGITIMATE_INTEREST',
  addressType: 'ROLE',
  country: 'GB',
  liaId: 'lia_1',
  email: 'info@analytical.example',
  article14NoticeSentAt: '2026-09-03T09:00:00.000Z',
};

describe('1. the citation is the row', () => {
  it('there is at least one country, and the suite is not vacuous', () => {
    expect(entries.length).toBeGreaterThanOrEqual(6);
  });

  it('every row cites at least one instrument, provision and what it says', () => {
    for (const [code, rule] of entries) {
      expect(Array.isArray(rule.sources), code).toBe(true);
      expect(rule.sources.length, code).toBeGreaterThanOrEqual(1);
      for (const source of rule.sources) {
        expect(source.instrument.trim(), `${code} instrument`).not.toBe('');
        expect(source.provision.trim(), `${code} provision`).not.toBe('');
        // Long enough to be a statement of what the provision says, rather than a restatement
        // of its own name. A citation that says "see the Act" cites nothing.
        expect(source.says.trim().length, `${code} says`).toBeGreaterThan(60);
      }
    }
  });

  it('every row names the questions a reviewer still has to answer', () => {
    for (const [code, rule] of entries) {
      expect(rule.openQuestions.length, code).toBeGreaterThanOrEqual(1);
      for (const question of rule.openQuestions) {
        expect(question.trim().length, code).toBeGreaterThan(40);
      }
    }
  });

  it('every row declares a confidence, and CONTESTED means what it says', () => {
    for (const [code, rule] of entries) {
      expect(['SETTLED', 'CONTESTED'], code).toContain(rule.confidence);
    }
    // At least one row is honestly marked contested. A table where everything is SETTLED is a
    // table whose author was not reading carefully.
    expect(entries.some(([, rule]) => rule.confidence === 'CONTESTED')).toBe(true);
  });

  it('a SETTLED marker is not a review, and nothing in the code treats it as one', () => {
    const settled = entries.filter(([, rule]) => rule.confidence === 'SETTLED');
    expect(settled.length).toBeGreaterThan(0);
    for (const [code] of settled) expect(isReviewed(code), code).toBe(false);
  });

  it('every regime is one of the three the gate knows how to apply', () => {
    for (const [code, rule] of entries) {
      expect(['GDPR_LI', 'OPT_OUT', 'CONSENT_REQUIRED'], code).toContain(rule.regime);
      expect(regimeFor(code)).toBe(rule.regime);
    }
  });
});

describe('2. review state is honest today', () => {
  it('no row is signed off, and the helpers say so', () => {
    // This test is expected to CHANGE when somebody records a real sign-off. It is here so that
    // recording one is a deliberate act with a failing test in front of it, rather than a line
    // that slides in unnoticed.
    expect(unreviewedCountries()).toEqual(entries.map(([code]) => code).sort());
    for (const [code] of entries) expect(isReviewed(code), code).toBe(false);
  });

  it('a review needs a name, a date and a traceable reference to count', () => {
    const source = readFileSync('server/domain/lawfulBasisSources.ts', 'utf8');
    const iface = source.slice(source.indexOf('export interface RegimeReview'), source.indexOf('export interface CountryRule'));
    for (const field of ['reviewedBy', 'reviewedAt', 'reference']) {
      expect(iface, field).toContain(`readonly ${field}: string;`);
    }
    // None of them optional: a sign-off missing its reference is indistinguishable from none.
    expect(iface).not.toMatch(/readonly (reviewedBy|reviewedAt|reference)\?:/);
  });

  it('ruleFor returns null for a country nobody has written, rather than a default', () => {
    expect(ruleFor('ZZ')).toBeNull();
    expect(regimeFor('ZZ')).toBeNull();
    expect(regimeFor('not a country')).toBeNull();
  });
});

describe('3. an unreviewed row refuses only when real sending is on', () => {
  it('works by default, which is what keeps development possible', () => {
    expect(evaluateLawfulBasis(MAILABLE).ok).toBe(true);
    expect(evaluateLawfulBasis(MAILABLE, {}).ok).toBe(true);
    expect(evaluateLawfulBasis(MAILABLE, { requireReviewedRegime: false }).ok).toBe(true);
  });

  it('refuses under the strict flag, naming the table and the way to fix it', () => {
    const verdict = evaluateLawfulBasis(MAILABLE, { requireReviewedRegime: true });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('COUNTRY_NOT_LEGALLY_REVIEWED');
    expect(verdict.message).toContain('lawfulBasisSources.ts');
    expect(verdict.message).toContain('legal-review-pack');
  });

  it('applies to CONSENT as well as to legitimate interest', () => {
    // An unreviewed row is unreviewed about consent too: what form Germany requires and what a
    // US footer must contain are exactly the particulars this catches.
    const consented = {
      lawfulBasis: 'CONSENT',
      country: 'GB',
      consentGiven: true,
      consentEvidence: 'webform:pricing 2026-09-01',
      consentRecordedBy: 'ops@abedin.example',
      email: 'ada@analytical.example',
    };
    expect(evaluateLawfulBasis(consented).ok).toBe(true);
    expect(evaluateLawfulBasis(consented, { requireReviewedRegime: true }).ok).toBe(false);
  });

  it('only the exact boolean true turns the check on, so a truthy value does not', () => {
    // Fail-closed goes the other way here: this is a check that makes things STRICTER, so an
    // ambiguous value must not silently enable it either. `=== true` is what the code asks.
    const loose = evaluateLawfulBasis(MAILABLE, { requireReviewedRegime: undefined });
    expect(loose.ok).toBe(true);
  });

  it('the strict check happens after the country is known and before the basis is read', () => {
    // An unknown country must still report COUNTRY_UNKNOWN rather than the review refusal:
    // telling somebody their rules are unreviewed when they never stated a country would send
    // them to fix the wrong thing.
    const nowhere = evaluateLawfulBasis({ ...MAILABLE, country: '' }, { requireReviewedRegime: true });
    expect(nowhere.ok).toBe(false);
    if (!nowhere.ok) expect(nowhere.code).toBe('COUNTRY_UNKNOWN');

    const unlisted = evaluateLawfulBasis({ ...MAILABLE, country: 'ZZ' }, { requireReviewedRegime: true });
    expect(unlisted.ok).toBe(false);
    if (!unlisted.ok) expect(unlisted.code).toBe('COUNTRY_NOT_REVIEWED');

    // And a contact with NO basis in an unreviewed country reports the review, because the
    // review is the more fundamental problem and fixing the basis would not help.
    const noBasis = evaluateLawfulBasis({ country: 'GB' }, { requireReviewedRegime: true });
    expect(noBasis.ok).toBe(false);
    if (!noBasis.ok) expect(noBasis.code).toBe('COUNTRY_NOT_LEGALLY_REVIEWED');
  });
});

describe('4. the table still denies by default', () => {
  it('a country outside the table refuses, whatever else the record says', () => {
    for (const country of ['ZZ', 'XX', 'AQ']) {
      const verdict = evaluateLawfulBasis({ ...MAILABLE, country });
      expect(verdict.ok, country).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe('COUNTRY_NOT_REVIEWED');
    }
  });

  it('a CONSENT_REQUIRED country refuses legitimate interest outright', () => {
    for (const [code, rule] of entries) {
      if (rule.regime !== 'CONSENT_REQUIRED') continue;
      const verdict = evaluateLawfulBasis({ ...MAILABLE, country: code });
      expect(verdict.ok, code).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe('LI_NOT_AVAILABLE_IN_COUNTRY');
    }
  });

  it('the table is frozen, so nothing can add a country at runtime', () => {
    expect(Object.isFrozen(OUTREACH_REGIMES)).toBe(true);
  });
});

describe('5. the source says what the tests say', () => {
  const gate = stripComments(readFileSync('server/domain/lawfulBasis.ts', 'utf8'));

  it('there is exactly one country table, re-exported rather than copied', () => {
    // Two tables is two answers to "what are the rules in Germany", and the one that loses is
    // whichever the gate does not read.
    expect(gate).toContain("from './lawfulBasisSources'");
    // The table is not DECLARED here. `[^=]*` across a whole file matches almost anything, so
    // this looks for the declaration form itself rather than for a shape near the name.
    expect(gate).not.toMatch(/(const|let|var)\s+OUTREACH_REGIMES/);
  });

  it('the review refusal reads entry.review, not a separate list that could drift', () => {
    // The FIRST occurrence is in the refusal-code union; the check is the last one.
    const at = gate.lastIndexOf('COUNTRY_NOT_LEGALLY_REVIEWED');
    expect(at).toBeGreaterThan(gate.indexOf('COUNTRY_NOT_LEGALLY_REVIEWED'));
    expect(gate.slice(Math.max(0, at - 300), at)).toContain('entry.review === null');
    // And the condition is on the option AND the row, so neither half alone can refuse.
    expect(gate.slice(Math.max(0, at - 300), at)).toContain("options.requireReviewedRegime === true");
  });
});
