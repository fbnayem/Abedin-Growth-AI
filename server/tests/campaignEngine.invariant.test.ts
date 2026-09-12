import { describe, it, expect, vi, beforeEach } from 'vitest';
import { memory } from './helpers/memoryDocumentStore';
import { outboxService } from '../services/outbox.service';
import {
  enrolRecipients,
  listRecipients,
  runCampaignTick,
  recipientId,
  MAX_DISPATCH_PER_TICK,
  type ConversationState,
  type EngineDeps,
} from '../services/campaignEngine.service';
import { DEFAULT_LIMITS } from '../domain/campaignSafety';
import { assertTransition, CAMPAIGN_RECIPIENT } from '../domain/stateMachines';
import { DAY_MS } from '../domain/campaignSequence';

vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);
vi.mock('uuid', () => ({ v4: () => `uuid-${Object.keys(memory.docs).length}` }));
vi.mock('../db/index', () => ({ db: new Proxy({}, { get: () => { throw new Error('relational db must not be touched by these tests'); } }), createPool: () => null }));

/**
 * THE SEQUENCE RUNS, AND ONLY AS FAR AS THE GUARDS ALLOW (S26).
 *
 * Enrolment, the tick, reconciliation and the stops, over the memory document store and a
 * conversation lookup this suite controls. The outbox is the real service: a dispatched step is
 * a job it holds, with the idempotency key, the integrity stamp and the review hold a person
 * would see. Nothing here reaches a provider; the worker and the gateway are downstream.
 */

const ORG = 'org-a';
const NOW = new Date('2026-09-14T10:00:00Z'); // Monday, 11:00 in London, 16:00 in Dhaka
const P = (segments: string) => `organizations/${ORG}/${segments}`;

const conversations = new Map<string, ConversationState | null>();
const deps: EngineDeps = {
  conversationState: async (_org, contactId) =>
    conversations.has(contactId) ? conversations.get(contactId)! : { active: false, pendingHuman: false, lastActivityAt: null },
};

function campaign(id: string, overrides: Record<string, unknown> = {}) {
  memory.docs[P(`campaigns/${id}`)] = {
    id,
    name: `Campaign ${id}`,
    status: 'ACTIVE',
    steps: [
      { stepNumber: 1, delayDays: 0, subjectTemplate: 'Quick question, {{firstName}}', bodyTemplate: 'Hi {{firstName}},\n\nHow is {{companyName}} handling growth?' },
      { stepNumber: 2, delayDays: 3, subjectTemplate: 'Following up, {{firstName}}', bodyTemplate: 'Hi {{firstName}}, any thoughts?' },
      { stepNumber: 3, delayDays: 1, stepType: 'LINKEDIN_TASK', subjectTemplate: 'Connect', bodyTemplate: 'Hi {{firstName}}, connect?' },
    ],
    ...overrides,
  };
}

function contact(id: string, overrides: Record<string, unknown> = {}) {
  memory.docs[P(`contacts/${id}`)] = {
    id,
    email: `${id}@analytical.example`,
    firstName: 'Ada',
    companyName: 'Analytical Ltd',
    status: 'NEW',
    consentGiven: true,
    timeZone: 'Europe/London',
    ...overrides,
  };
}

const recipient = (campaignId: string, contactId: string) => memory.docs[P(`campaignEnrolments/${recipientId(campaignId, contactId)}`)] as any;
const jobs = () => Object.entries(memory.docs).filter(([k]) => k.startsWith(P('outbox/'))).map(([, v]) => v as any);
/** What the review console does: HUMAN_REVIEW -> PENDING, a legal move; the worker then claims and sends. */
const release = (jobId: string) => {
  memory.docs[P(`outbox/${jobId}`)] = { ...memory.docs[P(`outbox/${jobId}`)], status: 'PENDING' };
};
/** Released and confirmed sent at a stated instant, so nothing here depends on the wall clock. */
async function processAt(jobId: string, at: number) {
  vi.useFakeTimers({ now: at });
  try {
    release(jobId);
    expect(await outboxService.markProcessed(ORG, jobId, `prov-${jobId}`)).toEqual({ ok: true });
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  memory.reset();
  conversations.clear();
});

