import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { UNCHECKABLE, outreachPreflight, type PreflightFacts } from '../domain/outreachPreflight';
import { REAL_ACTION_FLAGS } from '../config/safeMode';

/**
 * WHETHER A REAL SEND COULD HAPPEN, AND WHY NOT (§14, §A).
 *
 * "Can we run a campaign yet?" was answerable only by reading the codebase: seven flags, an
 * OAuth record, a DNS posture, a settings document, a country table, a set of campaign guards
 * that refuse when their inputs are missing, and a basis on each contact. `/api/readiness` said
 * sending was off; it did not say what else would stop you the moment it was turned on.
 *
 * THE ONE PROPERTY THAT MATTERS
 * -----------------------------
 * A fact that could not be gathered is UNKNOWN, and UNKNOWN BLOCKS. This is the same rule §14
 * applies to consent, applied to readiness. The failure this prevents is specific: a datastore
 * blip during a preflight reporting "all clear" because a `catch` returned an empty array and
 * an empty array looked like "nothing missing".
 *
 * So most of this suite is the null cases. A readiness report that is right when everything is
 * readable and confidently wrong when something is not is worse than no report, because people
 * act on it.
 */

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** Everything in place. Each test breaks exactly one thing. */
function ready(overrides: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    flags: Object.fromEntries(REAL_ACTION_FLAGS.map((f) => [f, f === 'REAL_EMAIL_SEND_ENABLED'])),
    missingControllerFields: [],
    usableAssessments: 2,
    unreviewedCountries: [],
    gmailCredential: true,
    sendCapability: true,
    senderPosture: { domain: 'abedin.example', permitted: true, reason: 'READY — SPF and DMARC present' },
    messageIdDomain: 'abedin.example',
    unsubscribeConfigured: true,
    guardsThatCannotRun: [],
    mailableContacts: 12,
    ...overrides,
  };
}

const check = (result: ReturnType<typeof outreachPreflight>, id: string) =>
  result.checks.find((c) => c.id === id)!;

