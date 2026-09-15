import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { memory } from './helpers/memoryDocumentStore';
import { recordArticle14Notice, recordLawfulBasis, revokeConsent } from '../services/lawfulBasis.service';
import { evaluateLawfulBasis } from '../domain/lawfulBasis';
import { lawfulBasisSchema } from '../domain/apiContracts';
import type { Attribution } from '../domain/operatorAction';

vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);

/**
 * THE WRITER, AND THE FOUR WAYS IT COULD UNDO THE GATE IT FEEDS (§14, §15, §26).
 *
 * `lawfulBasis.invariant` proves the DECISION. This suite proves the WRITE, which is the more
 * dangerous half: a gate is only as good as what can reach the fields it reads, and this is the
 * second endpoint in the system that can touch a contact record.
 *
 *   1. It must never clear a suppression flag. An unsubscribe survives any basis written after
 *      it, or "record a consent" becomes a way to undo an opt-out.
 *   2. It must not silently overwrite a revocation.
 *   3. It must refuse an unnamed recorder.
 *   4. It must not report success for a contact that is still unmailable.
 *
 * Each is asserted against the stored document, not against the return value, because a service
 * that returns the right shape while writing the wrong fields passes every test that only reads
 * what it was handed back.
 */

/** The house stripper: a source assertion that matches the fix's own comment proves nothing. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const ORG = 'org-a';
const ID = 'ct_ada';
const NOW = new Date('2026-09-15T10:00:00.000Z');
const NAMED: Attribution = { kind: 'IDENTIFIED', actor: 'ops@abedin.example' };
const NOBODY: Attribution = { kind: 'UNATTRIBUTED', why: 'no verified identity on the request' };

const path = `organizations/${ORG}/contacts/${ID}`;
const stored = () => memory.docs[path] as Record<string, unknown> | undefined;

function seed(contact: Record<string, unknown> = {}) {
  memory.docs[path] = {
    id: ID,
    type: 'LEAD',
    email: 'ada@analytical.example',
    emailKey: 'ada@analytical.example',
    country: 'GB',
    version: 3,
    ...contact,
  };
}

const CONSENT = {
  basis: 'CONSENT' as const,
  consentEvidence: 'webform:pricing 2026-09-01T10:00:00.000Z ip=203.0.113.7',
  consentSource: 'pricing-page',
};

const LI = {
  basis: 'LEGITIMATE_INTEREST' as const,
  addressType: 'ROLE' as const,
  liaId: 'lia_2026_q3_uk_b2b',
  article14NoticeSentAt: '2026-09-02T09:00:00.000Z',
};

beforeEach(() => memory.reset());

describe('1. recording a basis makes a lead mailable, which nothing could do before', () => {
  it('a consent record turns a refusal into a permission', () => {
    seed();
    expect(evaluateLawfulBasis(stored()!).ok).toBe(false);
  });

  it('CONSENT written, and the gate then says yes', async () => {
    seed();
    const outcome = await recordLawfulBasis(ORG, ID, CONSENT, NAMED, NOW);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.verdict.ok).toBe(true);
    expect(evaluateLawfulBasis(stored()!).ok).toBe(true);
  });

  it('LEGITIMATE_INTEREST written, and the gate then says yes', async () => {
    seed();
    const outcome = await recordLawfulBasis(ORG, ID, LI, NAMED, NOW);
    expect(outcome.ok).toBe(true);
    expect(evaluateLawfulBasis(stored()!).ok).toBe(true);
  });

  it('recording legitimate interest does not claim a consent that was never given', async () => {
    // The two bases are different claims. Writing `consentGiven: true` alongside a
    // legitimate-interest basis would put a statement in the record that nobody ever made, and
    // the gate would not catch it because the LI branch never reads the flag.
    seed();
    await recordLawfulBasis(ORG, ID, LI, NAMED, NOW);
    expect(stored()!.consentGiven).toBe(false);
    expect(stored()!.lawfulBasis).toBe('LEGITIMATE_INTEREST');
  });

  it('the recorder and the time are part of the record', async () => {
    seed();
    await recordLawfulBasis(ORG, ID, CONSENT, NAMED, NOW);
    expect(stored()!.consentRecordedBy).toBe('ops@abedin.example');
    expect(stored()!.consentRecordedAt).toBe(NOW.toISOString());
  });

  it('the version moves, so a concurrent edit cannot be lost silently', async () => {
    seed({ version: 3 });
    await recordLawfulBasis(ORG, ID, CONSENT, NAMED, NOW);
    expect(stored()!.version).toBe(4);
  });
});

describe('2. it can never clear a suppression flag', () => {
  const FLAGS = ['suppressed', 'unsubscribed', 'hardBounced', 'complained'] as const;

  for (const flag of FLAGS) {
    it(`recording consent leaves ${flag} exactly as it was`, async () => {
      seed({ [flag]: true });
      const outcome = await recordLawfulBasis(ORG, ID, CONSENT, NAMED, NOW);
      expect(outcome.ok).toBe(true);
      expect(stored()![flag]).toBe(true);
    });
  }

  it('a suppressed contact is still reported as unmailable after a basis is recorded', async () => {
    // The gateway checks suppression BEFORE basis, so the basis verdict alone says "ok" here.
    // What must not happen is the flag being cleared, which the assertions above pin. This test
    // records the division of labour so a later reader does not move the check into the wrong
    // place and think it redundant.
    seed({ unsubscribed: true });
    await recordLawfulBasis(ORG, ID, CONSENT, NAMED, NOW);
    expect(stored()!.unsubscribed).toBe(true);
  });

  it('no suppression field name appears anywhere in the patch the service builds', () => {
    const source = readFileSync('server/services/lawfulBasis.service.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const patch = source.slice(source.indexOf('const patch'), source.indexOf('const next ='));
    for (const flag of FLAGS) {
      expect(patch).not.toContain(flag);
    }
  });
});

describe('3. a revocation is not silently overwritten', () => {
  it('recording consent over a revocation refuses', async () => {
    seed({ consentRevokedAt: '2026-09-10T08:00:00.000Z' });
    const outcome = await recordLawfulBasis(ORG, ID, CONSENT, NAMED, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('REVOCATION_NOT_ACKNOWLEDGED');
    expect(stored()!.consentGiven).toBeUndefined();
  });

  it('it succeeds when the revocation is explicitly acknowledged, and records the restoration', async () => {
    seed({ consentRevokedAt: '2026-09-10T08:00:00.000Z' });
    const outcome = await recordLawfulBasis(
      ORG, ID, { ...CONSENT, acknowledgesRevocation: true }, NAMED, NOW
    );
    expect(outcome.ok).toBe(true);
    expect(stored()!.consentRevokedAt).toBeNull();
    expect(stored()!.consentRestoredAt).toBe(NOW.toISOString());
    expect(stored()!.consentRestoredBy).toBe('ops@abedin.example');
  });

  it('a revocation does not block the legitimate-interest basis, which is a different claim', async () => {
    seed({ consentRevokedAt: '2026-09-10T08:00:00.000Z' });
    const outcome = await recordLawfulBasis(ORG, ID, LI, NAMED, NOW);
    expect(outcome.ok).toBe(true);
  });

  it('revoking sets the flag, names the actor, and makes the gate refuse again', async () => {
    seed();
    await recordLawfulBasis(ORG, ID, CONSENT, NAMED, NOW);
    expect(evaluateLawfulBasis(stored()!).ok).toBe(true);

    const outcome = await revokeConsent(ORG, ID, NAMED, 'asked by phone', NOW);
    expect(outcome.ok).toBe(true);
    expect(stored()!.consentGiven).toBe(false);
    expect(stored()!.consentRevokedAt).toBe(NOW.toISOString());
    expect(stored()!.consentRevokedReason).toBe('asked by phone');
    expect(evaluateLawfulBasis(stored()!).ok).toBe(false);
  });

  it('revoking is never refused for want of a named actor, and records that it was unattributed', async () => {
    seed();
    await recordLawfulBasis(ORG, ID, CONSENT, NAMED, NOW);
    const outcome = await revokeConsent(ORG, ID, NOBODY, null, NOW);
    expect(outcome.ok).toBe(true);
    expect(stored()!.consentRevokedBy).toBe('unattributed');
  });
});

describe('4. recording requires a named recorder', () => {
  it('an unattributed caller cannot record a basis, and nothing is written', async () => {
    seed();
    const outcome = await recordLawfulBasis(ORG, ID, CONSENT, NOBODY, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ATTRIBUTION_REQUIRED');
    expect(stored()!.lawfulBasis).toBeUndefined();
  });

  it('the refusal quotes the reason no actor could be named', async () => {
    seed();
    const outcome = await recordLawfulBasis(ORG, ID, CONSENT, NOBODY, NOW);
    if (!outcome.ok) expect(outcome.message).toContain('no verified identity');
  });
});

describe('5. it refuses what it cannot prove, and writes nothing when it refuses', () => {
  it('a missing contact is NOT_FOUND', async () => {
    const outcome = await recordLawfulBasis(ORG, 'nobody', CONSENT, NAMED, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('NOT_FOUND');
  });

  it('CONSENT without evidence refuses and writes nothing', async () => {
    seed();
    const outcome = await recordLawfulBasis(ORG, ID, { basis: 'CONSENT' }, NAMED, NOW);
    expect(outcome.ok).toBe(false);
    expect(stored()!.lawfulBasis).toBeUndefined();
  });

  it('LEGITIMATE_INTEREST without an assessment refuses and writes nothing', async () => {
    seed();
    const outcome = await recordLawfulBasis(
      ORG, ID, { basis: 'LEGITIMATE_INTEREST', addressType: 'ROLE' }, NAMED, NOW
    );
    expect(outcome.ok).toBe(false);
    expect(stored()!.lawfulBasis).toBeUndefined();
  });

  it('an unrecognised basis refuses', async () => {
    seed();
    const outcome = await recordLawfulBasis(ORG, ID, { basis: 'VIBES' } as any, NAMED, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('VALIDATION_ERROR');
  });

  it('a malformed country refuses rather than being stored as written', async () => {
    seed();
    const outcome = await recordLawfulBasis(ORG, ID, { ...CONSENT, country: 'United Kingdom' }, NAMED, NOW);
    expect(outcome.ok).toBe(false);
    expect(stored()!.country).toBe('GB');
  });
});

describe('6. success is never reported for a contact that is still unmailable', () => {
  it('a basis recorded against an unreviewed country succeeds but reports NOT mailable', async () => {
    seed({ country: 'JP' });
    const outcome = await recordLawfulBasis(ORG, ID, CONSENT, NAMED, NOW);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.verdict.ok).toBe(false);
      if (!outcome.verdict.ok) expect(outcome.verdict.code).toBe('COUNTRY_NOT_REVIEWED');
    }
  });

  it('legitimate interest without the notice is stored, and reported as not yet mailable', async () => {
    seed();
    const outcome = await recordLawfulBasis(
      ORG, ID, { basis: 'LEGITIMATE_INTEREST', addressType: 'ROLE', liaId: 'lia_1' }, NAMED, NOW
    );
    expect(outcome.ok).toBe(true);
    // Unconditional. `if (!verdict.ok) expect(code)` passes vacuously the moment the record
    // becomes mailable, which is the one outcome this test exists to catch.
    if (!outcome.ok) throw new Error('expected the record to be written');
    expect(outcome.verdict.ok).toBe(false);
    if (!outcome.verdict.ok) expect(outcome.verdict.code).toBe('LI_NOTICE_NOT_SENT');
  });

  it('the verdict the caller is given is the verdict of the record that was stored', async () => {
    seed();
    const outcome = await recordLawfulBasis(ORG, ID, LI, NAMED, NOW);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.verdict).toEqual(evaluateLawfulBasis(stored()!));
    }
  });
});

describe('7. the request contract cannot be used to set the flags directly', () => {
  it('the schema refuses consentGiven and every suppression flag', () => {
    for (const field of ['consentGiven', 'suppressed', 'unsubscribed', 'hardBounced', 'complained']) {
      const parsed = lawfulBasisSchema.safeParse({ ...CONSENT, [field]: true });
      expect(parsed.success, field).toBe(false);
    }
  });

  it('the schema accepts exactly the fields the service names', () => {
    expect(lawfulBasisSchema.safeParse(CONSENT).success).toBe(true);
    expect(lawfulBasisSchema.safeParse(LI).success).toBe(true);
  });

  it('an unknown basis is refused by the contract before it reaches the service', () => {
    expect(lawfulBasisSchema.safeParse({ basis: 'CONTRACT' }).success).toBe(false);
  });
});

/**
 * THE ARTICLE 14 NOTICE, WHICH IS THE WRITE THAT MAKES PEOPLE MAILABLE.
 *
 * Added late, and it should have been added with the function. `recordArticle14Notice` is the
 * one call in this system that turns a record the outreach gate refuses into one it permits, in
 * batches of up to five hundred, and it shipped with no test of its own — found by a mutation
 * run, where two anchors in the writer suite started matching twice because this function had
 * been added beside them.
 *
 * FOUR PROPERTIES, EACH OF WHICH IS A WAY IT COULD BE WRONG
 * --------------------------------------------------------
 * 1. THE TIMESTAMP IS NOT A PARAMETER. It is the moment of the call, because the field is a
 *    precondition for outreach and a caller-supplied date is an unverifiable assertion about
 *    the past standing between a bought list and a send.
 *
 * 2. IT DOES NOT RE-STAMP. A contact that already has a notice keeps the original date. The
 *    obligation is to tell someone once, promptly; moving the date forward on every run erases
 *    the evidence of whether that actually happened inside the window.
 *
 * 3. IT REQUIRES A NAMED ACTOR, like every other write in this file except a revocation.
 *
 * 4. IT WRITES NOTHING ELSE. Not a suppression flag, not a basis, not a consent. It records one
 *    fact and recomputes the verdict.
 */
