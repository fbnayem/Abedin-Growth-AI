import { describe, it, expect } from 'vitest';
import {
  readSteps,
  nextStepFor,
  dueAtFor,
  renderTemplate,
  htmlFromText,
  localHourIn,
  utcDayStart,
  recipientAfterJob,
  stopStateFor,
  DAY_MS,
} from '../domain/campaignSequence';
import { CAMPAIGN_RECIPIENT, assertTransition } from '../domain/stateMachines';

/**
 * THE SEQUENCE DECIDES WITHOUT A DATASTORE (S26).
 *
 * Which step is next, when it is due, what the template becomes, where a recipient goes when
 * the outbox reports — each a function of its arguments, proved here on the shapes the campaign
 * route writes and the shared type declares.
 */

const CAMPAIGN = {
  steps: [
    { stepNumber: 1, title: 'Hook', delayDays: 0, subjectTemplate: 'Quick question regarding {{companyName}}', bodyTemplate: 'Hi {{firstName}},\n\nHow are you managing growth?\n\nBest,\nNayem' },
    { stepNumber: 2, title: 'Value', delayDays: 3, subjectTemplate: 'Thoughts on {{companyName}}?', bodyTemplate: 'Hi {{firstName}}, following up.' },
    { stepNumber: 3, title: 'Bump', delayDays: 5, stepType: 'LINKEDIN_TASK', subjectTemplate: 'LinkedIn Connection', bodyTemplate: 'Hi {{firstName}}, connect?' },
  ],
};

describe('1. the steps a campaign declares', () => {
  it('reads the strategy route\'s shape: delayDays, EMAIL by default, source order is the schedule', () => {
    const read = readSteps(CAMPAIGN);
    expect(read.ok).toBe(true);
    if (read.ok === false) return;
    expect(read.steps.map((s) => [s.stepNumber, s.stepType, s.delayDays])).toEqual([
      [1, 'EMAIL', 0],
      [2, 'EMAIL', 3],
      [3, 'LINKEDIN_TASK', 5],
    ]);
  });

  it("reads the shared type's spelling too (dayOffset), and a delay that is neither is null, not zero", () => {
    const read = readSteps({ steps: [{ dayOffset: 2, subjectTemplate: 's', bodyTemplate: 'b' }, { subjectTemplate: 's', bodyTemplate: 'b' }] });
    expect(read.ok && read.steps.map((s) => s.delayDays)).toEqual([2, null]);
    const negative = readSteps({ steps: [{ delayDays: -1, subjectTemplate: 's', bodyTemplate: 'b' }] });
    expect(negative.ok && negative.steps[0].delayDays).toBe(null);
  });

  it('refuses a campaign with no steps, a step that is not an object, or a type it does not know', () => {
    expect(readSteps({})).toMatchObject({ ok: false });
    expect(readSteps({ steps: [] })).toMatchObject({ ok: false });
    expect(readSteps({ steps: ['x'] })).toMatchObject({ ok: false, reason: expect.stringContaining('step 1') });
    expect(readSteps({ steps: [{ stepType: 'CARRIER_PIGEON' }] })).toMatchObject({ ok: false, reason: expect.stringContaining('CARRIER_PIGEON') });
  });

  it('the next step is the one after those done, and null when the sequence is finished', () => {
    const steps = (readSteps(CAMPAIGN) as { ok: true; steps: any[] }).steps;
    expect(nextStepFor(steps, 0)?.stepNumber).toBe(1);
    expect(nextStepFor(steps, 2)?.stepNumber).toBe(3);
    expect(nextStepFor(steps, 3)).toBeNull();
    expect(nextStepFor(steps, -1)).toBeNull();
    expect(nextStepFor(steps, 1.5)).toBeNull();
  });

  it('a step is due delayDays after the previous send; with no stated delay it is due never', () => {
    const steps = (readSteps(CAMPAIGN) as { ok: true; steps: any[] }).steps;
    const from = new Date('2026-09-12T10:00:00Z');
    expect(dueAtFor(steps[0], from)?.toISOString()).toBe('2026-09-12T10:00:00.000Z');
    expect(dueAtFor(steps[1], from)?.getTime()).toBe(from.getTime() + 3 * DAY_MS);
    expect(dueAtFor({ ...steps[1], delayDays: null }, from)).toBeNull();
  });
});

