import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BARE_SOURCE_KINDS,
  LEAD_SOURCE_KINDS,
  LEAD_SOURCE_KIND_NOTES,
  QUALIFIED_SOURCE_KINDS,
  classifyLeadSource,
  isLeadSourceKind,
  normaliseSourceKinds,
  sourceParticular,
  uncoverableReason,
} from '../domain/leadSource';

/**
 * THE ROUTE A LEAD ARRIVED BY, WHICH THE LAWFUL-BASIS GATE NOW DEPENDS ON (§14).
 *
 * WHAT THIS SUITE OWNS
 * --------------------
 *   1. The vocabulary cannot drift from the code that produces the strings. Every `source` value
 *      written by a file that builds a `ContactProvenance` is scanned out of the tree and has to
 *      classify. A sixth ingest route writing `source: 'APOLLO'` fails here, at the moment it is
 *      written, rather than at the moment somebody tries to email the people it found.
 *   2. Unknown classifies to null, and null is a refusal everywhere it is consumed. That is the
 *      §14 rule applied to acquisition: a route nobody has reasoned about does not inherit the
 *      justification written for a route somebody did.
 *   3. The shape rules are real bounds, not prefix tests. `SCRAPE:` with no host does not say
 *      where the data came from, and "where the data came from" is the entire content of the
 *      Article 14 notice, so a bare qualified prefix is unclassifiable.
 *   4. Every kind has a sentence in the Article 14 notice. A kind that fell through to the
 *      catch-all would tell a person "We obtained it from LINKEDIN", which is a category label
 *      rather than the answer Article 14(2)(f) asks for — and that is not hypothetical, it is
 *      what the notice did before this change.
 *
 * WHY THIS MODULE EXISTS AT ALL is in its own header: the assessment's `dataSources` is prose
 * written for a regulator, and matching a contact's `SCRAPE:smilecare.example` against
 * "publicly listed addresses on practice websites" could only ever be a heuristic. A heuristic
 * in a lawful-basis gate reads like a check and fails in both directions.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/**
 * The files that record where a lead came from.
 *
 * Found by the type rather than by a hand-kept list of paths, so a new ingest route appears here
 * the moment it types its provenance — and it must, because `ContactProvenance` is the only way
 * to reach `buildContactDocument` and `createProspects`.
 */
const PROVENANCE_WRITERS: readonly { readonly path: string; readonly what: string }[] = [
  { path: '../domain/contactDocument.ts', what: 'defines the type; writes no source of its own' },
  { path: '../routes/contacts.routes.ts', what: 'a contact typed in through the API' },
  { path: '../routes/prospects.routes.ts', what: 'a LinkedIn prospect' },
  { path: '../services/discovery.service.ts', what: 'a third-party data provider' },
  { path: '../services/leadImport.service.ts', what: 'an uploaded list' },
  { path: '../services/leadIngest.service.ts', what: 'the one write path; passes provenance through' },
  { path: '../services/prospect.service.ts', what: 'a prospect being promoted to a contact' },
  { path: '../services/scrapeWorker.service.ts', what: "a company's own website" },
];

/** `source: 'X'` and `` source: `X` ``, with `${...}` reduced to a placeholder. */
function sourceLiterals(code: string): string[] {
  const out: string[] = [];
  const pattern = /(?:^|[^A-Za-z])source:\s*(?:'([^']*)'|`([^`]*)`)/g;
  for (const match of code.matchAll(pattern)) {
    const raw = match[1] ?? match[2] ?? '';
    // A template's interpolations are runtime values — a host, a provider name. What the
    // classifier reads is the literal part, so the hole is filled with a stand-in.
    out.push(raw.replace(/\$\{[^}]*\}/g, 'x'));
  }
  return out;
}

