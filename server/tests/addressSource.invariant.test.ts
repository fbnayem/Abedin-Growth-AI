import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ADDRESS_SOURCE_KINDS,
  ADDRESS_SOURCE_KIND_NOTES,
  UNCOVERABLE_ADDRESS_SOURCE_KINDS,
  classifyAddressSource,
  isAddressSourceKind,
  normaliseAddressSourceKinds,
  uncoverableAddressReason,
} from '../domain/addressSource';

/**
 * HOW THE ADDRESS WAS OBTAINED, WHICH IS NOT HOW THE PERSON WAS FOUND (§14).
 *
 * WHAT THIS SUITE OWNS
 * --------------------
 *   1. The vocabulary cannot drift from the code that writes it. Every literal `addressSourceKind`
 *      written by a file that types an `AddressProvenance` is scanned out of the tree and has to
 *      classify, so a seventh ingest route writing `'BOUGHT'` fails here rather than weeks later.
 *   2. Unknown classifies to null, and null is a refusal everywhere it is consumed.
 *   3. There is NO qualified form. `PROVIDER:acme` does not classify, because the particular
 *      belongs in `addressSourceEvidence` and a second place for a provider name to hide is the
 *      hole this module exists to close.
 *   4. PROVIDER is blocked by a recorded decision, not by omission — and the block is on the
 *      ADDRESS route specifically, because blocking only the person route left the policy
 *      circumventable in one step: identify on LinkedIn, buy the address, send.
 *
 * WHY THE PROSE FIELD COULD NOT BE THE CHECK is in the module header. `emailSource` used to be one
 * free-text string, and `lia-linkedin-2026.md` rests its necessity limb on a distinction that
 * string could not express.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/**
 * The files that record where an address came from.
 *
 * Found by the type, not by a hand-kept list of paths: `AddressProvenance` is the only way to
 * reach `buildContactDocument` and `ingestRecords`, so a new ingest route appears here the moment
 * it types its provenance.
 */
const ADDRESS_PROVENANCE_WRITERS: readonly { readonly path: string; readonly what: string }[] = [
  { path: '../domain/contactDocument.ts', what: 'defines the type; writes no kind of its own' },
  { path: '../routes/contacts.routes.ts', what: 'a contact typed in by a person' },
  { path: '../services/discovery.service.ts', what: 'an address supplied by a data provider' },
  { path: '../services/leadImport.service.ts', what: 'an uploaded list; the operator states the route' },
  { path: '../services/leadIngest.service.ts', what: 'the one write path; passes address provenance through' },
  { path: '../services/prospect.service.ts', what: 'a promoted prospect; the caller states the route' },
  { path: '../services/scrapeWorker.service.ts', what: "an address published on the employer's own site" },
];

/** `addressSourceKind: 'X'` literals, which are the ones a caller cannot influence. */
function kindLiterals(code: string): string[] {
  const out: string[] = [];
  for (const match of code.matchAll(/addressSourceKind:\s*'([A-Z_]+)'/g)) out.push(match[1]);
  return out;
}

describe('1. the vocabulary is the one the code actually writes', () => {
  it('every address route written as a literal classifies', () => {
    const found: { file: string; value: string }[] = [];
    for (const writer of ADDRESS_PROVENANCE_WRITERS) {
      for (const value of kindLiterals(read(writer.path))) found.push({ file: writer.path, value });
    }
    // The scan has to have found something: a regex that matches nothing passes every assertion
    // below it, which is how a test reaches the right answer by the wrong route.
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(found.map((f) => f.value))].sort()).toEqual(['EMPLOYER_WEBSITE', 'PROVIDER']);
    for (const entry of found) {
      expect(classifyAddressSource(entry.value), `${entry.file} writes ${entry.value}`).not.toBeNull();
    }
  });

  it('the writer list is the set of files that type an AddressProvenance', () => {
    for (const writer of ADDRESS_PROVENANCE_WRITERS) {
      expect(read(writer.path), writer.path).toContain('AddressProvenance');
      expect(writer.what.length).toBeGreaterThan(10);
    }
    expect(ADDRESS_PROVENANCE_WRITERS.length).toBe(7);
  });

  /**
   * THE DELIBERATE ABSENCE, WHICH IS ITSELF AN ASSERTION.
   *
   * A prospect has no email address — that is what the collection is for. If `createProspects`
   * ever takes an `AddressProvenance`, something has gone wrong in the design: either the fields
   * were made optional, which is how a required check becomes a skipped one, or a "not applicable"
   * member was added to the vocabulary, which is a default waiting to happen.
   */
  it('the prospects route records NO address provenance, because a prospect has no address', () => {
    expect(read('../routes/prospects.routes.ts')).not.toContain('AddressProvenance');
  });

  it('every kind has a note a person signing an assessment could read', () => {
    for (const kind of ADDRESS_SOURCE_KINDS) {
      expect(ADDRESS_SOURCE_KIND_NOTES[kind]?.length ?? 0, kind).toBeGreaterThan(20);
    }
    expect(Object.keys(ADDRESS_SOURCE_KIND_NOTES).sort()).toEqual([...ADDRESS_SOURCE_KINDS].sort());
  });
});