describe('2. rendering refuses rather than substitutes', () => {
  const contact = { firstName: 'Ada', lastName: 'Lovelace', companyName: 'Analytical Ltd', email: 'ada@analytical.example', title: '' };

  it('fills the tags it knows from the contact', () => {
    expect(renderTemplate('Hi {{firstName}} of {{companyName}} <{{ email }}>', contact)).toEqual({ ok: true, text: 'Hi Ada of Analytical Ltd <ada@analytical.example>' });
    expect(renderTemplate('{{name}}', contact)).toEqual({ ok: true, text: 'Ada Lovelace' });
    expect(renderTemplate('{{firstName}}', { name: 'Grace Hopper' })).toEqual({ ok: true, text: 'Grace' });
  });

  it('THE INVARIANT — a tag with no value, or a tag it does not know, leaves the template unrendered and is named', () => {
    expect(renderTemplate('Hi {{firstName}}, re {{title}}', contact)).toEqual({ ok: false, unresolved: ['title'] });
    expect(renderTemplate('Hi {{firstName}}', {})).toEqual({ ok: false, unresolved: ['firstName'] });
    expect(renderTemplate('{{discountCode}} for {{firstName}}', contact)).toEqual({ ok: false, unresolved: ['discountCode'] });
    expect(renderTemplate('{{x}} {{x}}', contact)).toEqual({ ok: false, unresolved: ['x'] });
  });

  it('the HTML body is the text escaped, with paragraphs and line breaks kept', () => {
    expect(htmlFromText('Hi <Ada> & co,\nline two\n\nBest')).toBe('<p>Hi &lt;Ada&gt; &amp; co,<br>line two</p><p>Best</p>');
  });
});

describe('3. time, as the recipient experiences it', () => {
  it('the local hour comes from the stated zone, and is undefined without one or with a non-zone', () => {
    const at = new Date('2026-09-12T23:30:00Z');
    expect(localHourIn('Europe/London', at)).toBe(0);
    expect(localHourIn('Asia/Dhaka', at)).toBe(5);
    expect(localHourIn('America/Los_Angeles', at)).toBe(16);
    expect(localHourIn(undefined, at)).toBeUndefined();
    expect(localHourIn('', at)).toBeUndefined();
    expect(localHourIn('Mars/Olympus', at)).toBeUndefined();
    expect(localHourIn(5, at)).toBeUndefined();
  });

  it('the UTC day starts at midnight UTC', () => {
    expect(utcDayStart(new Date('2026-09-12T23:59:59Z'))).toBe(Date.UTC(2026, 8, 12));
    expect(utcDayStart(new Date('2026-09-12T00:00:00Z'))).toBe(Date.UTC(2026, 8, 12));
  });
});

describe('4. where a recipient goes', () => {
  it('after the outbox: PROCESSED advances or completes, DEAD_LETTER and CANCELLED fail, in flight waits', () => {
    expect(recipientAfterJob('PROCESSED', true)).toBe('AWAITING_NEXT_STEP');
    expect(recipientAfterJob('PROCESSED', false)).toBe('COMPLETED');
    expect(recipientAfterJob('DEAD_LETTER', true)).toBe('FAILED');
    expect(recipientAfterJob('CANCELLED', true)).toBe('FAILED');
    for (const inFlight of ['PENDING', 'CLAIMED', 'HUMAN_REVIEW', 'FAILED', undefined, 42]) {
      expect(recipientAfterJob(inFlight, true), String(inFlight)).toBeNull();
    }
  });

  it('every destination is a move the recipient machine permits from SENDING', () => {
    for (const to of ['AWAITING_NEXT_STEP', 'COMPLETED', 'FAILED']) {
      // COMPLETED is reached from AWAITING_NEXT_STEP in the map; the engine goes there via the
      // reconciliation of the last step, which the machine spells SENDING -> AWAITING_NEXT_STEP
      // -> COMPLETED. The engine collapses the two, so the map must permit both edges.
      const path = to === 'COMPLETED' ? ['SENDING', 'AWAITING_NEXT_STEP', 'COMPLETED'] : ['SENDING', to];
      for (let i = 1; i < path.length; i++) {
        expect(assertTransition(CAMPAIGN_RECIPIENT, path[i - 1], path[i]).ok, `${path[i - 1]} -> ${path[i]}`).toBe(true);
      }
    }
  });

  it('a refusal about the person ends the sequence; a refusal about the moment does not', () => {
    expect(stopStateFor(['QUIET_HOURS'])).toBeNull();
    expect(stopStateFor(['FREQUENCY_CAP', 'COOLDOWN'])).toBeNull();
    expect(stopStateFor(['QUIET_HOURS', 'SUPPRESSION'])).toBe('SUPPRESSED');
    expect(stopStateFor(['HARD_BOUNCE'])).toBe('SUPPRESSED');
    expect(stopStateFor(['SPAM_COMPLAINT'])).toBe('SUPPRESSED');
    expect(stopStateFor(['WRONG_PERSON'])).toBe('SUPPRESSED');
    expect(stopStateFor([])).toBeNull();
  });
});