describe('1. the vocabulary is the one the code actually writes', () => {
  /**
   * THE INVARIANT THAT KEEPS THIS HONEST.
   *
   * A closed vocabulary is only a control while it is closed. If an ingest route could write a
   * `source` nothing classifies, the refusal would land on the operator trying to email those
   * people, weeks later, with no clue which import caused it — and the tempting fix at that
   * point is to widen the classifier rather than to write the assessment.
   */
  it('every source value written by a provenance writer classifies', () => {
    const found: { file: string; value: string; kind: string | null }[] = [];
    for (const writer of PROVENANCE_WRITERS) {
      for (const value of sourceLiterals(read(writer.path))) {
        found.push({ file: writer.path, value, kind: classifyLeadSource(value) });
      }
    }

    // The scan has to have found something. A regex that matches nothing passes every assertion
    // below it, which is how a test reaches the right answer by the wrong route.
    expect(found.length).toBeGreaterThanOrEqual(5);
    expect(found.map((f) => f.value).sort()).toEqual(
      ['IMPORT', 'LINKEDIN', 'MANUAL', 'PROVIDER:x', 'SCRAPE:x'].sort()
    );
    for (const entry of found) {
      expect(entry.kind, `${entry.file} writes ${JSON.stringify(entry.value)}`).not.toBeNull();
    }
  });

  it('the writer list is the set of files that type a ContactProvenance', () => {
    // If a new file starts recording provenance and is not added here, its source values are
    // never scanned — so the list itself is asserted, not just its contents.
    for (const writer of PROVENANCE_WRITERS) {
      expect(read(writer.path), writer.path).toContain('ContactProvenance');
      expect(writer.what.length).toBeGreaterThan(10);
    }
    expect(PROVENANCE_WRITERS.length).toBe(8);
  });

  it('every kind is either bare or qualified, and none is both or neither', () => {
    const bare = new Set<string>(BARE_SOURCE_KINDS);
    const qualified = new Set<string>(QUALIFIED_SOURCE_KINDS);
    for (const kind of LEAD_SOURCE_KINDS) {
      expect([bare.has(kind), qualified.has(kind)].filter(Boolean).length, kind).toBe(1);
    }
    // And nothing is in a shape list that is not a kind — which would be a word the classifier
    // accepts and the assessment validator refuses, so nothing could ever cover it.
    for (const kind of [...BARE_SOURCE_KINDS, ...QUALIFIED_SOURCE_KINDS]) {
      expect(isLeadSourceKind(kind), kind).toBe(true);
    }
  });

  it('every kind has a note a person signing an assessment could read', () => {
    for (const kind of LEAD_SOURCE_KINDS) {
      expect(LEAD_SOURCE_KIND_NOTES[kind]?.length ?? 0, kind).toBeGreaterThan(20);
    }
    expect(Object.keys(LEAD_SOURCE_KIND_NOTES).sort()).toEqual([...LEAD_SOURCE_KINDS].sort());
  });
});

describe('1b. a route may be blocked by decision rather than by omission', () => {
  /**
   * `PROVIDER` is recognised and uncoverable: the classifier still names it, the Article 14 notice
   * still has a sentence for it, and no assessment may declare it. That is the owner's policy for
   * the initial release, and the point of recording it here rather than simply not writing the
   * assessment is that adding `PROVIDER` to an existing one would otherwise be a single word in a
   * request body, with nothing anywhere saying a decision had been reversed.
   */
  it('names the blocked route and carries the reason and the way back', () => {
    const why = uncoverableReason('PROVIDER');
    expect(why).not.toBeNull();
    expect(why ?? '').toContain('business case');
    expect(why ?? '').toContain('server/domain/leadSource.ts');
  });

  /**
   * A MUTATION SURVIVOR FOUND THIS UNTESTED.
   *
   * Removing the upper-casing from `uncoverableReason` changed nothing, because its only caller
   * inside `validateLiaDraft` runs `normaliseSourceKinds` first, which has already upper-cased.
   * The guard was unreachable from that path — the shape of defect this repository keeps finding.
   *
   * It is kept rather than deleted, because this function is EXPORTED and takes an arbitrary
   * string: any future caller reaches it directly. Keeping it means pinning it, so the guard is
   * covered by a test rather than by the accident of who happens to call it today.
   */
  it('blocks the route whatever the case and spacing, since it takes an arbitrary string', () => {
    for (const spelling of ['PROVIDER', 'provider', '  Provider  ', 'pRoViDeR']) {
      expect(uncoverableReason(spelling), spelling).not.toBeNull();
    }
  });

  it('blocks nothing else, so this is a policy and not a freeze', () => {
    for (const kind of LEAD_SOURCE_KINDS.filter((k) => k !== 'PROVIDER')) {
      expect(uncoverableReason(kind), kind).toBeNull();
    }
    for (const nonsense of ['', '   ', 'APOLLO', null, undefined, 42, {}]) {
      expect(uncoverableReason(nonsense), JSON.stringify(nonsense)).toBeNull();
    }
  });
});