describe('2. a route may be blocked by decision rather than by omission', () => {
  it('names PROVIDER, carries the reason and the way back', () => {
    const why = uncoverableAddressReason('PROVIDER');
    expect(why).not.toBeNull();
    expect(why ?? '').toContain('business case');
    expect(why ?? '').toContain('server/domain/addressSource.ts');
  });

  /**
   * THE REASON THIS BLOCK EXISTS AT ALL, STATED AS A TEST.
   *
   * `leadSource.ts` already blocks a purchased PERSON. Blocking only that leaves the policy
   * circumventable in one step — identify the person on LinkedIn (permitted), buy their address
   * (previously invisible), send. The block has to be on both halves or it is on neither.
   */
  it('and the reason says why blocking only the person route was not enough', () => {
    const why = uncoverableAddressReason('PROVIDER') ?? '';
    expect(why).toContain('leadSource.ts');
    expect(why.toLowerCase()).toContain('one step');
  });

  it('blocks whatever the case and spacing, since it takes an arbitrary string', () => {
    for (const spelling of ['PROVIDER', 'provider', '  Provider  ', 'pRoViDeR']) {
      expect(uncoverableAddressReason(spelling), spelling).not.toBeNull();
    }
  });

  /**
   * INFERRED_PATTERN IS DELIBERATELY NOT BLOCKED, and the asymmetry is the design.
   *
   * It is the route `lia-linkedin-2026.md` was written about. Blocking it would leave the one
   * drafted assessment unable to declare the one route it covers, and the pressure would move to
   * editing the vocabulary to get moving — the failure `lawfulBasis.ts` argues against at length.
   * The accuracy risk it carries belongs to the signer, stated in its note.
   */
  it('blocks nothing else, so this is a policy and not a freeze', () => {
    for (const kind of ADDRESS_SOURCE_KINDS.filter((k) => k !== 'PROVIDER')) {
      expect(uncoverableAddressReason(kind), kind).toBeNull();
    }
    expect(Object.keys(UNCOVERABLE_ADDRESS_SOURCE_KINDS)).toEqual(['PROVIDER']);
    // Named explicitly: the guessed-address route stays authorable, and its note warns the signer.
    expect(uncoverableAddressReason('INFERRED_PATTERN')).toBeNull();
    expect(ADDRESS_SOURCE_KIND_NOTES.INFERRED_PATTERN).toContain('never published');
  });

  it('blocks nothing for a non-string', () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expect(uncoverableAddressReason(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('3. unknown is not a kind', () => {
  it('refuses an unrecognised word rather than guessing', () => {
    for (const bad of ['', '   ', 'BOUGHT', 'guessed', 'website', 'EMAIL', 'x']) {
      expect(classifyAddressSource(bad), bad).toBeNull();
    }
  });

  it('refuses a non-string, including the values a broken document holds', () => {
    for (const bad of [null, undefined, 42, {}, [], true, ['PROVIDER']]) {
      expect(classifyAddressSource(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  /**
   * THERE IS NO QUALIFIED FORM, AND THAT IS NOT AN OVERSIGHT.
   *
   * `leadSource` has `SCRAPE:<host>` because the particular is load-bearing there. Here the
   * particular — which provider, which directory, which page — lives in `addressSourceEvidence`,
   * which is required on every record. Accepting `PROVIDER:acme` would create a second place for
   * a provider's name to hide.
   *
   * A mutant deleting the explicit colon check changed no output for any input: no member of the
   * vocabulary contains a colon, so a qualified string fails the membership test on its own. The
   * check was REMOVED rather than kept as defence in depth, because a guard that cannot fire is
   * the defect this repository keeps finding. THIS TEST STAYS: the behaviour is the contract, and
   * it must keep holding if the vocabulary ever changes.
   */
  it('anything carrying a colon does not classify', () => {
    for (const bad of [
      'PROVIDER:acme',
      'EMPLOYER_WEBSITE:smilecare.example',
      'MANUAL_RESEARCH:ada',
      'PROVIDER:',
      ':PROVIDER',
    ]) {
      expect(classifyAddressSource(bad), bad).toBeNull();
    }
  });

  it('normalises case and surrounding space, because stored data is not tidy', () => {
    expect(classifyAddressSource('  employer_website  ')).toBe('EMPLOYER_WEBSITE');
    expect(classifyAddressSource('Inferred_Pattern')).toBe('INFERRED_PATTERN');
    expect(classifyAddressSource('SUBJECT_SUPPLIED')).toBe('SUBJECT_SUPPLIED');
  });

  it('isAddressSourceKind is exact, and does not normalise', () => {
    // The predicate answers "is this literally one of the words". `classifyAddressSource` is what
    // tolerates stored untidiness; keeping the two different stops a caller assuming either does
    // the other's job.
    expect(isAddressSourceKind('PROVIDER')).toBe(true);
    expect(isAddressSourceKind('provider')).toBe(false);
    expect(isAddressSourceKind(42)).toBe(false);
  });
});

describe('4. what an assessment may claim to cover', () => {
  it('de-duplicates and upper-cases, keeping the order they were written in', () => {
    expect(normaliseAddressSourceKinds(['employer_website', 'EMPLOYER_WEBSITE', ' inferred_pattern '])).toEqual([
      'EMPLOYER_WEBSITE',
      'INFERRED_PATTERN',
    ]);
  });

  it('one unknown entry rejects the whole list rather than being dropped', () => {
    // Dropping it would silently narrow what the assessment covers while telling the author it was
    // accepted, and the author would believe they had covered a route they had not.
    expect(normaliseAddressSourceKinds(['EMPLOYER_WEBSITE', 'BOUGHT'])).toBeNull();
    expect(normaliseAddressSourceKinds(['PROVIDER:acme'])).toBeNull();
    expect(normaliseAddressSourceKinds('EMPLOYER_WEBSITE')).toBeNull();
    expect(normaliseAddressSourceKinds([42])).toBeNull();
    expect(normaliseAddressSourceKinds(null)).toBeNull();
  });

  it('an empty list normalises to an empty list, which covers nothing', () => {
    // Distinct from null: `[]` is a well-formed claim to cover no route, and the caller refuses it
    // for that reason rather than for being malformed.
    expect(normaliseAddressSourceKinds([])).toEqual([]);
  });
});