// =============================================================================================
describe('1. enrolment', () => {
  it('creates one record per contact in the initial state, due after the first step\'s delay', async () => {
    campaign('c1');
    contact('ada');
    const outcome = await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    expect(outcome).toEqual({ ok: true, results: [{ contactId: 'ada', outcome: 'ENROLLED', recipientId: 'c1__ada', nextStepDueAt: NOW.getTime() }] });
    const r = recipient('c1', 'ada');
    expect(r.status).toBe('ENROLLED');
    expect(CAMPAIGN_RECIPIENT.initial).toContain(r.status);
    expect(r.stepsDone).toBe(0);
    expect(r.emailDomain).toBe('analytical.example');
    expect(r.enrolledBy).toBe('operator:u1');
  });

  it('THE INVARIANT — a second enrolment is refused, and the record it would have overwritten is untouched', async () => {
    campaign('c1');
    contact('ada');
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    memory.docs[P('campaignEnrolments/c1__ada')] = { ...recipient('c1', 'ada'), status: 'REPLIED' };
    const again = await enrolRecipients(ORG, 'c1', ['ada', 'ada'], 'operator:u2', new Date(NOW.getTime() + 1000));
    expect(again).toEqual({ ok: true, results: [{ contactId: 'ada', outcome: 'ALREADY_ENROLLED' }] });
    expect(recipient('c1', 'ada').status).toBe('REPLIED');
    expect(recipient('c1', 'ada').enrolledBy).toBe('operator:u1');
  });

  it('names an unknown contact rather than failing the batch, and refuses a campaign that cannot take enrolments', async () => {
    campaign('c1');
    contact('ada');
    const mixed = await enrolRecipients(ORG, 'c1', ['ghost', 'ada'], 'operator:u1', NOW);
    expect(mixed.ok && mixed.results.map((r) => r.outcome)).toEqual(['UNKNOWN_CONTACT', 'ENROLLED']);
    expect(await enrolRecipients(ORG, 'nope', ['ada'], 'operator:u1', NOW)).toMatchObject({ ok: false, code: 'CAMPAIGN_NOT_FOUND' });
    campaign('done', { status: 'COMPLETED' });
    expect(await enrolRecipients(ORG, 'done', ['ada'], 'operator:u1', NOW)).toMatchObject({ ok: false, code: 'CAMPAIGN_NOT_ENROLLABLE' });
    campaign('empty', { steps: [] });
    expect(await enrolRecipients(ORG, 'empty', ['ada'], 'operator:u1', NOW)).toMatchObject({ ok: false, code: 'NO_STEPS' });
    expect((await listRecipients(ORG, 'c1')).map((r) => r.contactId)).toEqual(['ada']);
  });
});

