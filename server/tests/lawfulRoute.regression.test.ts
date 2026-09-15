import { describe, it, expect, vi, beforeEach } from 'vitest';
import { memory } from './helpers/memoryDocumentStore';
import { assessmentVerdict, validateLiaDraft, type LiaRecord } from '../domain/lia';
import { classifyLeadSource, uncoverableReason } from '../domain/leadSource';
import { createProspectsSchema, promoteProspectSchema } from '../domain/apiContracts';
import { promoteProspect } from '../services/prospect.service';
import type { Attribution } from '../domain/operatorAction';

vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);

/**
 * THE ROUTE BOUNDARY, AS A NAMED REGRESSION SUITE.
 *
 * Everything here is asserted elsewhere too, in the suites that own each piece. This file exists
 * anyway, and the duplication is the point: these are the specific cases the owner named as the
 * permanent boundary between the two audiences, and a case scattered across four suites is one
 * that can be weakened in any of them without anybody noticing the boundary moved.
 *
 * Each `it` below is one line of that list, in the owner's words:
 *
 *   LINKEDIN contact + website LIA           -> reject
 *   SCRAPE:domain + LinkedIn LIA             -> reject
 *   PROVIDER:* + either current LIA          -> reject
 *   unknown source                           -> reject
 *   missing source                           -> compile-time / internal validation failure
 *   caller sends `source` to /api/prospects  -> 400
 *
 * If one of these ever has to change, it should be because somebody decided to change it, and
 * the diff should say so.
 */

const ORG = 'org-a';
const NOW = new Date('2026-09-15T10:00:00.000Z');
const NAMED: Attribution = { kind: 'IDENTIFIED', actor: 'ops@abedin.example' };
const LIMB = 'x'.repeat(200);

/** The two assessments as they are actually drafted, reduced to what the gate reads. */
function assessment(id: string, sourceKinds: readonly string[]): LiaRecord {
  return {
    id,
    organizationId: ORG,
    title: `assessment ${id}`,
    purpose: LIMB,
    necessity: LIMB,
    balancing: LIMB,
    countries: ['GB'],
    sourceKinds,
    dataCategories: ['work email address'],
    dataSources: ['see the assessment'],
    safeguards: ['suppression on first objection'],
    objectionRoute: 'Reply to any message, or email privacy@abedin.example.',
    createdAt: '2026-09-01T09:00:00.000Z',
    createdBy: 'ops@abedin.example',
    signedBy: 'dpo@abedin.example',
    signedAt: '2026-09-02T09:00:00.000Z',
    reviewDueAt: '2027-09-02T09:00:00.000Z',
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawnReason: null,
    version: 2,
  } as unknown as LiaRecord;
}

/** `lia-uk-b2b-2026.md` — addresses published on an organisation's own site, lists, manual entry. */
const WEBSITE_LIA = assessment('lia_website', ['SCRAPE', 'IMPORT', 'MANUAL']);
/** `lia-linkedin-2026.md` — a person identified from a public profile. */
const LINKEDIN_LIA = assessment('lia_linkedin', ['LINKEDIN']);

const BOTH = [
  { name: 'the website assessment', record: WEBSITE_LIA },
  { name: 'the LinkedIn assessment', record: LINKEDIN_LIA },
];

beforeEach(() => memory.reset());

