import { collection, doc, getDoc, getDocs, query, where, runTransaction, store } from '../store';
import { orgPath } from '../tenancy/orgScope';
import { assertTransition, creationState, CAMPAIGN_RECIPIENT } from '../domain/stateMachines';
import {
  evaluateCampaignSafety,
  maySend,
  refusalReason,
  DEFAULT_LIMITS,
  type CampaignLimits,
  type CampaignSafetyInput,
} from '../domain/campaignSafety';
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
  type SequenceStep,
} from '../domain/campaignSequence';
import { outboxService } from './outbox.service';
import { getInboundVersion, computeApprovalDigest } from './draftIntegrity.service';
import { accountDomain } from '../lib/identity';
import { db } from '../db/index';
import { conversations } from '../db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * S26 — THE CAMPAIGN EXECUTION ENGINE.
 *
 * WHAT WAS THERE
 * --------------
 * Fourteen guards on the gateway, a recipient state machine, a campaign document with steps —
 * and no enrolment record, no per-contact sequence state, no scheduler. "The guards protect
 * sequences that cannot run." This is the part that runs them: enrol a contact, find what is
 * due, ask the guards with REAL inputs, render the step, hand it to the outbox, and advance the
 * recipient on what the outbox reports.
 *
 * WHERE THE RECORDS LIVE
 * ----------------------
 * Recipients are documents under `organizations/<org>/campaignEnrolments`, with the id derived
 * from (campaign, contact) so a second enrolment is a refused create rather than a second row —
 * the same device that made duplicate contacts unrepresentable (P1.5). The relational
 * `campaign_recipients` table was declared for this and cannot be used for it: its foreign keys
 * point at the relational `campaigns` and `contacts` tables, and both campaigns and contacts are
 * documents. It is RETIRED in the schema, not used from two sides.
 *
 * WHAT THE ENGINE SENDS
 * ---------------------
 * Nothing. It enqueues an outbox job per step, stamped for the outbox worker's integrity check
 * and held for HUMAN_REVIEW unless the campaign is FULL_AUTOPILOT; the worker dispatches through
 * the gateway, where consent, suppression, capability and the Safe Rebuild Mode flags decide.
 * `REAL_EMAIL_SEND_ENABLED` is false. A sequence can now RUN, which is different from a message
 * leaving.
 *
 * WHAT IT REFUSES, AND RECORDS
 * ----------------------------
 * Every guard input is computed from something that exists — the contact document, the
 * recipient's own send history, the other enrolments, the relational conversations, the
 * contact's stated time zone — and an input that cannot be computed is `undefined`, which the
 * guards treat as NOT RUN and refuse (§14). The most common refusal in this tree will be
 * QUIET_HOURS on a contact with no `timeZone`: that is the correct answer, and the refusal is
 * written on the recipient with the guards named so an operator can see what to supply.
 *
 * Advancement is by RECONCILIATION, not by a hook: a SENDING recipient is advanced when a tick
 * reads its job as PROCESSED, failed when the job is DEAD_LETTER or CANCELLED, and left alone
 * while the job is in flight. A tick that dies between enqueue and the recipient update is
 * repaired by the next one — the idempotency key is derived from (campaign, contact, step), so
 * the outbox returns the job it already has.
 */

export const RECIPIENTS = 'campaignEnrolments';
export const FREQUENCY_WINDOW_MS = 7 * DAY_MS;
export const MAX_DISPATCH_PER_TICK = 25;
const LIVE_STATES: readonly string[] = ['ENROLLED', 'AWAITING_NEXT_STEP', 'SENDING'];
const DUE_STATES: readonly string[] = ['ENROLLED', 'AWAITING_NEXT_STEP'];
const CONVERSATION_ACTIVE_STATES = new Set(['ACTIVE', 'WAITING_ON_PROSPECT', 'MEETING_REQUESTED', 'DEMO_BOOKED']);