// =============================================================================================
describe('2. a tick dispatches a due step to the outbox, held for review, stamped, idempotent', () => {
  it('THE INVARIANT — the step becomes an outbox job with the derived key and the integrity stamp, and the recipient is SENDING', async () => {
    campaign('c1');
    contact('ada');
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    const report = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(report.refused).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.dispatched).toHaveLength(1);
    expect(report.dispatched[0]).toMatchObject({ recipientId: 'c1__ada', stepNumber: 1, held: true });
    const [job] = jobs();
    expect(job.idempotencyKey).toBe('campaign:c1:ada:1');
    expect(job.status).toBe('HUMAN_REVIEW');
    expect(job.payload).toEqual({
      to: 'ada@analytical.example',
      subject: 'Quick question, Ada',
      htmlBody: '<p>Hi Ada,</p><p>How is Analytical Ltd handling growth?</p>',
      textBody: 'Hi Ada,\n\nHow is Analytical Ltd handling growth?',
    });
    expect(job.generatedForInboundVersion).toBe(0);
    expect(typeof job.approvalDigest).toBe('string');
    expect(job.conversationId).toBe('camp_c1_ada');
    expect(memory.docs[P('conversations/camp_c1_ada')]).toMatchObject({ contactId: 'ada', campaignId: 'c1', status: 'ACTIVE' });
    const r = recipient('c1', 'ada');
    expect(r.status).toBe('SENDING');
    expect(r.outboxJobId).toBe(job.id);
    expect(r.lastRefusal).toBeNull();
  });

  it('a FULL_AUTOPILOT campaign enqueues PENDING; anything else is held for a person', async () => {
    campaign('auto', { autonomyMode: 'FULL_AUTOPILOT' });
    contact('ada');
    await enrolRecipients(ORG, 'auto', ['ada'], 'operator:u1', NOW);
    const report = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(report.dispatched[0]).toMatchObject({ held: false });
    expect(jobs()[0].status).toBe('PENDING');
  });

  it('THE INVARIANT — a second tick while the job is in flight enqueues nothing', async () => {
    campaign('c1');
    contact('ada');
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    await runCampaignTick(ORG, deps, NOW, 'test');
    const second = await runCampaignTick(ORG, deps, new Date(NOW.getTime() + 60_000), 'test');
    expect(second.dispatched).toEqual([]);
    expect(second.reconciled.inFlight).toBe(1);
    expect(jobs()).toHaveLength(1);
  });

  it('a tick that died after enqueueing is repaired: the outbox already holds the key, and the recipient catches up', async () => {
    campaign('c1');
    contact('ada');
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    await outboxService.queueMessage(ORG, 'camp_c1_ada', { to: 'ada@analytical.example', subject: 's', htmlBody: 'h' }, 'campaign:c1:ada:1');
    const report = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(jobs()).toHaveLength(1);
    expect(report.dispatched).toHaveLength(1);
    expect(recipient('c1', 'ada').outboxJobId).toBe(jobs()[0].id);
  });
});