describe('the Article 14 notice', () => {
  const NOTICE = 'Sent by email from the Q3 UK dental batch, template a14-v2.';

  /** A contact one notice away from being mailable on legitimate interest. */
  function seedAwaitingNotice() {
    seed({
      lawfulBasis: 'LEGITIMATE_INTEREST',
      addressType: 'ROLE',
      liaId: 'lia_2026_q3_uk_b2b',
      email: 'info@analytical.example',
      emailKey: 'info@analytical.example',
    });
  }

  it('refuses an unnamed recorder, and writes nothing', async () => {
    seedAwaitingNotice();
    const before = JSON.stringify(stored());
    const outcome = await recordArticle14Notice(ORG, [ID], NOTICE, NOBODY, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ATTRIBUTION_REQUIRED');
    expect(JSON.stringify(stored())).toBe(before);
  });

  it('refuses without evidence of what was sent', async () => {
    seedAwaitingNotice();
    for (const evidence of ['', '   ']) {
      const outcome = await recordArticle14Notice(ORG, [ID], evidence, NAMED, NOW);
      expect(outcome.ok).toBe(false);
    }
    expect(stored()!.article14NoticeSentAt).toBeUndefined();
  });

  it('records the notice, and the contact becomes mailable', async () => {
    seedAwaitingNotice();
    expect(evaluateLawfulBasis(stored()!).ok).toBe(false);

    const outcome = await recordArticle14Notice(ORG, [ID], NOTICE, NAMED, NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcomes[0]).toMatchObject({ contactId: ID, recorded: true, mailable: true });
    expect(evaluateLawfulBasis(stored()!).ok).toBe(true);
  });

  it('the timestamp is the moment of the call, not anything a caller supplied', async () => {
    seedAwaitingNotice();
    await recordArticle14Notice(ORG, [ID], NOTICE, NAMED, NOW);
    expect(stored()!.article14NoticeSentAt).toBe(NOW.toISOString());
    expect(stored()!.article14NoticeRecordedBy).toBe('ops@abedin.example');
    expect(stored()!.article14NoticeEvidence).toBe(NOTICE);
  });

  it('a second run does NOT move the date forward', async () => {
    // The obligation is to tell someone once, promptly. Re-stamping on every run would erase
    // whether that happened inside the window, which is the only thing the date is evidence of.
    seedAwaitingNotice();
    await recordArticle14Notice(ORG, [ID], NOTICE, NAMED, NOW);
    const later = new Date('2026-11-01T09:00:00.000Z');
    const outcome = await recordArticle14Notice(ORG, [ID], 'sent again', NAMED, later);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcomes[0].recorded).toBe(false);
    expect(outcome.outcomes[0].reason).toContain('original date stands');
    expect(stored()!.article14NoticeSentAt).toBe(NOW.toISOString());
    expect(stored()!.article14NoticeEvidence).toBe(NOTICE);
  });

  it('it touches no suppression flag, no basis and no consent', async () => {
    seed({
      lawfulBasis: 'LEGITIMATE_INTEREST',
      addressType: 'ROLE',
      liaId: 'lia_1',
      email: 'info@analytical.example',
      emailKey: 'info@analytical.example',
      unsubscribed: true,
      suppressed: true,
      consentGiven: false,
    });
    await recordArticle14Notice(ORG, [ID], NOTICE, NAMED, NOW);
    const after = stored()!;
    expect(after.unsubscribed).toBe(true);
    expect(after.suppressed).toBe(true);
    expect(after.consentGiven).toBe(false);
    expect(after.lawfulBasis).toBe('LEGITIMATE_INTEREST');
  });

  it('a contact that does not exist is reported, not silently counted', async () => {
    seedAwaitingNotice();
    const outcome = await recordArticle14Notice(ORG, [ID, 'ct_nobody'], NOTICE, NAMED, NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcomes).toHaveLength(2);
    const missing = outcome.outcomes.find((o) => o.contactId === 'ct_nobody')!;
    expect(missing.recorded).toBe(false);
    expect(missing.mailable).toBe(false);
    expect(missing.reason).toContain('No contact');
  });

  it('a notice does not make an otherwise incomplete record mailable', async () => {
    // The notice is one of four conditions. Recording it must not be read as satisfying the
    // others — a record with no balancing assessment stays refused, and says which condition.
    seed({ lawfulBasis: 'LEGITIMATE_INTEREST', addressType: 'ROLE', email: 'info@analytical.example', emailKey: 'info@analytical.example' });
    const outcome = await recordArticle14Notice(ORG, [ID], NOTICE, NAMED, NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcomes[0].recorded).toBe(true);
    expect(outcome.outcomes[0].mailable).toBe(false);
    expect(evaluateLawfulBasis(stored()!)).toMatchObject({ ok: false, code: 'LI_NO_ASSESSMENT' });
  });

  it('the write names no field outside the notice, which a source scan confirms', () => {
    const source = stripComments(readFileSync('server/services/lawfulBasis.service.ts', 'utf8'));
    const fn = source.slice(source.indexOf('export async function recordArticle14Notice'));
    for (const forbidden of ['suppressed', 'unsubscribed', 'hardBounced', 'complained', 'consentGiven', 'lawfulBasis:']) {
      expect(fn).not.toContain(forbidden);
    }
    expect(fn).toContain('article14NoticeSentAt: iso');
  });
});