describe('2. unknown is not a kind', () => {
  it('refuses an unrecognised word rather than guessing', () => {
    for (const bad of ['', '   ', 'APOLLO', 'crm', 'website', 'PARTNER:acme', 'x']) {
      expect(classifyLeadSource(bad), bad).toBeNull();
    }
  });

  it('refuses a non-string, including the values a broken document actually holds', () => {
    for (const bad of [null, undefined, 42, {}, [], true, ['SCRAPE:x']]) {
      expect(classifyLeadSource(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('a qualified kind with no particular says nothing, so it does not classify', () => {
    // `SCRAPE:` does not name a site and `PROVIDER:` does not name a provider. The Article 14
    // notice's job is to tell a person where their data came from; a kind with the answer
    // missing cannot do that, and is not a generic member of its kind.
    for (const bad of ['SCRAPE:', 'PROVIDER:', 'SCRAPE:   ', 'PROVIDER: ']) {
      expect(classifyLeadSource(bad), bad).toBeNull();
    }
    expect(classifyLeadSource('SCRAPE:smilecare.example')).toBe('SCRAPE');
    expect(classifyLeadSource('PROVIDER:acme-data')).toBe('PROVIDER');
  });

  it('a bare kind given a particular is an unrecognised shape, not the bare kind', () => {
    // `MANUAL:whatever` is not MANUAL. Accepting it would mean the shape rules are decoration
    // and any string starting with a known word classifies — which is the prefix test this
    // deliberately is not.
    for (const bad of ['MANUAL:x', 'IMPORT:acme.csv', 'LINKEDIN:ada-lovelace']) {
      expect(classifyLeadSource(bad), bad).toBeNull();
    }
  });

  it('normalises case and surrounding space, because stored data is not tidy', () => {
    expect(classifyLeadSource('  manual  ')).toBe('MANUAL');
    expect(classifyLeadSource('scrape:Smilecare.example')).toBe('SCRAPE');
    expect(classifyLeadSource(' Provider : acme ')).toBe('PROVIDER');
    // The particular keeps its own case: a host and a provider name are quoted back to the
    // recipient verbatim, and upper-casing them would put words in the notice nobody wrote.
    expect(sourceParticular('SCRAPE:Smilecare.example')).toBe('Smilecare.example');
    expect(sourceParticular('MANUAL')).toBeNull();
    expect(sourceParticular('SCRAPE:   ')).toBeNull();
  });
});

describe('3. what an assessment may claim to cover', () => {
  it('de-duplicates and upper-cases, and keeps the order they were written in', () => {
    expect(normaliseSourceKinds(['scrape', 'SCRAPE', ' linkedin '])).toEqual(['SCRAPE', 'LINKEDIN']);
  });

  it('one unknown entry rejects the whole list rather than being dropped', () => {
    // Dropping it would silently narrow what the assessment covers while telling the author it
    // was accepted, and the author would believe they had covered a route they had not.
    expect(normaliseSourceKinds(['SCRAPE', 'APOLLO'])).toBeNull();
    expect(normaliseSourceKinds(['SCRAPE:x'])).toBeNull();
    expect(normaliseSourceKinds('SCRAPE')).toBeNull();
    expect(normaliseSourceKinds([42])).toBeNull();
    expect(normaliseSourceKinds(null)).toBeNull();
  });

  it('an empty list normalises to an empty list, which covers nothing', () => {
    // Distinct from null: `[]` is a well-formed claim to cover no route, and the caller refuses
    // it for that reason rather than for being malformed.
    expect(normaliseSourceKinds([])).toEqual([]);
  });
});

describe('4. the notice can describe every route', () => {
  /**
   * A KIND WITH NO SENTENCE IS A REAL DEFECT, NOT A COSMETIC ONE.
   *
   * Before this change `sourceSentence` carried its own copy of the vocabulary as string
   * prefixes, and `LINKEDIN` was not in it — so a promoted prospect's notice said "We obtained it
   * from LINKEDIN, recorded as ...". Article 14(2)(f) asks for the source in terms the person
   * can act on, and a category label is not that.
   */
  it('article14Notice has a branch for every kind, and none falls to the catch-all', () => {
    const code = read('../domain/article14Notice.ts');
    for (const kind of LEAD_SOURCE_KINDS) {
      expect(code, kind).toContain(`case '${kind}':`);
    }
    // And it switches on the shared classifier rather than on private prefix tests, so the two
    // cannot disagree about what a source string means.
    expect(code).toContain('switch (classifyLeadSource(source))');
    expect(code).not.toContain("source.startsWith('SCRAPE:')");
  });
});