// =============================================================================================
describe('3. reconciliation advances on what the outbox reports, never on what was intended', () => {
  async function dispatchStepOne() {
    campaign('c1');
    contact('ada');
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    await runCampaignTick(ORG, deps, NOW, 'test');
    return jobs()[0].id as string;
  }

  it('PROCESSED advances to the next step, due its delay after the confirmed send', async () => {
    const jobId = await dispatchStepOne();
    const processedAt = NOW.getTime() + 5 * 60_000;
    await processAt(jobId, processedAt);
    const report = await runCampaignTick(ORG, deps, new Date(processedAt + 60_000), 'test');
    expect(report.reconciled).toMatchObject({ advanced: 1, completed: 0, failed: 0 });
    expect(report.dispatched).toEqual([]);
    const r = recipient('c1', 'ada');
    expect(r.status).toBe('AWAITING_NEXT_STEP');
    expect(r.stepsDone).toBe(1);
    expect(r.sentAt).toEqual([processedAt]);
    expect(r.nextStepDueAt).toBe(processedAt + 3 * DAY_MS);
    expect(r.outboxJobId).toBeNull();
  });

  it('the second step is dispatched when due, the LINKEDIN_TASK step is skipped as not performed, and the sequence completes', async () => {
    const jobId = await dispatchStepOne();
    const sentAt = NOW.getTime() + 5 * 60_000;
    await processAt(jobId, sentAt);
    await runCampaignTick(ORG, deps, new Date(sentAt + 60_000), 'test');
    const early = await runCampaignTick(ORG, deps, new Date(sentAt + 2 * DAY_MS), 'test');
    expect(early.dispatched).toEqual([]);
    expect(early.waiting).toBe(1);
    const due = new Date(sentAt + 3 * DAY_MS + 60_000);
    const later = await runCampaignTick(ORG, deps, due, 'test');
    expect(later.dispatched).toMatchObject([{ stepNumber: 2 }]);
    expect(jobs().map((j) => j.idempotencyKey).sort()).toEqual(['campaign:c1:ada:1', 'campaign:c1:ada:2']);
    const second = jobs().find((j) => j.idempotencyKey === 'campaign:c1:ada:2')!;
    await processAt(second.id, due.getTime() + 60_000);
    const after = await runCampaignTick(ORG, deps, new Date(due.getTime() + 60_000), 'test');
    expect(after.reconciled.advanced).toBe(1);
    // Step 3 is a LinkedIn task: due a day later, skipped when reached, and it is the last step.
    const last = await runCampaignTick(ORG, deps, new Date(due.getTime() + 2 * DAY_MS), 'test');
    expect(last.skipped).toEqual([{ recipientId: 'c1__ada', stepNumber: 3, stepType: 'LINKEDIN_TASK' }]);
    expect(last.reconciled.completed).toBe(1);
    const r = recipient('c1', 'ada');
    expect(r.status).toBe('COMPLETED');
    expect(r.skippedSteps).toEqual([3]);
    expect(r.stepsDone).toBe(3);
    expect(jobs()).toHaveLength(2);
  });

  it('a job the outbox gave up on fails the recipient, with the job named', async () => {
    const jobId = await dispatchStepOne();
    memory.docs[P(`outbox/${jobId}`)] = { ...memory.docs[P(`outbox/${jobId}`)], status: 'DEAD_LETTER' };
    const report = await runCampaignTick(ORG, deps, new Date(NOW.getTime() + 60_000), 'test');
    expect(report.reconciled.failed).toBe(1);
    expect(recipient('c1', 'ada')).toMatchObject({ status: 'FAILED', lastRefusal: { reason: `outbox job ${jobId} is DEAD_LETTER` } });
  });

  it('every state the engine writes is a move the recipient machine permits', () => {
    for (const [from, to] of [
      ['ENROLLED', 'SENDING'],
      ['SENDING', 'AWAITING_NEXT_STEP'],
      ['AWAITING_NEXT_STEP', 'SENDING'],
      ['AWAITING_NEXT_STEP', 'COMPLETED'],
      ['SENDING', 'FAILED'],
      ['ENROLLED', 'SUPPRESSED'],
      ['AWAITING_NEXT_STEP', 'REPLIED'],
      ['ENROLLED', 'CANCELLED'],
      ['ENROLLED', 'UNSUBSCRIBED'],
    ]) {
      expect(assertTransition(CAMPAIGN_RECIPIENT, from, to).ok, `${from} -> ${to}`).toBe(true);
    }
  });
});