describe('1. the happy path is reachable, so the suite is not vacuous', () => {
  it('reports ready when every fact is in place', () => {
    const result = outreachPreflight(ready());
    expect(result.ready).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  it('every check is accounted for, and each carries a remedy when it is not a pass', () => {
    const result = outreachPreflight(ready({ flags: {}, missingControllerFields: ['controllerName'] }));
    expect(result.checks.length).toBeGreaterThanOrEqual(11);
    for (const c of result.checks) {
      if (c.status === 'PASS') continue;
      expect(c.remedy, c.id).not.toBeNull();
      expect((c.remedy ?? '').length, c.id).toBeGreaterThan(20);
    }
  });

  it('every check ids uniquely, so a console can key on it', () => {
    const ids = outreachPreflight(ready()).checks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('2. UNKNOWN BLOCKS, for every fact that can be unknown', () => {
  const nullable: [keyof PreflightFacts, string][] = [
    ['missingControllerFields', 'controller-identity'],
    ['usableAssessments', 'signed-assessment'],
    ['gmailCredential', 'gmail-credential'],
    ['sendCapability', 'send-capability'],
    ['senderPosture', 'sender-identity'],
    ['unsubscribeConfigured', 'unsubscribe'],
    ['mailableContacts', 'mailable-contacts'],
  ];

  for (const [fact, id] of nullable) {
    it(`a null ${String(fact)} makes ${id} UNKNOWN, not a pass`, () => {
      const result = outreachPreflight(ready({ [fact]: null } as Partial<PreflightFacts>));
      const c = check(result, id);
      expect(c.status).toBe('UNKNOWN');
    });
  }

  it('an unknown blocks the overall verdict, except where it is only a warning', () => {
    // `mailable-contacts` is the one WARN in the set — having nobody to email is the expected
    // state of a fresh system, not a misconfiguration. Unknown is still a block, because "we
    // could not count" is different from "we counted zero".
    for (const [fact, id] of nullable) {
      const result = outreachPreflight(ready({ [fact]: null } as Partial<PreflightFacts>));
      expect(result.ready, id).toBe(false);
      expect(check(result, id).blocking, id).toBe(true);
    }
  });

  it('zero mailable contacts WARNS rather than blocking', () => {
    const result = outreachPreflight(ready({ mailableContacts: 0 }));
    expect(check(result, 'mailable-contacts').status).toBe('WARN');
    expect(check(result, 'mailable-contacts').blocking).toBe(false);
    expect(result.ready).toBe(true);
  });

  it('an EMPTY missing-fields array is a pass, and null is not', () => {
    // The exact confusion this design exists to prevent: `catch { return [] }` would have made
    // a datastore failure look like a configured system.
    expect(check(outreachPreflight(ready({ missingControllerFields: [] })), 'controller-identity').status).toBe('PASS');
    expect(check(outreachPreflight(ready({ missingControllerFields: null })), 'controller-identity').status).toBe('UNKNOWN');
  });
});

describe('3. each check blocks on the thing it names', () => {
  it('the send flag being off blocks, and says the flag fails closed', () => {
    const result = outreachPreflight(ready({ flags: {} }));
    const c = check(result, 'send-flag');
    expect(c.status).toBe('BLOCK');
    expect(c.finding).toContain('fails closed');
    expect(c.remedy).toContain('REAL_EMAIL_SEND_ENABLED=true');
  });

  it('missing controller fields are listed by name', () => {
    const result = outreachPreflight(ready({ missingControllerFields: ['controllerPostalAddress', 'dpoContact'] }));
    const c = check(result, 'controller-identity');
    expect(c.status).toBe('BLOCK');
    expect(c.finding).toContain('controllerPostalAddress');
    expect(c.finding).toContain('dpoContact');
  });

  it('no signed assessment blocks, and points at how to write one', () => {
    const c = check(outreachPreflight(ready({ usableAssessments: 0 })), 'signed-assessment');
    expect(c.status).toBe('BLOCK');
    expect(c.remedy).toContain('/api/lia');
  });

  it('unreviewed countries block, and are named', () => {
    const c = check(outreachPreflight(ready({ unreviewedCountries: ['DE', 'NL'] })), 'country-review');
    expect(c.status).toBe('BLOCK');
    expect(c.finding).toContain('DE, NL');
    expect(c.finding).toContain('COUNTRY_NOT_LEGALLY_REVIEWED');
  });

  it('a missing OUTBOUND_MESSAGE_ID_DOMAIN blocks, citing the reconciliation reason', () => {
    for (const value of [null, '', '   ']) {
      const c = check(outreachPreflight(ready({ messageIdDomain: value })), 'reconcilable-sends');
      expect(c.status, JSON.stringify(value)).toBe('BLOCK');
      expect(c.finding).toContain('UNRECONCILABLE_SEND');
    }
  });

  it('guards that cannot run block, and this is the surprising one', () => {
    const c = check(
      outreachPreflight(ready({ guardsThatCannotRun: ['FREQUENCY_CAP', 'QUIET_HOURS', 'DAILY_RECIPIENT_LIMIT'] })),
      'campaign-guards'
    );
    expect(c.status).toBe('BLOCK');
    expect(c.finding).toContain('NOT_RUN refuses');
    expect(c.finding).toContain('3 guard(s)');
    // Says so explicitly, because it blocks while every other line is green and that reads as
    // a bug to whoever is looking at it.
    expect(c.finding).toContain('surprise');
  });

  it('a sender domain that fails authentication blocks', () => {
    const c = check(
      outreachPreflight(ready({ senderPosture: { domain: 'x.example', permitted: false, reason: 'FAILING — no SPF' } })),
      'sender-identity'
    );
    expect(c.status).toBe('BLOCK');
    expect(c.finding).toContain('no SPF');
  });

  it('no unsubscribe route blocks, because mailing someone who cannot stop us is the failure', () => {
    const c = check(outreachPreflight(ready({ unsubscribeConfigured: false })), 'unsubscribe');
    expect(c.status).toBe('BLOCK');
  });
});

describe('4. the report says what it cannot check', () => {
  it('names the limits rather than omitting them', () => {
    const result = outreachPreflight(ready());
    expect(result.uncheckable).toBe(UNCHECKABLE);
    expect(result.uncheckable.length).toBeGreaterThanOrEqual(4);
    const joined = result.uncheckable.join(' ');
    // The two that matter most: a recorded review is not a good review, and a long assessment
    // is not a sound one.
    expect(joined).toContain('legally correct');
    expect(joined).toContain('substantive');
  });

  it('a ready report is still not a claim that sending is wise', () => {
    const result = outreachPreflight(ready());
    expect(result.ready).toBe(true);
    // The uncheckable list is returned on the READY path too. A caveat that disappears when
    // everything passes is a caveat nobody reads at the moment it matters.
    expect(result.uncheckable.length).toBeGreaterThan(0);
  });
});

describe('5. the gathering distinguishes three outcomes, not two', () => {
  const service = stripComments(readFileSync('server/services/outreachPreflight.service.ts', 'utf8'));

  it('every catch returns null rather than a falsy value that reads as a definite answer', () => {
    const catches = service.match(/catch\s*\{[\s\S]{0,120}?\}/g) ?? [];
    expect(catches.length).toBeGreaterThanOrEqual(5);
    for (const block of catches) {
      expect(block).toMatch(/return (null|\{ usable: null, capable: null \})/);
    }
  });

  it('the gatherer writes nothing', () => {
    for (const writer of ['setDoc', 'updateDoc', 'addDoc', 'deleteDoc', 'runTransaction']) {
      expect(service, writer).not.toContain(writer);
    }
  });

  it('the guard list comes from evaluateCampaignSafety, not from a hand-kept copy', () => {
    expect(service).toContain('evaluateCampaignSafety');
    expect(service).toContain('decision.notRun');
  });
});
