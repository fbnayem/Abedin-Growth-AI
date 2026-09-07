import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { checkSuppression } from '../agents/salesDecisionEngine';

/**
 * A SAFETY RECORD THAT SAYS A CHECK PASSED IS A CLAIM THAT THE CHECK RAN.
 *
 * The auditor recorded `suppression: 'CLEAN'` on every draft it let through. The function behind
 * it, `isSuppressed`, made two lookups against `globalStore` — the IN-MEMORY SEED STORE in
 * `server/dataStore.ts` — and returned `{ suppressed: false }` when it found nothing.
 *
 * The live inbound path never touches `globalStore`; a grep for it in `inboundPipeline.ts`
 * returns nothing. So a real customer's unsubscribe went to the datastore, and this check
 * searched a fixture it had never reached, found nothing, and reported clean. Not for some
 * recipients — for every recipient, always, by construction.
 *
 * WHAT WAS AND WAS NOT AT RISK
 * ----------------------------
 * No send was unguarded. The Production Action Gateway refuses every EMAIL_SEND without a
 * `contactId`, without a contact record, with any of `suppressed` / `unsubscribed` /
 * `hardBounced` / `complained` / `emailStatus === 'BOUNCED'` set, or with `consentGiven !== true`
 * — reading the LIVE record, per recipient, at dispatch. This was a false safety RECORD, not an
 * open door, and describing it as an open door would inflate it.
 *
 * A false safety record is still worth removing, because it is the artefact an incident review
 * reads. "The auditor recorded suppression CLEAN" is a sentence someone would rely on.
 *
 * WHY THERE IS NO `NOT_SUPPRESSED`
 * --------------------------------
 * An address can prove it must not be mailed — `mailer-daemon@` is not a person. No property of
 * an address can prove that its owner has not opted out. A third state would invite a caller to
 * read "not suppressed" as "clear to send", which is what the old boolean did.
 *
 * These tests were written after the change and immediately found the reason the defect
 * survived: the full suite of 1,169 assertions passed unchanged when `CLEAN` became `NOT_RUN`,
 * because not one test had ever asserted anything about the suppression outcome.
 */

const auditor = readFileSync('server/agents/independentAuditor.ts', 'utf8');
const engine = readFileSync('server/agents/salesDecisionEngine.ts', 'utf8');
const gateway = readFileSync('server/gateway/actionGateway.ts', 'utf8');

// ===========================================================================
describe('1. the check reports only what an address can settle', () => {
  it('a system or bounce mailbox is suppressed, whatever any record says', () => {
    for (const email of [
      'no-reply@acme.com',
      'NO-REPLY@ACME.COM',
      '  mailer-daemon@mail.example.net  ',
      'postmaster@example.org',
    ]) {
      const outcome = checkSuppression(email);
      expect(outcome.state).toBe('SUPPRESSED');
      expect(outcome.state === 'SUPPRESSED' && outcome.reason).toBeTruthy();
    }
  });

  /**
   * The invariant. Every ordinary address must come back as undetermined — not as clear —
   * because nothing reachable from this function can establish that its owner has not opted out.
   */
  it('an ordinary address is CANNOT_DETERMINE, never clear', () => {
    for (const email of [
      'sarah@acme.com',
      'someone.who.unsubscribed@example.com',
      'a@b.co',
      '',
    ]) {
      expect(checkSuppression(email).state).toBe('CANNOT_DETERMINE');
    }
  });

  it('there is no state that means "clear to send"', () => {
    const states = new Set(
      ['sarah@acme.com', 'no-reply@acme.com', 'x@y.z'].map((e) => checkSuppression(e).state)
    );
    expect([...states].sort()).toEqual(['CANNOT_DETERMINE', 'SUPPRESSED']);
  });

  it('the undetermined answer names where the real check happens', () => {
    const outcome = checkSuppression('sarah@acme.com');
    expect(outcome.state === 'CANNOT_DETERMINE' && outcome.why).toMatch(/Action Gateway/i);
  });

  /**
   * The two lookups are gone, not repointed at something else. Against a live address they
   * could only produce a false clear or a coincidental match on a seed fixture, and neither is
   * a suppression check.
   */
  it('the seed store is no longer consulted for suppression', () => {
    const fn = engine.slice(
      engine.indexOf('export function checkSuppression'),
      engine.indexOf('export function checkSuppression') + 900
    );
    expect(fn).not.toMatch(/globalStore/);
  });
});

// ===========================================================================
describe('2. the auditor does not certify a check it did not perform', () => {
  /**
   * The line that made the record wrong. `suppression: 'CLEAN'` on the success path, written as
   * a literal beside outcomes that ARE derived from what their checks found.
   */
  it('never records suppression as CLEAN', () => {
    const withoutComments = auditor
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(withoutComments).not.toMatch(/suppression:\s*'CLEAN'/);
  });

  it('records NOT_RUN on the path that reaches the end', () => {
    const withoutComments = auditor
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(withoutComments).toMatch(/suppression:\s*'NOT_RUN'/);
  });

  /** It still BLOCKS on what it can settle. Reporting less must not enforce less. */
  it('still blocks on an address the check does settle', () => {
    expect(auditor).toMatch(/suppression:\s*'VIOLATED'/);
    expect(auditor).toMatch(/severity:\s*'BLOCKING'/);
  });

  /**
   * "Suppression verification clean" was pushed into `checksPassed`, which is the list an
   * operator reads as the things that were checked and found fine.
   */
  it('does not claim in checksPassed that suppression was verified', () => {
    const withoutComments = auditor
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(withoutComments).not.toMatch(/checksPassed\.push\(["'`][^"'`]*[Ss]uppression/);
  });

  /**
   * A gap stated as data. `notAssessed` is the field that exists so a PASS reads as "these
   * controls found nothing" rather than "the draft is safe".
   */
  it('names recipient suppression among what it did not assess', () => {
    expect(auditor).toMatch(/notAssessed\.push\(`Recipient suppression/);
  });
});

// ===========================================================================
/**
 * The control still has to exist somewhere, or reporting the gap honestly would just be an
 * honest account of an absent check. These pin the gateway as the place it lives.
 */
describe('3. the enforcement point is the gateway, reading the live record', () => {
  it('refuses an EMAIL_SEND with no contactId', () => {
    expect(gateway).toMatch(/if \(!request\.payload\.contactId\)/);
  });

  it('refuses when the contact record does not exist, rather than assuming consent', () => {
    expect(gateway).toMatch(/if \(!contactSnap\.exists\(\)\)/);
  });

  it('checks every suppression flag the pipeline can write', () => {
    for (const flag of [
      'suppressed',
      'unsubscribed',
      'hardBounced',
      'complained',
      "emailStatus === 'BOUNCED'",
    ]) {
      expect(gateway).toContain(flag);
    }
  });

  it('treats consent that is not explicitly true as refusal', () => {
    expect(gateway).toMatch(/contactData\.consentGiven !== true/);
  });

  /**
   * And the writer that makes the flags mean something: a permanent delivery failure marks the
   * contact, so the gateway's `hardBounced` check has something to find.
   */
  it('a hard bounce writes the flag the gateway reads', () => {
    const pipeline = readFileSync('server/services/inboundPipeline.ts', 'utf8');
    expect(pipeline).toMatch(/hardBounced: true/);
    expect(pipeline).toMatch(/emailStatus: 'BOUNCED'/);
  });
});