// =============================================================================================
describe('4. the guards run on real inputs, and an input that cannot be computed refuses (§14)', () => {
  it('THE INVARIANT — no time zone, no send: QUIET_HOURS cannot run, the refusal is written on the recipient, nothing reaches the outbox', async () => {
    campaign('c1');
    contact('ada', { timeZone: undefined });
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    const report = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(report.dispatched).toEqual([]);
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0].guards).toContain('QUIET_HOURS');
    expect(jobs()).toEqual([]);
    const r = recipient('c1', 'ada');
    expect(r.status).toBe('ENROLLED');
    expect(r.lastRefusal.guards).toContain('QUIET_HOURS');
    expect(r.lastRefusal.at).toBe(NOW.getTime());
  });

  it("at the recipient's 2am the step waits; at their 4pm it goes", async () => {
    campaign('c1');
    contact('dhaka', { timeZone: 'Asia/Dhaka' });
    await enrolRecipients(ORG, 'c1', ['dhaka'], 'operator:u1', NOW);
    const night = await runCampaignTick(ORG, deps, new Date('2026-09-14T20:00:00Z'), 'test'); // 02:00 in Dhaka
    expect(night.refused[0].guards).toEqual(['QUIET_HOURS']);
    const day = await runCampaignTick(ORG, deps, NOW, 'test'); // 16:00 in Dhaka
    expect(day.dispatched).toHaveLength(1);
  });

  it('no consent record, no job: the gateway would refuse it, so the engine does not queue it', async () => {
    campaign('c1');
    contact('ada', { consentGiven: undefined });
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    const report = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(report.refused[0].guards).toEqual(['CONSENT']);
    expect(jobs()).toEqual([]);
  });

  it('a conversation that cannot be read is unknown, and the guards that need it refuse', async () => {
    campaign('c1');
    contact('ada');
    conversations.set('ada', null);
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    const report = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(report.refused[0].guards).toEqual(expect.arrayContaining(['ACTIVE_CONVERSATION', 'PENDING_HUMAN_REPLY']));
    expect(jobs()).toEqual([]);
  });

  it('an open conversation, or a draft awaiting a person, refuses the step', async () => {
    campaign('c1');
    contact('ada');
    conversations.set('ada', { active: true, pendingHuman: false, lastActivityAt: NOW.getTime() - DAY_MS });
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    const report = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(report.refused[0].guards).toEqual(['ACTIVE_CONVERSATION']);
  });

  it('a template the contact cannot fill is refused with the tag named, not sent with the tag in it', async () => {
    campaign('c1');
    contact('ada', { companyName: undefined });
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    const report = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(report.refused[0]).toMatchObject({ guards: ['MERGE_TAGS'], reason: expect.stringContaining('{{companyName}}') });
    expect(jobs()).toEqual([]);
  });

  it('a step with no stated delay is due never, and says so', async () => {
    campaign('c1', { steps: [{ subjectTemplate: 'Hi {{firstName}}', bodyTemplate: 'x' }] });
    contact('ada');
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    expect(recipient('c1', 'ada').nextStepDueAt).toBeNull();
    const report = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(report.refused[0].guards).toEqual(['STEP_DELAY']);
  });

  it('a contact live in two ACTIVE campaigns is refused in both: CONFLICTING_CAMPAIGN', async () => {
    campaign('c1');
    campaign('c2');
    contact('ada');
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    await enrolRecipients(ORG, 'c2', ['ada'], 'operator:u1', NOW);
    const report = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(report.dispatched).toEqual([]);
    expect(report.refused.map((r) => r.guards)).toEqual([['CONFLICTING_CAMPAIGN'], ['CONFLICTING_CAMPAIGN']]);
  });

  it('the per-domain daily limit counts the sends of this very tick, so a burst cannot exceed it inside one tick', async () => {
    campaign('c1');
    for (const id of ['a', 'b', 'c', 'd']) contact(id);
    await enrolRecipients(ORG, 'c1', ['a', 'b', 'c', 'd'], 'operator:u1', NOW);
    const report = await runCampaignTick(ORG, deps, NOW, 'test', { ...DEFAULT_LIMITS, maxPerDomainPerDay: 2 });
    expect(report.dispatched).toHaveLength(2);
    expect(report.refused).toHaveLength(2);
    expect(report.refused.map((r) => r.guards)).toEqual([['PER_DOMAIN_LIMIT'], ['PER_DOMAIN_LIMIT']]);
  });

  it('a tick dispatches at most its bound and reports the rest as waiting', async () => {
    campaign('c1');
    const ids = Array.from({ length: MAX_DISPATCH_PER_TICK + 3 }, (_, i) => `p${i}`);
    for (const id of ids) contact(id, { email: `${id}@domain-${id}.example` });
    await enrolRecipients(ORG, 'c1', ids, 'operator:u1', NOW);
    const report = await runCampaignTick(ORG, deps, NOW, 'test', { ...DEFAULT_LIMITS, maxPerDomainPerDay: 5, maxRecipientsPerDay: 1000 });
    expect(report.dispatched).toHaveLength(MAX_DISPATCH_PER_TICK);
    expect(report.waiting).toBe(3);
  });

  it('the cooldown reads the contact\'s last send across campaigns', async () => {
    campaign('c1');
    contact('ada', { lastContactedAt: new Date(NOW.getTime() - DAY_MS).toISOString() });
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    const report = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(report.refused[0].guards).toEqual(['COOLDOWN']);
  });
});

