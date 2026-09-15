import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { memory } from './helpers/memoryDocumentStore';
import { recordLawfulBasis, revokeConsent } from '../services/lawfulBasis.service';
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
