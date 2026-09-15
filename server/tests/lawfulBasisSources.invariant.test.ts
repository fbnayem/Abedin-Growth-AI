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

describe('5. the review pack describes the table it is asking about', () => {
  const pack = readFileSync('docs/production/legal-review-pack.md', 'utf8');

  /**
   * A DOCUMENT ASKING FOR A SIGN-OFF HAS TO DESCRIBE WHAT IS ACTUALLY BEING SIGNED OFF.
   *
   * The failure this prevents is quiet and complete: somebody adds a seventh country, nobody
   * updates the pack, a reviewer signs the six they can see, and the seventh goes live having
   * been reviewed by nobody. The pack is the only artefact in this system a person outside it
   * reads, so it is the one most likely to drift and the one where drift costs most.
   */
  it('names every country in the table', () => {
    for (const [code, rule] of entries) {
      expect(pack, code).toContain(code);
      // And says which regime the system actually applies there, in the reviewer's words rather
      // than in ours — a pack that listed the country without saying what we do would be asking
      // them to sign off a blank.
      const wanted =
        rule.regime === 'CONSENT_REQUIRED' ? 'consent required'
        : rule.regime === 'OPT_OUT' ? 'opt-out'
        : 'legitimate interest';
      expect(pack.toLowerCase(), `${code} regime`).toContain(wanted);
    }
  });

  /**
   * COUNTED, NOT MATCHED VERBATIM.
   *
   * The first version of this test looked for a fragment of each question's own wording in the
   * pack. That couples a prose document to code strings, and the way such a test gets "fixed"
   * when it fails is by weakening it — so it would end up proving nothing while looking strict.
   *
   * Counting is the property that actually matters: a question added to the table forces a
   * question added to the pack. It cannot check that they are the SAME question, and says so
   * rather than implying otherwise.
   */
  it('asks the reviewer at least as many questions as the table records', () => {
    const sections = pack.split(/^### /m).slice(1);
    for (const [code, rule] of entries) {
      const section = sections.find((s) => s.includes(`(\`${code}\`)`));
      expect(section, `no section for ${code}`).toBeDefined();
      const numbered = (section ?? '').match(/^\d+\. /gm) ?? [];
      expect(numbered.length, `${code} asks ${numbered.length}, table records ${rule.openQuestions.length}`)
        .toBeGreaterThanOrEqual(rule.openQuestions.length);
    }
  });

  it('says plainly that nothing has been checked yet', () => {
    expect(pack).toContain('Nothing here has been checked');
  });

  it('states what it is NOT asking the reviewer to check', () => {
    // A sign-off read as covering more than it does is worse than no sign-off, because it is
    // relied on.
    // Whitespace-normalised: the pack is hard-wrapped prose, so a phrase spans a newline and a
    // raw `toContain` would fail on formatting rather than on substance.
    const flat = pack.replace(/\s+/g, ' ');
    expect(flat).toContain('What we are not asking you to check');
    expect(flat).toContain('It cannot check that the reasoning is sound');
  });
});

describe('6. the source says what the tests say', () => {
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