export interface RecipientDoc {
  readonly id: string;
  readonly campaignId: string;
  readonly contactId: string;
  readonly emailDomain: string | null;
  readonly status: string;
  /** Steps performed (sent, or skipped as not-an-email step). The next step is `steps[stepsDone]`. */
  readonly stepsDone: number;
  readonly nextStepDueAt: number | null;
  /** Every send the outbox confirmed, newest last. */
  readonly sentAt: number[];
  readonly outboxJobId: string | null;
  readonly conversationId: string | null;
  readonly enrolledAt: number;
  readonly enrolledBy: string;
  readonly lastRefusal: { at: number; guards: string[]; reason: string } | null;
  readonly skippedSteps: number[];
  readonly version: number;
  readonly updatedAt: number;
  readonly statusChangedAt: number;
}

/** What the relational conversations say about a contact, or null when they cannot be read. */
export interface ConversationState {
  readonly active: boolean;
  readonly pendingHuman: boolean;
  /** Last activity on any conversation with this contact; activity after enrolment is a reply. */
  readonly lastActivityAt: number | null;
}

export interface EngineDeps {
  conversationState(orgId: string, contactId: string): Promise<ConversationState | null>;
}

/** The production lookup: the relational conversations the inbound pipeline writes. */
export const relationalConversationState: EngineDeps['conversationState'] = async (orgId, contactId) => {
  try {
    const rows = await db
      .select({ status: conversations.status, lastMessageAt: conversations.lastMessageAt })
      .from(conversations)
      .where(and(eq(conversations.organizationId, orgId), eq(conversations.contactId, contactId)));
    let last: number | null = null;
    for (const row of rows) {
      const at = row.lastMessageAt instanceof Date ? row.lastMessageAt.getTime() : null;
      if (at !== null && (last === null || at > last)) last = at;
    }
    return {
      active: rows.some((r) => CONVERSATION_ACTIVE_STATES.has(r.status)),
      pendingHuman: rows.some((r) => r.status === 'HUMAN_NEEDED'),
      lastActivityAt: last,
    };
  } catch (e: unknown) {
    // Unreadable is unknown: the guards that need this will not run, and the send is refused.
    console.warn(`[campaignEngine] conversations unreadable for ${contactId}:`, messageOf(e));
    return null;
  }
};

export function recipientId(campaignId: string, contactId: string): string {
  return `${campaignId}__${contactId}`;
}

function recipientsCollection(orgId: string) {
  return collection(store, orgPath(orgId, RECIPIENTS));
}

