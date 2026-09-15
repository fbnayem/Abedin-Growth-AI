import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { memory } from './helpers/memoryDocumentStore';
import {
  LIA_MIN_LIMB_CHARS,
  LIA_SUBSTANTIVE_FIELDS,
  assessmentVerdict,
  defaultReviewDue,
  livenessVerdict,
  validateLiaDraft,
  type LiaRecord,
} from '../domain/lia';
import { LEAD_SOURCE_KINDS } from '../domain/leadSource';
import {
  amendAssessment,
  createAssessment,
  getAssessment,
  resolveAssessmentForContact,
  signAssessment,
  withdrawAssessment,
} from '../services/lia.service';
import { evaluateLawfulBasis } from '../domain/lawfulBasis';
import type { Attribution } from '../domain/operatorAction';

vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);

/**
 * THE BALANCING ASSESSMENT, WHICH USED TO BE A STRING (§14).
 *
 * `evaluateLawfulBasis` required `liaId` to be a non-empty string, under a comment reading "the
 * assessment is what makes the basis defensible". Typing `x` satisfied it. The gate that exists
 * to stop unknowns becoming permissions contained, in its own file, a check that read as
 * substantive and was a formality.
 *
 * WHAT THIS SUITE OWNS
 * --------------------
 *   1. A draft with an empty or token limb is refused, so "n/a" cannot be the documented basis
 *      on which strangers are emailed.
 *   2. An UNSIGNED assessment supports nothing. A draft is not the thing Article 6(1)(f) asks
 *      for, and this is the case the old string check could not even express.
 *   3. A SIGNED assessment is immutable. A signature is a claim about a specific text; if the
 *      text can change afterwards it is evidence of nothing, and the record becomes misleading
 *      rather than merely useless.
 *   4. Withdrawal and expiry take effect by being TRUE, with no second write anywhere. The gate
 *      resolves the assessment at send time, so a withdrawal at 09:00 stops the 09:01 send
 *      without touching a single contact record.
 *   5. Coverage is per-country and is not transferable.
 *   6. The gate refuses an unresolved assessment when it asked for a resolved one — a caller
 *      that forgets the lookup gets a refusal, not a pass.
 *
 * Each write is asserted against the STORED document rather than the return value: a service
 * that returns the right shape while writing the wrong fields passes any test that only reads
 * what it handed back.
 */

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const ORG = 'org-a';
const NOW = new Date('2026-09-15T10:00:00.000Z');
const NAMED: Attribution = { kind: 'IDENTIFIED', actor: 'ops@abedin.example' };
const SECOND: Attribution = { kind: 'IDENTIFIED', actor: 'dpo@abedin.example' };
const NOBODY: Attribution = { kind: 'UNATTRIBUTED', why: 'no verified identity on the request' };

const LIMB = 'x'.repeat(LIA_MIN_LIMB_CHARS + 20);

/** A contact source the DRAFT below covers. Its route matters as much as its country. */
const SOURCE = 'SCRAPE:smilecare.example';

const DRAFT = {
  title: 'UK B2B dental practices, Q3 2026',
  purpose: LIMB,
  necessity: LIMB,
  balancing: LIMB,
  countries: ['GB'],
  sourceKinds: ['SCRAPE'],
  dataCategories: ['work email address', 'job title', 'employer name'],
  dataSources: ['company website contact pages'],
  safeguards: ['suppression on first objection', 'no free-mail addresses'],
  objectionRoute: 'Reply to any message, or email privacy@abedin.example.',
};

/** A stored record in whatever state a test needs, without going through the service. */
function record(overrides: Partial<LiaRecord> = {}): LiaRecord {
  return {
    ...DRAFT,
    id: 'lia_1',
    organizationId: ORG,
    createdAt: '2026-09-01T09:00:00.000Z',
    createdBy: 'ops@abedin.example',
    signedBy: 'dpo@abedin.example',
    signedAt: '2026-09-02T09:00:00.000Z',
    reviewDueAt: '2027-09-02T09:00:00.000Z',
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawnReason: null,
    version: 2,
    ...overrides,
  } as LiaRecord;
}

const storedAt = (id: string) =>
  memory.docs[`organizations/${ORG}/legitimateInterestAssessments/${id}`] as Record<string, unknown> | undefined;

beforeEach(() => memory.reset());