// =============================================================================================
describe('5. stops: a person who is suppressed, or who has answered, leaves the sequence', () => {
  it('a suppressed contact is SUPPRESSED; an unsubscribed one is UNSUBSCRIBED; neither is sent to', async () => {
    campaign('c1');
    contact('ada', { suppressed: true });
    contact('bob', { suppressed: true, unsubscribedAt: NOW.getTime() - 1000 });
    await enrolRecipients(ORG, 'c1', ['ada', 'bob'], 'operator:u1', NOW);
    const report = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(report.stopped.map((s) => [s.recipientId, s.to])).toEqual([['c1__ada', 'SUPPRESSED'], ['c1__bob', 'UNSUBSCRIBED']]);
    expect(report.dispatched).toEqual([]);
    expect(jobs()).toEqual([]);
  });

  it('a reply after enrolment stops the sequence: REPLIED once something was sent, CANCELLED before', async () => {
    campaign('c1');
    contact('ada');
    contact('bob');
    await enrolRecipients(ORG, 'c1', ['ada', 'bob'], 'operator:u1', NOW);
    await runCampaignTick(ORG, deps, NOW, 'test');
    for (const who of ['ada', 'bob']) {
      await processAt(jobs().find((j) => j.payload.to.startsWith(who))!.id, NOW.getTime() + 5 * 60_000);
    }
    await runCampaignTick(ORG, deps, new Date(NOW.getTime() + 60_000), 'test');
    expect(recipient('c1', 'ada').status).toBe('AWAITING_NEXT_STEP');
    conversations.set('ada', { active: true, pendingHuman: false, lastActivityAt: NOW.getTime() + 120_000 });
    const report = await runCampaignTick(ORG, deps, new Date(NOW.getTime() + 180_000), 'test');
    expect(report.stopped).toEqual([{ recipientId: 'c1__ada', to: 'REPLIED', reason: expect.stringContaining('written since enrolment') }]);
    expect(recipient('c1', 'bob').status).toBe('AWAITING_NEXT_STEP');
    // A reply before the first step: nothing to have replied to, so CANCELLED with the reason.
    contact('cy');
    await enrolRecipients(ORG, 'c1', ['cy'], 'operator:u1', NOW);
    conversations.set('cy', { active: false, pendingHuman: false, lastActivityAt: NOW.getTime() + 1 });
    const again = await runCampaignTick(ORG, deps, new Date(NOW.getTime() + 240_000), 'test');
    expect(again.stopped).toEqual([{ recipientId: 'c1__cy', to: 'CANCELLED', reason: expect.stringContaining('written since enrolment') }]);
  });

  it('a PAUSED campaign waits; a COMPLETED one releases its pending recipients as CANCELLED', async () => {
    campaign('c1', { status: 'PAUSED' });
    contact('ada');
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    const paused = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(paused.dispatched).toEqual([]);
    expect(paused.waiting).toBe(1);
    memory.docs[P('campaigns/c1')] = { ...memory.docs[P('campaigns/c1')], status: 'COMPLETED' };
    const done = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(done.stopped).toEqual([{ recipientId: 'c1__ada', to: 'CANCELLED', reason: 'the campaign is COMPLETED' }]);
  });

  it('a terminal guard refusal leaves the sequence rather than retrying forever', async () => {
    campaign('c1');
    contact('ada', { hardBounced: true, suppressed: false });
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    const report = await runCampaignTick(ORG, deps, NOW, 'test');
    expect(report.stopped[0]).toMatchObject({ recipientId: 'c1__ada', to: 'SUPPRESSED' });
    expect(recipient('c1', 'ada').status).toBe('SUPPRESSED');
  });

  it('a datastore that fails mid-tick is an errored report naming the recipient, not an empty success', async () => {
    campaign('c1');
    contact('ada');
    await enrolRecipients(ORG, 'c1', ['ada'], 'operator:u1', NOW);
    memory.failReadsWith = 'store down';
    try {
      const report = await runCampaignTick(ORG, deps, NOW, 'test');
      expect(report.dispatched).toEqual([]);
      expect(report.errors.map((e) => e.message)).toEqual(['store down']);
    } finally {
      memory.failReadsWith = null;
    }
  });
});