function recipientRef(orgId: string, id: string) {
  return doc(store, orgPath(orgId, RECIPIENTS), id);
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** A stored document read field by field; a field of the wrong shape reads as absent, never as a cast. */
function readRecipient(raw: Record<string, unknown> | undefined): RecipientDoc {
  const data = raw ?? {};
  const refusal = data.lastRefusal;
  const refusalRecord = refusal !== null && typeof refusal === 'object' ? (refusal as Record<string, unknown>) : null;
  return {
    id: str(data.id),
    campaignId: str(data.campaignId),
    contactId: str(data.contactId),
    emailDomain: strOrNull(data.emailDomain),
    status: str(data.status),
    stepsDone: num(data.stepsDone, 0),
    nextStepDueAt: numOrNull(data.nextStepDueAt),
    sentAt: nums(data.sentAt),
    outboxJobId: strOrNull(data.outboxJobId),
    conversationId: strOrNull(data.conversationId),
    enrolledAt: num(data.enrolledAt, 0),
    enrolledBy: str(data.enrolledBy),
    lastRefusal: refusalRecord === null ? null : { at: num(refusalRecord.at, 0), guards: strs(refusalRecord.guards), reason: str(refusalRecord.reason) },
    skippedSteps: nums(data.skippedSteps),
    version: num(data.version, 0),
    updatedAt: num(data.updatedAt, 0),
    statusChangedAt: num(data.statusChangedAt, 0),
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// =============================================================================================
// Enrolment
// =============================================================================================

export type EnrolResult =
  | { readonly contactId: string; readonly outcome: 'ENROLLED'; readonly recipientId: string; readonly nextStepDueAt: number | null }
  | { readonly contactId: string; readonly outcome: 'ALREADY_ENROLLED' | 'UNKNOWN_CONTACT' };

export type EnrolOutcome =
  | { ok: true; results: EnrolResult[] }
  | { ok: false; code: 'CAMPAIGN_NOT_FOUND' | 'CAMPAIGN_NOT_ENROLLABLE' | 'NO_STEPS' | 'STORE_UNAVAILABLE'; message: string };

const ENROLLABLE = new Set(['DRAFT', 'ACTIVE', 'PAUSED']);

/**
 * Enrol contacts in a campaign. Per contact: ENROLLED, ALREADY_ENROLLED (the create refused
 * because the record exists — nothing is overwritten, so a recipient who replied or unsubscribed
 * stays that way), or UNKNOWN_CONTACT. The first step falls due `delayDays` after enrolment;
 * with no stated delay it is due never, and the tick records why.
 */
export async function enrolRecipients(
  orgId: string,
  campaignId: string,
  contactIds: readonly string[],
  actor: string,
  now: Date = new Date()
): Promise<EnrolOutcome> {
  if (!store) return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  const campaignSnap = await getDoc(doc(store, orgPath(orgId, 'campaigns'), campaignId));
  if (!campaignSnap.exists()) return { ok: false, code: 'CAMPAIGN_NOT_FOUND', message: 'No such campaign.' };
  const campaign = campaignSnap.data() as Record<string, unknown>;
  if (!ENROLLABLE.has(String(campaign.status))) {
    return { ok: false, code: 'CAMPAIGN_NOT_ENROLLABLE', message: `A ${String(campaign.status)} campaign does not take enrolments.` };
  }
  const steps = readSteps(campaign);
  if (steps.ok === false) return { ok: false, code: 'NO_STEPS', message: `Nothing to enrol into: ${steps.reason}.` };
  const first = steps.steps[0];
  const results: EnrolResult[] = [];
  for (const contactId of [...new Set(contactIds)]) {
    const contactSnap = await getDoc(doc(store, orgPath(orgId, 'contacts'), contactId));
    if (!contactSnap.exists()) {
      results.push({ contactId, outcome: 'UNKNOWN_CONTACT' });
      continue;
    }
    const contact = contactSnap.data() as Record<string, unknown>;
    const id = recipientId(campaignId, contactId);
    const ref = recipientRef(orgId, id);
    const created = await runTransaction(store, async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists()) return false;
      const creation = creationState(CAMPAIGN_RECIPIENT, undefined);
      if (creation.ok === false) throw new Error(creation.message);
      const due = dueAtFor(first, now);
      const record: RecipientDoc = {
        id,
        campaignId,
        contactId,
        emailDomain: typeof contact.email === 'string' ? safeDomain(contact.email) : null,
        status: creation.state,
        stepsDone: 0,
        nextStepDueAt: due === null ? null : due.getTime(),
        sentAt: [],
        outboxJobId: null,
        conversationId: null,
        enrolledAt: now.getTime(),
        enrolledBy: actor,
        lastRefusal: null,
        skippedSteps: [],
        version: 0,
        updatedAt: now.getTime(),
        statusChangedAt: now.getTime(),
      };
      tx.set(ref, record);
      return true;
    });
    results.push(
      created
        ? { contactId, outcome: 'ENROLLED', recipientId: id, nextStepDueAt: dueAtFor(first, now)?.getTime() ?? null }
        : { contactId, outcome: 'ALREADY_ENROLLED' }
    );
  }
  return { ok: true, results };
}

function safeDomain(email: string): string | null {
  try {
    return accountDomain(email);
  } catch {
    return null;
  }
}

export async function listRecipients(orgId: string, campaignId: string): Promise<RecipientDoc[]> {
  if (!store) return [];
  const snap = await getDocs(query(recipientsCollection(orgId), where('campaignId', '==', campaignId)));
  const out: RecipientDoc[] = [];
  snap.forEach((d) => out.push(readRecipient(d.data())));
  return out.sort((a, b) => a.enrolledAt - b.enrolledAt);
}

// =============================================================================================
// The tick
// =============================================================================================

export interface TickReport {
  readonly orgId: string;
  readonly at: number;
  readonly actor: string;
  readonly campaigns: { active: number; total: number };
  readonly reconciled: { advanced: number; completed: number; failed: number; inFlight: number };
  readonly stopped: { recipientId: string; to: string; reason: string }[];
  readonly dispatched: { recipientId: string; stepNumber: number; outboxJobId: string; held: boolean }[];
  readonly refused: { recipientId: string; stepNumber: number; guards: string[]; reason: string }[];
  readonly skipped: { recipientId: string; stepNumber: number; stepType: string }[];
  /** Due recipients not dispatched this tick: past the per-tick bound, or their campaign is not ACTIVE. */
  waiting: number;
  readonly errors: { recipientId: string; message: string }[];
}

type Patch = Partial<RecipientDoc>;

/** Move a recipient, asking the map inside the transaction. Returns the verdict the map gave. */
async function transition(
  orgId: string,
  id: string,
  to: string,
  patch: Patch,
  now: number
): Promise<{ ok: true; changed: boolean } | { ok: false; message: string }> {
  const ref = recipientRef(orgId, id);
  return runTransaction(store, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return { ok: false as const, message: `recipient ${id} no longer exists` };
    const current = readRecipient(snap.data());
    const verdict = assertTransition(CAMPAIGN_RECIPIENT, current.status, to);
    if (verdict.ok === false) return { ok: false as const, message: verdict.message };
    const next: RecipientDoc = {
      ...current,
      ...patch,
      status: to,
      version: current.version + 1,
      updatedAt: now,
      statusChangedAt: verdict.changed ? now : current.statusChangedAt,
    };
    tx.set(ref, next);
    return { ok: true as const, changed: verdict.changed };
  });
}