describe('the permanent route boundary', () => {
  it('LINKEDIN contact + website LIA = reject', () => {
    const verdict = assessmentVerdict(WEBSITE_LIA, { country: 'GB', source: 'LINKEDIN', now: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('LIA_SOURCE_NOT_COVERED');
      expect(verdict.message).toContain('LINKEDIN');
    }
    // And the control, so this is a boundary rather than a blanket refusal.
    expect(assessmentVerdict(LINKEDIN_LIA, { country: 'GB', source: 'LINKEDIN', now: NOW }).ok).toBe(true);
  });

  it('SCRAPE:domain + LinkedIn LIA = reject', () => {
    const verdict = assessmentVerdict(LINKEDIN_LIA, {
      country: 'GB',
      source: 'SCRAPE:smilecare.example',
      now: NOW,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LIA_SOURCE_NOT_COVERED');
    expect(assessmentVerdict(WEBSITE_LIA, { country: 'GB', source: 'SCRAPE:smilecare.example', now: NOW }).ok).toBe(true);
  });

  it('PROVIDER:* + either current LIA = reject', () => {
    for (const { name, record } of BOTH) {
      for (const source of ['PROVIDER:acme-data', 'PROVIDER:anyone', 'provider:Acme Data']) {
        const verdict = assessmentVerdict(record, { country: 'GB', source, now: NOW });
        expect(verdict.ok, `${source} under ${name}`).toBe(false);
        if (!verdict.ok) expect(verdict.code).toBe('LIA_SOURCE_NOT_COVERED');
      }
    }
  });

  /**
   * AND PROVIDER IS REFUSED BY DECISION, NOT BY OMISSION.
   *
   * It was already refused: no assessment covered it. That refusal was real and fragile — adding
   * `PROVIDER` to an existing assessment's `sourceKinds` is one word in one request body, and the
   * policy would have evaporated with nothing recording that it had been reversed.
   */
  it('no assessment may be authored that covers PROVIDER at all', () => {
    const draft = {
      title: 'Purchased data, 2026',
      purpose: LIMB,
      necessity: LIMB,
      balancing: LIMB,
      countries: ['GB'],
      dataCategories: ['work email address'],
      dataSources: ['a data provider'],
      safeguards: ['suppression on first objection'],
      objectionRoute: 'Reply to any message, or email privacy@abedin.example.',
    };
    for (const kinds of [['PROVIDER'], ['SCRAPE', 'PROVIDER'], ['provider']]) {
      const outcome = validateLiaDraft({ ...draft, sourceKinds: kinds });
      expect(outcome.ok, kinds.join(',')).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('LIA_SOURCE_KIND_NOT_PERMITTED');
    }
    // The decision carries its reason and the way to reverse it, so the refusal is answerable.
    const why = uncoverableReason('PROVIDER');
    expect(why).not.toBeNull();
    expect(why ?? '').toContain('business case');

    // The routes that ARE permitted still author fine — this is a policy, not a freeze.
    expect(validateLiaDraft({ ...draft, sourceKinds: ['SCRAPE', 'IMPORT', 'MANUAL'] }).ok).toBe(true);
    expect(validateLiaDraft({ ...draft, sourceKinds: ['LINKEDIN'] }).ok).toBe(true);
  });

  it('PROVIDER stays classified, so the refusal names the route rather than shrugging', () => {
    // Removing it from the vocabulary would have been the cruder way to block it, and worse: a
    // contact carrying `PROVIDER:acme` would then refuse as an UNRECOGNISED route, which reads
    // like a data error rather than a decision, and the Article 14 notice would lose its sentence.
    expect(classifyLeadSource('PROVIDER:acme-data')).toBe('PROVIDER');
    const verdict = assessmentVerdict(WEBSITE_LIA, { country: 'GB', source: 'PROVIDER:acme', now: NOW });
    if (!verdict.ok) expect(verdict.code).not.toBe('LIA_SOURCE_UNKNOWN');
  });

  it('unknown source = reject', () => {
    for (const { name, record } of BOTH) {
      for (const source of ['APOLLO', 'crm', 'bought', 'SCRAPE:', 'MANUAL:x', '']) {
        const verdict = assessmentVerdict(record, { country: 'GB', source, now: NOW });
        expect(verdict.ok, `${JSON.stringify(source)} under ${name}`).toBe(false);
        if (!verdict.ok) expect(verdict.code).toBe('LIA_SOURCE_UNKNOWN');
      }
    }
  });

  /**
   * MISSING SOURCE = A FAILURE BEFORE THE PROGRAM RUNS, WHERE THAT IS POSSIBLE.
   *
   * `source` is a required field of the verdict context, so a caller who omits it does not
   * compile. That is the strongest form this can take and it is why the field was made required
   * rather than optional — an optional one would have meant every existing caller silently
   * skipping the check. The assertion below is on the type, because there is no runtime path to
   * observe: the failure happens in `npm run lint`, which `npm run verify` runs first.
   */
  it('missing source = a compile-time failure, and at runtime a refusal', () => {
    // @ts-expect-error — omitting `source` must not compile. If this stops erroring, the context
    // type has been loosened and every caller can skip the route check again.
    const omitted = () => assessmentVerdict(WEBSITE_LIA, { country: 'GB', now: NOW });
    expect(typeof omitted).toBe('function');

    // And for a caller reaching this from untyped data — a document read out of the datastore —
    // the value is `unknown` and an absent one refuses rather than passing.
    for (const source of [undefined, null, 42, {}, []]) {
      const verdict = assessmentVerdict(WEBSITE_LIA, { country: 'GB', source, now: NOW });
      expect(verdict.ok, JSON.stringify(source)).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe('LIA_SOURCE_UNKNOWN');
    }
  });

  it('caller sends `source` to /api/prospects = 400', () => {
    // The contract is strict, so an unknown key is a refusal rather than a value quietly dropped.
    // It matters which: silently ignoring it would let a caller believe they had set the route.
    const withSource = createProspectsSchema.safeParse({
      sourceEvidence: 'a list of practices',
      source: 'IMPORT',
      rows: [{ profileUrl: 'https://www.linkedin.com/in/ada-lovelace' }],
    });
    expect(withSource.success).toBe(false);

    // The same body without it is accepted, so the refusal is about that field and not the shape.
    const without = createProspectsSchema.safeParse({
      sourceEvidence: 'a list of practices',
      rows: [{ profileUrl: 'https://www.linkedin.com/in/ada-lovelace' }],
    });
    expect(without.success).toBe(true);
  });

  /**
   * AND THE FACT THE LINKEDIN ASSESSMENT RESTS ON HAS TO BE RECORDED PER CONTACT.
   *
   * `lia-linkedin-2026.md` covers an address DERIVED from the employer's published naming
   * convention and not one BOUGHT from a provider. While `emailSource` was optional, the system
   * recorded which had happened only when somebody volunteered it — so the document made a claim
   * about every record that the data could not support for any of them.
   */
  it('a prospect cannot be promoted without recording where the address came from', async () => {
    const outcome = await promoteProspect(ORG, 'pr_x', 'ada@analytical.example', {} as never, NAMED, {
      mode: 'PREVIEW',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ADDRESS_ORIGIN_NOT_RECORDED');
    // Refused before the datastore is touched: an incomplete request is a property of the
    // request, and there is no reason to go and read a document to find that out.
    expect(Object.keys(memory.docs).length).toBe(0);

    // And the contract requires it too, so the refusal is not reachable only from a script.
    //
    // A MUTANT CAUGHT THIS ASSERTION REACHING THE RIGHT ANSWER BY THE WRONG ROUTE. It first read
    // `safeParse({ email })`, which fails whatever `emailSource` requires, because `basis` is
    // required too — so making `emailSource` optional changed nothing and the test still passed.
    // Every other required field is supplied now, so the ONLY reason this body is refused is the
    // field under test, and the accepted control below proves the body is otherwise valid.
    const complete = {
      email: 'ada@analytical.example',
      basis: 'LEGITIMATE_INTEREST' as const,
      emailSource: 'analytical.example contact page — firstname@ convention',
    };
    expect(promoteProspectSchema.safeParse(complete).success).toBe(true);

    const { emailSource: _omitted, ...withoutOrigin } = complete;
    expect(promoteProspectSchema.safeParse(withoutOrigin).success).toBe(false);
    // An empty one is not a recorded origin either, or the requirement is satisfied by a space.
    expect(promoteProspectSchema.safeParse({ ...complete, emailSource: '   ' }).success).toBe(false);
  });
});
