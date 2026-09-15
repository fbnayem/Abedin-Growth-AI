import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { memory } from './helpers/memoryDocumentStore';
import {
  LIA_MIN_LIMB_CHARS,
  LIA_SUBSTANTIVE_FIELDS,
  assessmentVerdict,
  defaultReviewDue,
  validateLiaDraft,
  type LiaRecord,
} from '../domain/lia';
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

const DRAFT = {
  title: 'UK B2B dental practices, Q3 2026',
  purpose: LIMB,
  necessity: LIMB,
  balancing: LIMB,
  countries: ['GB'],
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
    const verdict = assessmentVerdict(record({ signedAt: null, signedBy: null }), { country: 'GB', now: NOW });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('LIA_UNSIGNED');
    expect(verdict.message).toContain('draft');
  });

  it('a missing assessment is LIA_NOT_FOUND, not a crash and not a pass', () => {
    const verdict = assessmentVerdict(null, { country: 'GB', now: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LIA_NOT_FOUND');
  });

  it('a signature with a date and no signer does not count, nor the reverse', () => {
    expect(assessmentVerdict(record({ signedBy: null }), { country: 'GB', now: NOW }).ok).toBe(false);
    expect(assessmentVerdict(record({ signedAt: null }), { country: 'GB', now: NOW }).ok).toBe(false);
  });

  it('a signed, in-date, covering assessment is the one thing that passes', () => {
    const verdict = assessmentVerdict(record(), { country: 'GB', now: NOW });
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
      { country: 'FR', now: NOW }
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
    expect(assessmentVerdict(record({ reviewDueAt: due }), { country: 'GB', now: justBefore }).ok).toBe(true);
    const onIt = assessmentVerdict(record({ reviewDueAt: due }), { country: 'GB', now: new Date(due) });
    expect(onIt.ok).toBe(false);
    if (!onIt.ok) expect(onIt.code).toBe('LIA_EXPIRED');
  });

  it('withdrawing makes every contact citing it unmailable, with no write to any contact', () => {
    const withdrawn = record({ withdrawnAt: '2026-09-14T00:00:00.000Z', withdrawnReason: 'superseded' });
    const before = assessmentVerdict(record(), { country: 'GB', now: NOW });
    const after = assessmentVerdict(withdrawn, { country: 'GB', now: NOW });
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
    const verdict = assessmentVerdict(record({ countries: ['GB'] }), { country: 'FR', now: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LIA_COUNTRY_NOT_COVERED');
  });

  it('a contact with no country is not covered by anything', () => {
    const verdict = assessmentVerdict(record(), { country: '', now: NOW });
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
    const verdict = assessmentVerdict(malformed, { country: '', now: NOW });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LIA_COUNTRY_NOT_COVERED');
    // And it still covers the country it legitimately names.
    expect(assessmentVerdict(malformed, { country: 'GB', now: NOW }).ok).toBe(true);
  });

  it('case and whitespace do not decide coverage', () => {
    expect(assessmentVerdict(record({ countries: ['gb'] }), { country: ' gb ', now: NOW }).ok).toBe(true);
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
    const other = assessmentVerdict(record({ id: 'lia_other' }), { country: 'GB', now: NOW });
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
    const expired = assessmentVerdict(record({ reviewDueAt: '2026-01-01T00:00:00.000Z' }), { country: 'GB', now: NOW });
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
    expect(assessmentVerdict(created, { country: 'GB', now: NOW }).ok).toBe(false);
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
    const verdict = await resolveAssessmentForContact(ORG, 'lia_missing', 'GB', NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LIA_NOT_FOUND');
  });

  it('resolving an empty liaId is a refusal rather than a lookup', async () => {
    expect((await resolveAssessmentForContact(ORG, '   ', 'GB', NOW)).ok).toBe(false);
    expect((await resolveAssessmentForContact(ORG, null, 'GB', NOW)).ok).toBe(false);
  });

  it('a signed assessment resolves end to end, from the id on a contact', async () => {
    const created = await create();
    await signAssessment(ORG, created.id, SECOND, {}, NOW);
    const verdict = await resolveAssessmentForContact(ORG, created.id, 'GB', NOW);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.id).toBe(created.id);
    expect(await getAssessment(ORG, created.id)).not.toBeNull();
  });

  it('assessments are tenant-scoped: another organisation cannot resolve this one', async () => {
    const created = await create();
    await signAssessment(ORG, created.id, NAMED, {}, NOW);
    const verdict = await resolveAssessmentForContact('org-b', created.id, 'GB', NOW);
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