/** Change fields without changing state. */
async function patchRecipient(orgId: string, id: string, patch: Patch, now: number): Promise<void> {
  const ref = recipientRef(orgId, id);
  await runTransaction(store, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const current = readRecipient(snap.data());
    tx.set(ref, { ...current, ...patch, version: current.version + 1, updatedAt: now });
  });
}

async function findJobByKey(orgId: string, key: string): Promise<{ id: string; status: string } | null> {
  const snap = await getDocs(query(collection(store, orgPath(orgId, 'outbox')), where('idempotencyKey', '==', key)));
  let found: { id: string; status: string } | null = null;
  snap.forEach((d) => {
    const data = d.data() as Record<string, unknown>;
    found = { id: String(data.id ?? d.id), status: String(data.status) };
  });
  return found;
}

async function ensureConversation(orgId: string, campaignId: string, contactId: string, now: number): Promise<string> {
  const id = `camp_${campaignId}_${contactId}`;
  const ref = doc(store, orgPath(orgId, 'conversations'), id);
  await runTransaction(store, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) return;
    tx.set(ref, {
      id,
      contactId,
      campaignId,
      status: 'ACTIVE',
      source: 'campaign',
      createdAt: new Date(now).toISOString(),
    });
  });
  return id;
}

function isExistingCustomer(contact: Record<string, unknown>): boolean | undefined {
  if (typeof contact.isExistingCustomer === 'boolean') return contact.isExistingCustomer;
  // The CRM status is a fact about the person; "not a customer" is known when the status is.
  if (typeof contact.status === 'string' && contact.status !== '') {
    return contact.status === 'CUSTOMER' || contact.status === 'WON';
  }
  return undefined;
}