describe('1. a draft has to actually say something', () => {
  it('refuses a limb that is empty, absent or a token', () => {
    for (const limb of ['purpose', 'necessity', 'balancing'] as const) {
      for (const value of ['', '   ', 'n/a', 'done', undefined]) {
        const outcome = validateLiaDraft({ ...DRAFT, [limb]: value });
        expect(outcome.ok, `${limb}=${JSON.stringify(value)}`).toBe(false);
        if (!outcome.ok) expect(outcome.code).toBe('LIA_LIMB_TOO_SHORT');
      }
    }
  });

  it('the floor is a real bound, not a non-empty check', () => {
    // One character below passes nothing, one above passes. A floor of 1 would let "x" through
    // and would be the same formality this file replaces.
    const short = validateLiaDraft({ ...DRAFT, balancing: 'y'.repeat(LIA_MIN_LIMB_CHARS - 1) });
    const long = validateLiaDraft({ ...DRAFT, balancing: 'y'.repeat(LIA_MIN_LIMB_CHARS) });
    expect(short.ok).toBe(false);
    expect(long.ok).toBe(true);
  });

  it('refuses an assessment that covers no country, or a country nothing can send to', () => {
    expect(validateLiaDraft({ ...DRAFT, countries: [] }).ok).toBe(false);
    const unknown = validateLiaDraft({ ...DRAFT, countries: ['ZZ'] });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('LIA_COUNTRY_UNKNOWN');
  });

  it('refuses an empty dataCategories, dataSources or safeguards', () => {
    for (const field of ['dataCategories', 'dataSources', 'safeguards'] as const) {
      const outcome = validateLiaDraft({ ...DRAFT, [field]: [] });
      expect(outcome.ok, field).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('LIA_LIST_EMPTY');
    }
  });

  it('carries through only the fields it names, so nothing can be smuggled in with the prose', () => {
    const outcome = validateLiaDraft({
      ...DRAFT,
      signedBy: 'me',
      signedAt: '2020-01-01T00:00:00.000Z',
      reviewDueAt: '2099-01-01T00:00:00.000Z',
      id: 'lia_forged',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.keys(outcome.draft).sort()).toEqual([...LIA_SUBSTANTIVE_FIELDS].sort());
  });

  it('upper-cases and de-duplicates the country list', () => {
    const outcome = validateLiaDraft({ ...DRAFT, countries: ['gb', 'GB', 'us'] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect([...outcome.draft.countries]).toEqual(['GB', 'US']);
  });
});

describe('2. an unsigned assessment supports nothing', () => {
  it('a draft is refused, and says it is a draft rather than that it is missing', () => {
    const verdict = assessmentVerdict(record({ signedAt: null, signedBy: null }), { country: 'GB', source: SOURCE, now: NOW });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('LIA_UNSIGNED');
    expect(verdict.message).toContain('draft');
  });

  it('a missing assessment is LIA_NOT_FOUND, not a crash and not a pass', () => {
    const verdict = assessmentVerdict(null, { country: 'GB', source: SOURCE, now: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LIA_NOT_FOUND');
  });

  it('a signature with a date and no signer does not count, nor the reverse', () => {
    expect(assessmentVerdict(record({ signedBy: null }), { country: 'GB', source: SOURCE, now: NOW }).ok).toBe(false);
    expect(assessmentVerdict(record({ signedAt: null }), { country: 'GB', source: SOURCE, now: NOW }).ok).toBe(false);
  });

  it('a signed, in-date, covering assessment is the one thing that passes', () => {
    const verdict = assessmentVerdict(record(), { country: 'GB', source: SOURCE, now: NOW });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.signedBy).toBe('dpo@abedin.example');
    expect(verdict.id).toBe('lia_1');
  });
});

describe('3. withdrawal and expiry take effect by being true', () => {
  it('a withdrawn assessment refuses, and says so before it says anything else', () => {
    // Order matters: an assessment that is BOTH withdrawn and not covering this country should
    // report the withdrawal, or the operator goes and fixes the wrong thing.
    const verdict = assessmentVerdict(
      record({ withdrawnAt: '2026-09-10T00:00:00.000Z', withdrawnReason: 'basis was wrong' }),
      { country: 'FR', source: SOURCE, now: NOW }
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('LIA_WITHDRAWN');
      expect(verdict.message).toContain('basis was wrong');
    }
  });

  it('an expired assessment refuses on the exact boundary, not a day late', () => {
    const due = '2026-09-15T10:00:00.000Z';
    const justBefore = new Date(Date.parse(due) - 1);
    expect(assessmentVerdict(record({ reviewDueAt: due }), { country: 'GB', source: SOURCE, now: justBefore }).ok).toBe(true);
    const onIt = assessmentVerdict(record({ reviewDueAt: due }), { country: 'GB', source: SOURCE, now: new Date(due) });
    expect(onIt.ok).toBe(false);
    if (!onIt.ok) expect(onIt.code).toBe('LIA_EXPIRED');
  });

  it('withdrawing makes every contact citing it unmailable, with no write to any contact', () => {
    const withdrawn = record({ withdrawnAt: '2026-09-14T00:00:00.000Z', withdrawnReason: 'superseded' });
    const before = assessmentVerdict(record(), { country: 'GB', source: SOURCE, now: NOW });
    const after = assessmentVerdict(withdrawn, { country: 'GB', source: SOURCE, now: NOW });
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(false);
    // The contact record is identical in both cases. Nothing propagated; the answer changed.
    const contact = { lawfulBasis: 'LEGITIMATE_INTEREST', addressType: 'ROLE', country: 'GB', liaId: 'lia_1', article14NoticeSentAt: '2026-09-03T09:00:00.000Z', email: 'info@analytical.example' };
    expect(evaluateLawfulBasis(contact, { requireSignedAssessment: true, assessment: before }).ok).toBe(true);
    expect(evaluateLawfulBasis(contact, { requireSignedAssessment: true, assessment: after }).ok).toBe(false);
  });
});

describe('4. coverage is per country and is not transferable', () => {
  it('an assessment for GB does not support a contact in FR', () => {
    const verdict = assessmentVerdict(record({ countries: ['GB'] }), { country: 'FR', source: SOURCE, now: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LIA_COUNTRY_NOT_COVERED');
  });

  it('a contact with no country is not covered by anything', () => {
    const verdict = assessmentVerdict(record(), { country: '', source: SOURCE, now: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LIA_COUNTRY_NOT_COVERED');
  });

  /**
   * A MUTATION SURVIVOR FOUND THIS ONE.
   *
   * Removing the `country === ''` clause from the coverage check left every test green, because
   * with a well-formed assessment `covered.includes('')` is false anyway and the record refuses
   * for the other reason. The clause is only REACHABLE when the stored `countries` list itself
   * contains an empty string — which `validateLiaDraft` strips, so the service cannot create
   * one, but `assessmentVerdict` reads whatever is in the datastore: a migration, a hand edit,
   * or a writer somebody adds later.
   *
   * Without the clause, such a record would cover a contact that states no country at all,
   * which is the §14 failure exactly — an unknown becoming a permission.
   */
  it('a malformed assessment listing an empty country does not thereby cover a stateless contact', () => {
    const malformed = record({ countries: ['', 'GB'] as unknown as string[] });
    const verdict = assessmentVerdict(malformed, { country: '', source: SOURCE, now: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LIA_COUNTRY_NOT_COVERED');
    // And it still covers the country it legitimately names.
    expect(assessmentVerdict(malformed, { country: 'GB', source: SOURCE, now: NOW }).ok).toBe(true);
  });

  it('case and whitespace do not decide coverage', () => {
    expect(assessmentVerdict(record({ countries: ['gb'] }), { country: ' gb ', source: SOURCE, now: NOW }).ok).toBe(true);
  });
});

describe("4b. coverage is per ROUTE too, and that is the half this gate did not have", () => {
  /**
   * THE DEFECT THIS SECTION EXISTS FOR, STATED PLAINLY.
   *
   * `assessmentVerdict` checked that the assessment covered the contact's COUNTRY and stopped.
   * So two assessments both covering `GB` were interchangeable as far as the gate was concerned,
   * and a person identified on LinkedIn could cite the assessment written about addresses
   * published on dental practices' own websites. Nothing objected.
   *
   * It is not a technicality. The balancing limb weighs what the person REASONABLY EXPECTED, and
   * that expectation is a property of the route, not of the jurisdiction: someone who published
   * a contact address on their own site for the purpose of being contacted has a materially
   * different expectation from someone who put up a networking profile and never published an
   * address at all. Those are two arguments, and only one of them was ever written down.
   *
   * The test below is the scenario itself, built out of two assessments that differ in exactly
   * one field.
   */
  it('an assessment for scraped websites does not support a contact found on LinkedIn', () => {
    const scraped = record({ id: 'lia_scrape', countries: ['GB'], sourceKinds: ['SCRAPE'] });
    const linkedin = record({ id: 'lia_linkedin', countries: ['GB'], sourceKinds: ['LINKEDIN'] });

    // Same country, same dates, same signature. The only difference is the route each was
    // written about, and it is the difference that decides.
    const wrong = assessmentVerdict(scraped, { country: 'GB', source: 'LINKEDIN', now: NOW });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.code).toBe('LIA_SOURCE_NOT_COVERED');
      // The message has to name both halves, or the operator cannot tell which document to go
      // and write. "Not covered" on its own sends them to re-read the wrong assessment.
      expect(wrong.message).toContain('SCRAPE');
      expect(wrong.message).toContain('LINKEDIN');
    }

    expect(assessmentVerdict(linkedin, { country: 'GB', source: 'LINKEDIN', now: NOW }).ok).toBe(true);
    expect(assessmentVerdict(scraped, { country: 'GB', source: SOURCE, now: NOW }).ok).toBe(true);
    // And the mirror image: the LinkedIn assessment does not cover a scraped contact either.
    expect(assessmentVerdict(linkedin, { country: 'GB', source: SOURCE, now: NOW }).ok).toBe(false);
  });

  it('the verdict reports the route it was reached for, not the assessment\u2019s first', () => {
    // The Article 14 notice quotes this. An assessment covering both routes must still say
    // which one applies to the person being written to; reporting `sourceKinds[0]` would tell
    // half of them where we got somebody else\u2019s data.
    const both = record({ sourceKinds: ['SCRAPE', 'LINKEDIN'] });
    const viaLinkedIn = assessmentVerdict(both, { country: 'GB', source: 'LINKEDIN', now: NOW });
    expect(viaLinkedIn.ok).toBe(true);
    if (viaLinkedIn.ok) expect(viaLinkedIn.sourceKind).toBe('LINKEDIN');
    const viaScrape = assessmentVerdict(both, { country: 'GB', source: SOURCE, now: NOW });
    if (viaScrape.ok) expect(viaScrape.sourceKind).toBe('SCRAPE');
  });

  it('an unrecognised source refuses, and says so differently from an uncovered one', () => {
    // Two codes because two remedies. UNKNOWN means this contact\u2019s provenance string is a
    // shape nothing here understands, and the fix is to the contact or to the vocabulary.
    // NOT_COVERED means the route is understood and the assessment was not written about it.
    const unknown = assessmentVerdict(record(), { country: 'GB', source: 'APOLLO', now: NOW });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('LIA_SOURCE_UNKNOWN');

    for (const bad of ['', '   ', null, undefined, 42, 'SCRAPE:']) {
      const verdict = assessmentVerdict(record(), { country: 'GB', source: bad, now: NOW });
      expect(verdict.ok, JSON.stringify(bad)).toBe(false);
      if (!verdict.ok) expect(verdict.code, JSON.stringify(bad)).toBe('LIA_SOURCE_UNKNOWN');
    }
  });

  it('a stored assessment with no sourceKinds at all supports nothing', () => {
    // The state every assessment written before this change is in. It fails closed: an absent
    // declaration is not a claim to cover everything, and it is reported as a malformed document
    // rather than as an uncovered route, because the remedy is to the document.
    const legacy = record({ sourceKinds: undefined as unknown as never });
    const verdict = assessmentVerdict(legacy, { country: 'GB', source: SOURCE, now: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LIA_MALFORMED');
  });

  /**
   * AN UNRECOGNISED DECLARED ROUTE IS REPORTED, NOT SILENTLY READ AS "COVERS NOTHING".
   *
   * Both refuse, so from the contact's side they are the same. They are not the same to the
   * person who has to fix it: "not covered" sends them to write the assessment for this route,
   * and if the assessment they already wrote is the one whose stored `sourceKinds` says
   * `APOLLO`, they would be writing a document they already have.
   */
  it('an unrecognised declared route is malformed, and says which value is wrong', () => {
    const junk = record({ sourceKinds: ['EVERYTHING'] as unknown as never });
    const verdict = assessmentVerdict(junk, { country: 'GB', source: SOURCE, now: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('LIA_MALFORMED');
      expect(verdict.message).toContain('EVERYTHING');
      expect(verdict.message).not.toContain('LIA_SOURCE_NOT_COVERED');
    }
    // A mix is no better than all-junk: one bad entry rejects the declaration.
    const mixed = record({ sourceKinds: ['SCRAPE', 'EVERYTHING'] as unknown as never });
    expect(assessmentVerdict(mixed, { country: 'GB', source: SOURCE, now: NOW }).ok).toBe(false);
  });

  it('the coverage message lists real routes, because the empty case cannot reach it', () => {
    // Liveness has already refused an assessment declaring no route and one declaring an
    // unrecognised route, so by the time coverage runs the list is non-empty and every entry is
    // known. There is deliberately no `?? []` fallback in the coverage check: it could not fire.
    const scraped = record({ sourceKinds: ['SCRAPE'] });
    const verdict = assessmentVerdict(scraped, { country: 'GB', source: 'LINKEDIN', now: NOW });
    if (!verdict.ok) expect(verdict.message).toContain('covers SCRAPE and');
    const code = stripComments(readFileSync('server/domain/lia.ts', 'utf8'));
    const at = code.indexOf('export function assessmentVerdict');
    expect(code.slice(at)).not.toContain('?? []');
  });

  it('a draft must declare its routes, from the closed list', () => {
    for (const bad of [undefined, [], 'SCRAPE', null]) {
      const outcome = validateLiaDraft({ ...DRAFT, sourceKinds: bad });
      expect(outcome.ok, JSON.stringify(bad)).toBe(false);
    }
    // Absent and wrong are different facts. Leaving the field out is NO_SOURCE_KINDS, which
    // tells the author the field exists; typing a word we do not know is SOURCE_KIND_UNKNOWN,
    // which gives them the list. Reporting a missing field as an unrecognised route called
    // "undefined" — which is what it did before this was separated — sends them hunting a typo.
    for (const absent of [{ ...DRAFT, sourceKinds: [] }, (({ sourceKinds, ...rest }) => rest)({ ...DRAFT })]) {
      const outcome = validateLiaDraft(absent);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('LIA_NO_SOURCE_KINDS');
    }
    const empty = validateLiaDraft({ ...DRAFT, sourceKinds: [] });
    if (!empty.ok) expect(empty.code).toBe('LIA_NO_SOURCE_KINDS');
    const unknown = validateLiaDraft({ ...DRAFT, sourceKinds: ['APOLLO'] });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('LIA_SOURCE_KIND_UNKNOWN');
    // And the refusal lists what IS accepted, because an author who guessed wrong needs the
    // list more than they need the word "invalid".
    if (!unknown.ok) for (const kind of LEAD_SOURCE_KINDS) expect(unknown.message).toContain(kind);
  });

  it('the route is frozen by a signature, like every other substantive field', () => {
    // Changing which routes an assessment covers changes what it is evidence about, so it is a
    // new assessment rather than an edit. If this were amendable, a signed document could grow
    // to cover a route the signer never considered.
    expect([...LIA_SUBSTANTIVE_FIELDS]).toContain('sourceKinds');
  });

  /**
   * THE END TO END, THROUGH THE GATE THE GATEWAY ACTUALLY CALLS.
   *
   * The checks above are about `assessmentVerdict`. This one is about what a send sees: a
   * mismatched route has to come out as a refusal from `evaluateLawfulBasis`, carrying the
   * specific reason, and not as some generic "assessment invalid" an operator cannot act on.
   */
  it('a route mismatch refuses the send, and the reason survives to the gate', () => {
    const contact = {
      lawfulBasis: 'LEGITIMATE_INTEREST',
      addressType: 'ROLE',
      country: 'GB',
      liaId: 'lia_scrape',
      article14NoticeSentAt: '2026-09-03T09:00:00.000Z',
      email: 'ada@analytical.example',
    };
    const scraped = record({ id: 'lia_scrape', sourceKinds: ['SCRAPE'] });
    const mismatched = assessmentVerdict(scraped, { country: 'GB', source: 'LINKEDIN', now: NOW });
    const verdict = evaluateLawfulBasis(contact, {
      requireSignedAssessment: true,
      assessment: mismatched,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('LI_ASSESSMENT_INVALID');
      expect(verdict.message).toContain('LIA_SOURCE_NOT_COVERED');
    }

    // The control: the same contact, the same assessment, resolved for the route it covers.
    const matched = assessmentVerdict(scraped, { country: 'GB', source: SOURCE, now: NOW });
    expect(evaluateLawfulBasis(contact, { requireSignedAssessment: true, assessment: matched }).ok).toBe(true);
  });

  /**
   * THE RESOLVER IS THE SEAM, SO IT GETS A BEHAVIOURAL TEST AND NOT ONLY A TEXTUAL ONE.
   *
   * Everything above exercises `assessmentVerdict` directly. Between it and the gateway sits
   * `resolveAssessmentForContact`, and a version of it that read the id and then passed a
   * hard-coded route would satisfy every test above while checking nothing — the route would be
   * whatever the constant said, for every contact in the system. So the route has to be shown
   * travelling from the caller's context all the way to the refusal.
   */
  it('the resolver carries the route it was given, not one of its own', async () => {
    const created = await createAssessment(ORG, DRAFT, NAMED, NOW);
    if (!created.ok) throw new Error('fixture');
    await signAssessment(ORG, created.record.id, SECOND, {}, NOW);

    // The stored assessment covers SCRAPE. Asked about a LinkedIn contact it must refuse, and
    // refuse for the ROUTE rather than for anything else.
    const wrong = await resolveAssessmentForContact(ORG, created.record.id, {
      country: 'GB',
      source: 'LINKEDIN',
      now: NOW,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe('LIA_SOURCE_NOT_COVERED');

    // Same id, same country, same clock. Only the route differs, and it decides.
    const right = await resolveAssessmentForContact(ORG, created.record.id, {
      country: 'GB',
      source: SOURCE,
      now: NOW,
    });
    expect(right.ok).toBe(true);
    if (right.ok) expect(right.sourceKind).toBe('SCRAPE');

    // AND THE SAME FOR THE COUNTRY, WHICH A MUTANT CAUGHT THIS TEST NOT PROVING.
    // Every resolver test above passes `country: 'GB'`, so a resolver that read the id and then
    // hard-coded `'GB'` satisfied all of them — the country would have been GB for every contact
    // in the system, including the ones this table refuses to send to at all. That is the same
    // defect as the route gap, one field to the left, and it was already here before this work.
    const elsewhere = await resolveAssessmentForContact(ORG, created.record.id, {
      country: 'FR',
      source: SOURCE,
      now: NOW,
    });
    expect(elsewhere.ok).toBe(false);
    if (!elsewhere.ok) expect(elsewhere.code).toBe('LIA_COUNTRY_NOT_COVERED');
  });

  /**
   * SOURCE IS A REQUIRED FIELD OF THE CONTEXT, AND THAT IS THE MECHANISM.
   *
   * An optional `source` would have meant every existing caller silently skipping the check —
   * the gap itself, with a type annotation on it. Required means the compiler finds a caller who
   * forgot, at the moment they forget, and there is nowhere to forget it quietly.
   */
  it('the context type makes source required, not optional', () => {
    const code = stripComments(readFileSync('server/domain/lia.ts', 'utf8'));
    const at = code.indexOf('export function assessmentVerdict');
    expect(at).toBeGreaterThan(-1);
    const signature = code.slice(at, code.indexOf('{', code.indexOf('AssessmentVerdict {', at)));
    expect(signature).toContain('readonly source: unknown');
    expect(signature).not.toContain('source?:');
  });

  it('the gateway passes the CONTACT\u2019s source, not a constant', () => {
    // A literal here would make every send look like one route regardless of where the lead came
    // from, and the check would pass for exactly the contacts it exists to stop.
    const code = stripComments(readFileSync('server/gateway/actionGateway.ts', 'utf8'));
    const at = code.indexOf('resolveAssessmentForContact(');
    expect(at).toBeGreaterThan(-1);
    const call = code.slice(at, at + 400);
    expect(call).toContain('source: contactData.source');
  });
});

describe('4c. liveness is a different question from coverage', () => {
  /**
   * The console lists assessments and the preflight counts them, and neither has a contact in
   * hand. Both used to build the coverage question themselves out of `countries[0]`, in two
   * separate copies — and when `source` became part of coverage, the second copy is the one that
   * would have been missed. `livenessVerdict` is that question written once.
   */
  it('judges a document against its own declarations, so coverage cannot fail there', () => {
    expect(livenessVerdict(record(), NOW).ok).toBe(true);
    expect(livenessVerdict(record({ sourceKinds: ['LINKEDIN'] }), NOW).ok).toBe(true);
    expect(livenessVerdict(record({ countries: ['FR'], sourceKinds: ['LINKEDIN'] }), NOW).ok).toBe(true);
  });

  it('still refuses what is not live: unsigned, withdrawn, expired, absent', () => {
    expect(livenessVerdict(null, NOW).ok).toBe(false);
    expect(livenessVerdict(record({ signedAt: null, signedBy: null }), NOW).ok).toBe(false);
    expect(livenessVerdict(record({ withdrawnAt: '2026-09-03T09:00:00.000Z' }), NOW).ok).toBe(false);
    expect(livenessVerdict(record({ reviewDueAt: '2026-01-01T00:00:00.000Z' }), NOW).ok).toBe(false);
  });

  /**
   * WHERE "COVERS NOTHING" IS CHECKED, AND WHY IT IS HERE RATHER THAN IN COVERAGE.
   *
   * A document declaring no jurisdiction, or no route, cannot support any contact. That is a
   * statement about the DOCUMENT, so it belongs to liveness: no contact is needed to reach it,
   * and the console must not show such a record as in force.
   *
   * Putting it here also keeps `assessmentVerdict` free of a branch that could never run. An
   * earlier draft carried `covered.length === 0 ? 'no country' : ...` in the coverage message,
   * which after this check is unreachable \u2014 defensive code that reads as protective and cannot
   * fire, which is the defect LP1's mutation testing found in `normaliseProfileUrl`. It was
   * deleted rather than left in place.
   */
  it('a document declaring no country or no route is malformed, not merely uncovered', () => {
    for (const gap of [{ countries: [] }, { sourceKinds: [] }, { countries: [], sourceKinds: [] }]) {
      const verdict = livenessVerdict(record(gap as Partial<LiaRecord>), NOW);
      expect(verdict.ok, JSON.stringify(gap)).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe('LIA_MALFORMED');
    }
    // And the message names which half is missing, so the author knows what to add.
    const noRoute = livenessVerdict(record({ sourceKinds: [] }), NOW);
    if (!noRoute.ok) {
      expect(noRoute.message).toContain('no route of acquisition');
      expect(noRoute.message).not.toContain('no jurisdiction');
    }
  });

  it('the console and the preflight both use it, rather than rebuilding the question', () => {
    for (const path of ['server/routes/lia.routes.ts', 'server/services/outreachPreflight.service.ts']) {
      const code = stripComments(readFileSync(path, 'utf8'));
      expect(code, path).toContain('livenessVerdict(');
      expect(code, path).not.toContain('assessmentVerdict(');
    }
  });
});

describe('5. the gate refuses an assessment it was told to resolve and did not get', () => {
  const CONTACT = {
    lawfulBasis: 'LEGITIMATE_INTEREST',
    addressType: 'ROLE',
    country: 'GB',
    liaId: 'lia_1',
    email: 'info@analytical.example',
    article14NoticeSentAt: '2026-09-03T09:00:00.000Z',
  };

  it('a caller that asks for the strict check and forgets the lookup is refused, not passed', () => {
    const verdict = evaluateLawfulBasis(CONTACT, { requireSignedAssessment: true });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LI_ASSESSMENT_NOT_RESOLVED');
  });

  it('a verdict for a DIFFERENT assessment does not satisfy this contact', () => {
    const other = assessmentVerdict(record({ id: 'lia_other' }), { country: 'GB', source: SOURCE, now: NOW });
    const verdict = evaluateLawfulBasis(CONTACT, { requireSignedAssessment: true, assessment: other });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LI_ASSESSMENT_MISMATCH');
  });

  it('without the strict flag the old string check still applies, and only that', () => {
    // The default has to keep working, or every preview and fixture in the repository breaks.
    expect(evaluateLawfulBasis(CONTACT).ok).toBe(true);
    expect(evaluateLawfulBasis({ ...CONTACT, liaId: '   ' }).ok).toBe(false);
  });

  it('an invalid resolved assessment refuses and carries the reason through', () => {
    const expired = assessmentVerdict(record({ reviewDueAt: '2026-01-01T00:00:00.000Z' }), { country: 'GB', source: SOURCE, now: NOW });
    const verdict = evaluateLawfulBasis(CONTACT, { requireSignedAssessment: true, assessment: expired });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('LI_ASSESSMENT_INVALID');
      expect(verdict.message).toContain('LIA_EXPIRED');
    }
  });
});

describe('6. the writer: signing is a one-way door', () => {
  async function create() {
    const outcome = await createAssessment(ORG, DRAFT, NAMED, NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('create failed');
    return outcome.record;
  }

  it('a created assessment is a draft: unsigned, and supporting nothing', async () => {
    const created = await create();
    expect(created.signedAt).toBeNull();
    expect(created.signedBy).toBeNull();
    expect(created.reviewDueAt).toBeNull();
    expect(assessmentVerdict(created, { country: 'GB', source: SOURCE, now: NOW }).ok).toBe(false);
  });

  it('refuses an unnamed author, and writes nothing', async () => {
    const outcome = await createAssessment(ORG, DRAFT, NOBODY, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ATTRIBUTION_REQUIRED');
    expect(Object.keys(memory.docs).length).toBe(0);
  });

  it('refuses an unnamed signer, and the assessment stays a draft', async () => {
    const created = await create();
    const outcome = await signAssessment(ORG, created.id, NOBODY, {}, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ATTRIBUTION_REQUIRED');
    expect(storedAt(created.id)!.signedAt).toBeNull();
  });

  it('signing records the signer from the credential and a default review date', async () => {
    const created = await create();
    const signed = await signAssessment(ORG, created.id, SECOND, {}, NOW);
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(storedAt(created.id)!.signedBy).toBe('dpo@abedin.example');
    expect(storedAt(created.id)!.signedAt).toBe(NOW.toISOString());
    expect(storedAt(created.id)!.reviewDueAt).toBe(defaultReviewDue(NOW));
    // Both names are kept, so an auditor can see when the drafter signed their own work.
    expect(storedAt(created.id)!.createdBy).toBe('ops@abedin.example');
  });

  it('a signed assessment cannot be amended, and the stored text does not move', async () => {
    const created = await create();
    await signAssessment(ORG, created.id, SECOND, {}, NOW);
    const before = JSON.stringify(storedAt(created.id));

    const outcome = await amendAssessment(ORG, created.id, { ...DRAFT, balancing: 'z'.repeat(200) }, NAMED, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ALREADY_SIGNED');
    expect(JSON.stringify(storedAt(created.id))).toBe(before);
  });

  it('an UNSIGNED assessment can be amended, because a draft is meant to be edited', async () => {
    const created = await create();
    const amended = await amendAssessment(ORG, created.id, { ...DRAFT, title: 'UK B2B dental, revised' }, NAMED, NOW);
    expect(amended.ok).toBe(true);
    expect(storedAt(created.id)!.title).toBe('UK B2B dental, revised');
    expect(storedAt(created.id)!.amendedBy).toBe('ops@abedin.example');
  });

  it('signing twice is refused; the first signature is the operative one', async () => {
    const created = await create();
    await signAssessment(ORG, created.id, NAMED, {}, NOW);
    const later = new Date('2026-10-01T09:00:00.000Z');
    const second = await signAssessment(ORG, created.id, SECOND, {}, later);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('ALREADY_SIGNED');
    expect(storedAt(created.id)!.signedBy).toBe('ops@abedin.example');
    expect(storedAt(created.id)!.signedAt).toBe(NOW.toISOString());
  });

  it('refuses a review date that is already in the past', async () => {
    const created = await create();
    const outcome = await signAssessment(ORG, created.id, NAMED, { reviewDueAt: '2020-01-01T00:00:00.000Z' }, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('VALIDATION_ERROR');
    expect(storedAt(created.id)!.signedAt).toBeNull();
  });

  it('withdrawal needs a reason but not a name, because it moves in the safe direction', async () => {
    const created = await create();
    await signAssessment(ORG, created.id, NAMED, {}, NOW);

    const noReason = await withdrawAssessment(ORG, created.id, '   ', NAMED, NOW);
    expect(noReason.ok).toBe(false);

    const anonymous = await withdrawAssessment(ORG, created.id, 'superseded by lia_2', NOBODY, NOW);
    expect(anonymous.ok).toBe(true);
    expect(storedAt(created.id)!.withdrawnBy).toBe('unattributed');
    expect(storedAt(created.id)!.withdrawnReason).toBe('superseded by lia_2');
  });

  it('withdrawing twice keeps the first date, because that is the operative one', async () => {
    const created = await create();
    await signAssessment(ORG, created.id, NAMED, {}, NOW);
    await withdrawAssessment(ORG, created.id, 'first', NAMED, NOW);
    const later = new Date('2026-10-01T09:00:00.000Z');
    const again = await withdrawAssessment(ORG, created.id, 'second', NAMED, later);
    expect(again.ok).toBe(true);
    expect(storedAt(created.id)!.withdrawnAt).toBe(NOW.toISOString());
    expect(storedAt(created.id)!.withdrawnReason).toBe('first');
  });

  it('a withdrawn assessment cannot be signed back into life', async () => {
    const created = await create();
    await withdrawAssessment(ORG, created.id, 'wrong basis', NAMED, NOW);
    const outcome = await signAssessment(ORG, created.id, NAMED, {}, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ALREADY_WITHDRAWN');
    expect(storedAt(created.id)!.signedAt).toBeNull();
  });

  it('resolving a contact id that names nothing is NOT_FOUND, not an exception', async () => {
    const verdict = await resolveAssessmentForContact(ORG, 'lia_missing', { country: 'GB', source: SOURCE, now: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LIA_NOT_FOUND');
  });

  it('resolving an empty liaId is a refusal rather than a lookup', async () => {
    expect((await resolveAssessmentForContact(ORG, '   ', { country: 'GB', source: SOURCE, now: NOW })).ok).toBe(false);
    expect((await resolveAssessmentForContact(ORG, null, { country: 'GB', source: SOURCE, now: NOW })).ok).toBe(false);
  });

  it('a signed assessment resolves end to end, from the id on a contact', async () => {
    const created = await create();
    await signAssessment(ORG, created.id, SECOND, {}, NOW);
    const verdict = await resolveAssessmentForContact(ORG, created.id, { country: 'GB', source: SOURCE, now: NOW });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.id).toBe(created.id);
    expect(await getAssessment(ORG, created.id)).not.toBeNull();
  });

  it('assessments are tenant-scoped: another organisation cannot resolve this one', async () => {
    const created = await create();
    await signAssessment(ORG, created.id, NAMED, {}, NOW);
    const verdict = await resolveAssessmentForContact('org-b', created.id, { country: 'GB', source: SOURCE, now: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LIA_NOT_FOUND');
  });
});

describe('7. the source says what the tests say', () => {
  const service = stripComments(readFileSync('server/services/lia.service.ts', 'utf8'));

  it('no write path sets signedBy or signedAt from caller-supplied data', () => {
    // `sign` takes it from the credential; nothing else may write it at all. A create that
    // could sign itself would make the signature worth what any self-reported field is worth.
    const create = service.slice(service.indexOf('export async function createAssessment'), service.indexOf('export async function amendAssessment'));
    expect(create).toContain('signedBy: null');
    expect(create).toContain('signedAt: null');

    const amend = service.slice(service.indexOf('export async function amendAssessment'), service.indexOf('export async function signAssessment'));
    expect(amend).not.toContain('signedBy:');
    expect(amend).not.toContain('signedAt:');
  });

  it('the signed check happens inside the transaction, against the stored record', () => {
    const amend = service.slice(service.indexOf('export async function amendAssessment'), service.indexOf('export async function signAssessment'));
    const tx = amend.indexOf('runTransaction');
    const check = amend.indexOf('ALREADY_SIGNED');
    // A check outside the transaction is a check a concurrent signature can walk past.
    expect(tx).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(tx);
  });

  it('the amend path covers every field a signature freezes', () => {
    // If a substantive field were added to the draft and not to this list, an amend could
    // change part of a signed assessment while the suite above still passed.
    const validator = stripComments(readFileSync('server/domain/lia.ts', 'utf8'));
    const built = validator.slice(validator.indexOf('return {\n    ok: true,\n    draft: {'));
    for (const field of LIA_SUBSTANTIVE_FIELDS) {
      expect(built, field).toContain(`${field}:`);
    }
  });
});