function lastContactMs(contact: Record<string, unknown>): number | null {
  const raw = contact.lastContactedAt;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

interface TickContext {
  readonly now: Date;
  readonly campaignsById: Map<string, Record<string, unknown>>;
  readonly all: RecipientDoc[];
  readonly limits: CampaignLimits;
  /** Sends counted so far in this tick, so a burst cannot exceed the daily limits within one tick. */
  readonly dispatchedToday: { count: number; byDomain: Map<string, number> };
}

function safetyInputFor(
  contact: Record<string, unknown>,
  recipient: RecipientDoc,
  conv: ConversationState | null,
  ctx: TickContext
): CampaignSafetyInput {
  const nowMs = ctx.now.getTime();
  const dayStart = utcDayStart(ctx.now);
  const mine = ctx.all.filter((r) => r.contactId === recipient.contactId);
  const sends = mine.flatMap((r) => r.sentAt);
  const lastContact = lastContactMs(contact);
  const lastSend = Math.max(...sends, lastContact ?? Number.NEGATIVE_INFINITY);
  const conflicting = mine.some(
    (r) =>
      r.campaignId !== recipient.campaignId &&
      LIVE_STATES.includes(r.status) &&
      ctx.campaignsById.get(r.campaignId)?.status === 'ACTIVE'
  );
  const sentTodayRows = ctx.all.filter((r) => r.sentAt.some((t) => t >= dayStart));
  const domain = recipient.emailDomain;
  return {
    suppressed: contact.suppressed === true,
    hardBounced: contact.hardBounced === true,
    complained: contact.complained === true,
    wrongPerson: contact.wrongPerson === true,
    isExistingCustomer: isExistingCustomer(contact),
    hasActiveConversation: conv ? conv.active : undefined,
    hasPendingHumanReply: conv ? conv.pendingHuman : undefined,
    contactHistoryLoaded: true,
    sendsInWindow: sends.filter((t) => nowMs - t <= FREQUENCY_WINDOW_MS).length + (lastContact !== null && nowMs - lastContact <= FREQUENCY_WINDOW_MS && !sends.includes(lastContact) ? 1 : 0),
    msSinceLastSend: Number.isFinite(lastSend) ? nowMs - lastSend : null,
    campaignMembershipLoaded: true,
    alreadyInThisCampaign: false,
    inConflictingCampaign: conflicting,
    recipientsToday: sentTodayRows.length + ctx.dispatchedToday.count,
    sendsToThisDomainToday:
      domain === null
        ? undefined
        : sentTodayRows.filter((r) => r.emailDomain === domain).length + (ctx.dispatchedToday.byDomain.get(domain) ?? 0),
    recipientLocalHour: localHourIn(contact.timeZone, ctx.now),
  };
}

/**
 * One tick for one organisation: cancel what belongs to a finished campaign, reconcile what the
 * outbox has reported, stop what has replied or been suppressed, dispatch what is due.
 */
export async function runCampaignTick(
  orgId: string,
  deps: EngineDeps,
  now: Date = new Date(),
  actor = 'scheduler',
  limits: CampaignLimits = DEFAULT_LIMITS
): Promise<TickReport> {
  const nowMs = now.getTime();
  const report: TickReport = {
    orgId,
    at: nowMs,
    actor,
    campaigns: { active: 0, total: 0 },
    reconciled: { advanced: 0, completed: 0, failed: 0, inFlight: 0 },
    stopped: [],
    dispatched: [],
    refused: [],
    skipped: [],
    waiting: 0,
    errors: [],
  };
  if (!store) {
    report.errors.push({ recipientId: '-', message: 'The datastore is not available; nothing was read or written.' });
    return report;
  }

  const campaignsById = new Map<string, Record<string, unknown>>();
  const campaignSnap = await getDocs(query(collection(store, orgPath(orgId, 'campaigns'))));
  campaignSnap.forEach((d) => {
    const data = d.data() as Record<string, unknown>;
    campaignsById.set(String(data.id ?? d.id), data);
  });
  report.campaigns.total = campaignsById.size;
  report.campaigns.active = [...campaignsById.values()].filter((c) => c.status === 'ACTIVE').length;

  const all: RecipientDoc[] = [];
  const recipientSnap = await getDocs(query(recipientsCollection(orgId)));
  recipientSnap.forEach((d) => all.push(readRecipient(d.data())));
  const ctx: TickContext = { now, campaignsById, all, limits, dispatchedToday: { count: 0, byDomain: new Map() } };
  const contactCache = new Map<string, Record<string, unknown> | null>();
  const contactOf = async (contactId: string) => {
    if (!contactCache.has(contactId)) {
      const snap = await getDoc(doc(store, orgPath(orgId, 'contacts'), contactId));
      contactCache.set(contactId, snap.exists() ? (snap.data() as Record<string, unknown>) : null);
    }
    return contactCache.get(contactId)!;
  };
  const conversationCache = new Map<string, ConversationState | null>();
  const conversationOf = async (contactId: string) => {
    if (!conversationCache.has(contactId)) conversationCache.set(contactId, await deps.conversationState(orgId, contactId));
    return conversationCache.get(contactId)!;
  };
  const stepsOf = (campaignId: string): SequenceStep[] | null => {
    const campaign = campaignsById.get(campaignId);
    if (!campaign) return null;
    const read = readSteps(campaign);
    return read.ok ? read.steps : null;
  };

  // 1. A campaign that is finished, or gone, releases its pending recipients.
  for (const r of all) {
    if (!LIVE_STATES.includes(r.status)) continue;
    const campaign = campaignsById.get(r.campaignId);
    if (campaign && campaign.status !== 'COMPLETED') continue;
    const reason = campaign ? 'the campaign is COMPLETED' : 'the campaign no longer exists';
    try {
      const verdict = await transition(orgId, r.id, 'CANCELLED', { lastRefusal: { at: nowMs, guards: [], reason } }, nowMs);
      if (verdict.ok) report.stopped.push({ recipientId: r.id, to: 'CANCELLED', reason });
    } catch (e: unknown) {
      report.errors.push({ recipientId: r.id, message: messageOf(e) });
    }
  }

  // 2. Reconcile what the outbox has reported on the steps in flight.
  for (const r of all) {
    if (r.status !== 'SENDING') continue;
    try {
      const steps = stepsOf(r.campaignId);
      const jobSnap = r.outboxJobId ? await getDoc(doc(store, orgPath(orgId, 'outbox'), r.outboxJobId)) : null;
      const job = jobSnap && jobSnap.exists() ? (jobSnap.data() as Record<string, unknown>) : null;
      const hasMore = steps !== null && r.stepsDone + 1 < steps.length;
      if (job === null) {
        const reason = `outbox job ${r.outboxJobId ?? '(none)'} does not exist`;
        const verdict = await transition(orgId, r.id, 'FAILED', { lastRefusal: { at: nowMs, guards: [], reason } }, nowMs);
        if (verdict.ok) report.reconciled.failed++;
        else report.errors.push({ recipientId: r.id, message: verdict.message });
        continue;
      }
      const to = recipientAfterJob(job.status, hasMore);
      if (to === null) {
        report.reconciled.inFlight++;
        continue;
      }
      if (to === 'FAILED') {
        const reason = `outbox job ${r.outboxJobId} is ${String(job.status)}`;
        const verdict = await transition(orgId, r.id, 'FAILED', { lastRefusal: { at: nowMs, guards: [], reason } }, nowMs);
        if (verdict.ok) report.reconciled.failed++;
        else report.errors.push({ recipientId: r.id, message: verdict.message });
        continue;
      }
      const sentAtMs = num(job.processedAt, num(job.updatedAt, nowMs));
      const done = r.stepsDone + 1;
      const next = steps === null ? null : nextStepFor(steps, done);
      const due = next === null ? null : dueAtFor(next, new Date(sentAtMs));
      const verdict = await transition(
        orgId,
        r.id,
        to,
        { stepsDone: done, sentAt: [...r.sentAt, sentAtMs], nextStepDueAt: due === null ? null : due.getTime(), outboxJobId: null, lastRefusal: null },
        nowMs
      );
      if (!verdict.ok) report.errors.push({ recipientId: r.id, message: verdict.message });
      else if (to === 'COMPLETED') report.reconciled.completed++;
      else report.reconciled.advanced++;
    } catch (e: unknown) {
      report.errors.push({ recipientId: r.id, message: messageOf(e) });
    }
  }

  // Re-read after the writes above, so dispatch sees the reconciled state.
  const current: RecipientDoc[] = [];
  const again = await getDocs(query(recipientsCollection(orgId)));
  again.forEach((d) => current.push(readRecipient(d.data())));
  ctx.all.splice(0, ctx.all.length, ...current);

  // 3. Stops: a person who is suppressed, or who has answered, leaves the sequence.
  for (const r of current) {
    if (!LIVE_STATES.includes(r.status)) continue;
    try {
      const contact = await contactOf(r.contactId);
      if (contact === null) continue;
      if (contact.suppressed === true || contact.hardBounced === true || contact.complained === true) {
        const unsubscribed = contact.unsubscribedAt !== undefined && contact.unsubscribedAt !== null;
        const to = unsubscribed ? 'UNSUBSCRIBED' : 'SUPPRESSED';
        const reason = unsubscribed ? 'the contact unsubscribed' : 'the contact is suppressed';
        const verdict = await transition(orgId, r.id, to, { lastRefusal: { at: nowMs, guards: [], reason } }, nowMs);
        if (verdict.ok) report.stopped.push({ recipientId: r.id, to, reason });
        continue;
      }
      const conv = await conversationOf(r.contactId);
      if (conv && conv.lastActivityAt !== null && conv.lastActivityAt > r.enrolledAt) {
        // ENROLLED has no edge to REPLIED (nothing was sent to reply to); it is CANCELLED, with the reason.
        const to = r.status === 'ENROLLED' ? 'CANCELLED' : 'REPLIED';
        const reason = 'the contact has written since enrolment; a person is in this conversation now';
        const verdict = await transition(orgId, r.id, to, { lastRefusal: { at: nowMs, guards: [], reason } }, nowMs);
        if (verdict.ok) report.stopped.push({ recipientId: r.id, to, reason });
      }
    } catch (e: unknown) {
      report.errors.push({ recipientId: r.id, message: messageOf(e) });
    }
  }
  const stoppedIds = new Set(report.stopped.map((s) => s.recipientId));
  // A recipient the stops could not read is not dispatched on a second attempt in the same tick.
  const erroredIds = new Set(report.errors.map((e) => e.recipientId));

  // 4. Dispatch what is due, oldest first, bounded.
  const due = current
    .filter((r) => DUE_STATES.includes(r.status) && !stoppedIds.has(r.id) && !erroredIds.has(r.id))
    .sort((a, b) => (a.nextStepDueAt ?? Number.MAX_SAFE_INTEGER) - (b.nextStepDueAt ?? Number.MAX_SAFE_INTEGER));
  for (const r of due) {
    if (report.dispatched.length >= MAX_DISPATCH_PER_TICK) {
      report.waiting++;
      continue;
    }
    try {
      const campaign = campaignsById.get(r.campaignId);
      if (!campaign || campaign.status !== 'ACTIVE') {
        report.waiting++;
        continue;
      }
      const stepsRead = readSteps(campaign);
      if (stepsRead.ok === false) {
        await recordRefusal(orgId, r, 0, ['STEPS'], stepsRead.reason, nowMs, report);
        continue;
      }
      const step = nextStepFor(stepsRead.steps, r.stepsDone);
      if (step === null) {
        const verdict = await transition(orgId, r.id, 'COMPLETED', { nextStepDueAt: null }, nowMs);
        if (verdict.ok) report.reconciled.completed++;
        continue;
      }
      if (r.nextStepDueAt === null) {
        await recordRefusal(orgId, r, step.stepNumber, ['STEP_DELAY'], `step ${step.stepNumber} states no delay, so it is due never`, nowMs, report);
        continue;
      }
      if (r.nextStepDueAt > nowMs) {
        report.waiting++;
        continue;
      }
      if (step.stepType !== 'EMAIL') {
        // A task for a person, recorded as not performed; the sequence moves on.
        const done = r.stepsDone + 1;
        const next = nextStepFor(stepsRead.steps, done);
        const nextDue = next === null ? null : dueAtFor(next, now);
        if (next === null) {
          await transition(orgId, r.id, 'COMPLETED', { stepsDone: done, skippedSteps: [...r.skippedSteps, step.stepNumber], nextStepDueAt: null }, nowMs);
          report.reconciled.completed++;
        } else {
          await patchRecipient(orgId, r.id, { stepsDone: done, skippedSteps: [...r.skippedSteps, step.stepNumber], nextStepDueAt: nextDue === null ? null : nextDue.getTime() }, nowMs);
        }
        report.skipped.push({ recipientId: r.id, stepNumber: step.stepNumber, stepType: step.stepType });
        continue;
      }
      const contact = await contactOf(r.contactId);
      if (contact === null) {
        await recordRefusal(orgId, r, step.stepNumber, ['CONTACT'], 'the contact record no longer exists', nowMs, report);
        continue;
      }
      if (contact.consentGiven !== true) {
        // The gateway would refuse this send; refusing here keeps a job that cannot go out of the queue.
        await recordRefusal(orgId, r, step.stepNumber, ['CONSENT'], 'no consent record for this contact (consentGiven is not true)', nowMs, report);
        continue;
      }
      const conv = await conversationOf(r.contactId);
      const decision = evaluateCampaignSafety(safetyInputFor(contact, r, conv, ctx), limits);
      if (maySend(decision) === false) {
        const refusedGuards = decision.results.filter((g) => g.outcome !== 'CLEAN').map((g) => g.guard);
        const stop = stopStateFor(decision.results.filter((g) => g.outcome === 'VIOLATED').map((g) => g.guard));
        if (stop !== null) {
          const reason = refusalReason(decision);
          const verdict = await transition(orgId, r.id, stop, { lastRefusal: { at: nowMs, guards: refusedGuards, reason } }, nowMs);
          if (verdict.ok) report.stopped.push({ recipientId: r.id, to: stop, reason });
          else await recordRefusal(orgId, r, step.stepNumber, refusedGuards, reason, nowMs, report);
          continue;
        }
        await recordRefusal(orgId, r, step.stepNumber, refusedGuards, refusalReason(decision), nowMs, report);
        continue;
      }
      const subject = renderTemplate(step.subjectTemplate, contact);
      const body = renderTemplate(step.bodyTemplate, contact);
      if (subject.ok === false || body.ok === false) {
        const unresolved = [...(subject.ok ? [] : subject.unresolved), ...(body.ok ? [] : body.unresolved)];
        await recordRefusal(orgId, r, step.stepNumber, ['MERGE_TAGS'], `the template names ${unresolved.map((t) => `{{${t}}}`).join(', ')} and the contact has no value for it`, nowMs, report);
        continue;
      }
      const email = typeof contact.email === 'string' ? contact.email : null;
      if (email === null) {
        await recordRefusal(orgId, r, step.stepNumber, ['CONTACT'], 'the contact has no email address', nowMs, report);
        continue;
      }
      const conversationId = await ensureConversation(orgId, r.campaignId, r.contactId, nowMs);
      const inboundVersion = await getInboundVersion(orgId, conversationId);
      const payload = { to: email, subject: subject.text, htmlBody: htmlFromText(body.text), textBody: body.text };
      const approvalDigest = computeApprovalDigest({ organizationId: orgId, conversationId, inboundVersion, ...payload });
      const held = campaign.autonomyMode !== 'FULL_AUTOPILOT';
      const key = `campaign:${r.campaignId}:${r.contactId}:${step.stepNumber}`;
      const queued = await outboxService.queueMessage(
        orgId,
        conversationId,
        payload,
        key,
        { generatedForInboundVersion: inboundVersion, approvalDigest },
        held ? 'HUMAN_REVIEW' : 'PENDING',
        held ? `Campaign step ${step.stepNumber} of ${String(campaign.name ?? r.campaignId)}: the campaign is not FULL_AUTOPILOT, so a person releases each step.` : undefined
      );
      const jobId = queued?.id ?? (await findJobByKey(orgId, key))?.id ?? null;
      if (jobId === null) {
        report.errors.push({ recipientId: r.id, message: 'the outbox neither queued the step nor holds it' });
        continue;
      }
      const verdict = await transition(orgId, r.id, 'SENDING', { outboxJobId: jobId, conversationId, lastRefusal: null }, nowMs);
      if (!verdict.ok) {
        report.errors.push({ recipientId: r.id, message: verdict.message });
        continue;
      }
      ctx.dispatchedToday.count++;
      if (r.emailDomain) ctx.dispatchedToday.byDomain.set(r.emailDomain, (ctx.dispatchedToday.byDomain.get(r.emailDomain) ?? 0) + 1);
      report.dispatched.push({ recipientId: r.id, stepNumber: step.stepNumber, outboxJobId: jobId, held });
    } catch (e: unknown) {
      report.errors.push({ recipientId: r.id, message: messageOf(e) });
    }
  }
  return report;
}

async function recordRefusal(
  orgId: string,
  r: RecipientDoc,
  stepNumber: number,
  guards: string[],
  reason: string,
  nowMs: number,
  report: TickReport
): Promise<void> {
  await patchRecipient(orgId, r.id, { lastRefusal: { at: nowMs, guards, reason } }, nowMs);
  report.refused.push({ recipientId: r.id, stepNumber, guards, reason });
}
