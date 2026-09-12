import { Router, type Request, type Response } from 'express';
import { actionGateway, ActionType } from '../gateway/actionGateway';
import { collection, getDocs, addDoc, store } from '../store';
import { orgScope, orgPath } from '../tenancy/orgScope';
import { sendCaught, sendError } from '../lib/errors';
import { parseInstant, timeZoneRejection, isWithinBusinessHours, DEFAULT_BUSINESS_HOURS, toIsoOrNull } from '../../shared/domain/time';

/**
 * S39 — Meetings and the calendar booking path.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api/meetings`.
 */
export const meetingsRouter = Router();

meetingsRouter.post('/brief', (req: Request, res: Response) => {
  // S39 — Was `res.json({ brief: "Meeting brief generated." })`: the same answer for every request, which is a
  // fabricated result rather than a stub, and the guardrail could not see it because it
  // looked only for `success: true`.
  sendError(req, res, 'NOT_IMPLEMENTED', 'Meeting briefs are not implemented. This endpoint claimed a brief had been generated and generated nothing.');
});

meetingsRouter.post('/:id/sign-contract', (req: Request, res: Response) => {
  // P1.13 — Was `res.json({ success: true })`.
  //
  // Signature is an external action gated by REAL_SIGNATURE_ENABLED. This endpoint
  // reported a contract signed while doing nothing, which is the most consequential
  // false claim in this group.
  //
  // A false success on an external action is the worst shape this defect takes: the
  // operator believes a customer received something, so nobody looks again.
  sendError(
    req,
    res,
    'NOT_IMPLEMENTED',
    "Signature is an external action gated by REAL_SIGNATURE_ENABLED. This endpoint reported a contract signed while doing nothing, which is the most consequential false claim in this group."
  );
});

// P0.15 — Was `res.json({ success: true })`. This is the endpoint the UI calls to take
// payment, and it reported success without contacting any payment provider, creating any
// record, or moving any state. An operator watching the screen would believe a customer had
// paid. A stub that fabricates success for a FINANCIAL action is worse than a missing
// endpoint, so it now refuses honestly. Real payments go through /api/stripe.
meetingsRouter.post('/:id/process-payment', (req: Request, res: Response) =>
  sendError(
    req,
    res,
    'NOT_IMPLEMENTED',
    'Payment processing is not implemented on this endpoint. It previously returned ' +
      'success without taking payment. Use the Stripe checkout flow (/api/stripe/create-checkout-session).'
  )
);

meetingsRouter.post('/:id/send-recovery-email', (req: Request, res: Response) => {
  // P1.13 — Was `res.json({ success: true })`.
  //
  // A recovery email is an external send and must go through the Production Action
  // Gateway. This endpoint sent nothing and said it had.
  //
  // A false success on an external action is the worst shape this defect takes: the
  // operator believes a customer received something, so nobody looks again.
  sendError(
    req,
    res,
    'NOT_IMPLEMENTED',
    "A recovery email is an external send and must go through the Production Action Gateway. This endpoint sent nothing and said it had."
  );
});

meetingsRouter.post('/:id/send-reminder', (req: Request, res: Response) => {
  // P1.13 — Was `res.json({ success: true })`.
  //
  // A meeting reminder is an external send and must go through the Production Action
  // Gateway. This endpoint sent nothing and said it had.
  //
  // A false success on an external action is the worst shape this defect takes: the
  // operator believes a customer received something, so nobody looks again.
  sendError(
    req,
    res,
    'NOT_IMPLEMENTED',
    "A meeting reminder is an external send and must go through the Production Action Gateway. This endpoint sent nothing and said it had."
  );
});

// P0.13 — CALENDAR CONFLICT INVARIANT ON THE LIVE BOOKING PATH.
//
// This is where meetings are ACTUALLY created. The ActionGateway's executeCalendarCreate,
// which contains the free/busy logic, is unreachable: dispatchAction has one call site
// (outbox.worker.ts) and it always passes EMAIL_SEND. So the addendum §31 invariant
// ("free/busy reports busy -> calendar create request count = 0") had no enforcement point
// at all — this handler was a bare addDoc that accepted any body and always said SCHEDULED.
//
// The request is validated and projected (it previously spread `...req.body` straight into
// the document, a mass assignment), an overlap check runs against OUR OWN records, and —
// as of 2026-09-07 — the booking is then dispatched through the ActionGateway as a real
// CALENDAR_CREATE. That gives `dispatchAction` its SECOND call site in the repository and
// gives §31 an enforcement point on the path that actually runs.
//
// The two refusals are not the same refusal, and the distinction is the whole point:
//
//   provider says BUSY / cannot say      -> NO local record either. Zero create requests,
//                                           and we do not record a meeting we know clashes.
//   provider unreachable / flag off      -> local record stands, PENDING_CALENDAR_SYNC.
//                                           Our own meeting list is ours; the Google event
//                                           is a sync, and an unsynced meeting is honest
//                                           where a silently-unsynced one is not.
meetingsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { contactId, scheduledTime, timeZone, durationMinutes, title, notes } = req.body || {};

    // P1.9 — this was `new Date(scheduledTime).getTime()`, which reads an offset-less string
    // such as "2026-09-07T14:00" as the SERVER's local time. On this machine that is six
    // hours from the same string read as UTC, and the route accepted both spellings into one
    // field. `parseInstant` requires an offset, so a string can only mean one moment.
    let startInstant: Date;
    try {
      startInstant = parseInstant(scheduledTime);
    } catch (err: any) {
      return sendError(req, res, 'VALIDATION_ERROR', String(err?.message ?? '`scheduledTime` is not an instant.'));
    }
    const startMs = startInstant.getTime();

    // The zone is required, not defaulted. Defaulting it would be the server asserting what
    // the customer agreed to (§14): a meeting whose zone we guessed is a meeting we cannot
    // honestly restate, and the guess is invisible in the stored row.
    const zoneRejection = timeZoneRejection(timeZone);
    if (zoneRejection !== null) {
      return sendError(
        req,
        res,
        'VALIDATION_ERROR',
        `\`timeZone\` must be an IANA identifier. ${zoneRejection}`
      );
    }
    const duration = Number.isFinite(Number(durationMinutes)) ? Number(durationMinutes) : 30;
    if (duration <= 0 || duration > 480) {
      return sendError(req, res, 'VALIDATION_ERROR', '`durationMinutes` must be between 1 and 480.');
    }
    const endMs = startMs + duration * 60_000;

    // Conflict detection against existing non-cancelled meetings.
    const existingSnap = await getDocs(collection(store, orgPath(orgScope(req), 'meetings')));
    const conflicts: any[] = [];
    existingSnap.forEach((d) => {
      const m: any = d.data();
      if (['CANCELLED', 'NO_SHOW', 'COMPLETED'].includes(m.status)) return;
      const stored = m.startAtUtc ?? m.scheduledTime;
      const mStart = stored?.toMillis?.() ?? new Date(stored || 0).getTime();
      if (!Number.isFinite(mStart) || mStart === 0) return;
      const mEnd = mStart + (Number(m.durationMinutes) || 30) * 60_000;
      // Half-open intervals: [start, end). Touching meetings do not conflict.
      if (mStart < endMs && startMs < mEnd) conflicts.push({ id: m.id, scheduledTime: m.scheduledTime });
    });

    if (conflicts.length > 0) {
      // The invariant: on a confirmed conflict, do NOT create. Zero provider requests, and
      // zero local records that would later be treated as a real booking.
      console.warn(`[meetings] Refused booking: ${conflicts.length} overlapping meeting(s).`);
      return sendError(
        req,
        res,
        'VERSION_CONFLICT',
        `Requested slot overlaps ${conflicts.length} existing meeting(s).`,
        { status: 409, details: { conflicts } }
      );
    }

    // Booking outside the operator's stated hours is refused rather than quietly accepted:
    // an 03:00 meeting is not a meeting, and the caller is told the local time it computed
    // so the disagreement is visible instead of arriving as a calendar invitation.
    const hoursVerdict = isWithinBusinessHours(startInstant, DEFAULT_BUSINESS_HOURS);
    if (hoursVerdict.within === false && req.body?.allowOutsideBusinessHours !== true) {
      return sendError(
        req,
        res,
        'VALIDATION_ERROR',
        `${hoursVerdict.localTime} is outside business hours (${hoursVerdict.reason}). ` +
          'Send `allowOutsideBusinessHours: true` to book it deliberately.'
      );
    }

    // P0.13/S31 — free/busy on the live path.
    //
    // The idempotency key is derived from the booking itself, so retrying the same request
    // asks Google for the SAME conference rather than minting a second Meet link for one
    // meeting (the old `requestId: "req_" + Date.now()` did exactly that).
    const idempotencyKey = [
      orgScope(req),
      contactId ?? "no-contact",
      String(startMs),
      String(duration),
    ].join(":");

    const dispatchResult = await actionGateway.dispatchAction({
      actionType: ActionType.CALENDAR_CREATE,
      organizationId: orgScope(req),
      targetId: contactId ?? "unknown",
      proposedBy: "POST /api/meetings",
      payload: {
        title: title ?? "Meeting",
        description: notes ?? undefined,
        startTime: startInstant.toISOString(),
        endTime: new Date(endMs).toISOString(),
        timezone: timeZone,
        attendees: [],
        idempotencyKey,
      },
    });

    // A conflict the PROVIDER reported, or an availability we could not read, refuses the
    // booking outright. §31 asks how many create requests are issued when free/busy says
    // busy; the gateway issues zero, and this keeps the local record consistent with that.
    if (dispatchResult.errorCode === 'CALENDAR_CONFLICT' || dispatchResult.errorCode === 'AVAILABILITY_UNKNOWN') {
      return sendError(
        req,
        res,
        'VERSION_CONFLICT',
        dispatchResult.blockedReason ?? dispatchResult.error ?? "The slot is not available.",
        { status: 409, details: { errorCode: dispatchResult.errorCode } }
      );
    }

    // Anything else that failed leaves the meeting recorded but explicitly unsynced. The
    // reason travels with the record so the operator sees WHY nothing was booked, rather
    // than a status that merely says PENDING forever.
    const providerEventId =
      dispatchResult.success === true ? dispatchResult.providerResult?.eventId ?? null : null;
    const meetUrl =
      dispatchResult.success === true ? dispatchResult.providerResult?.conferenceUrl ?? null : null;
    const providerSyncStatus =
      dispatchResult.success === true ? 'SYNCED' : 'PENDING_CALENDAR_SYNC';
    const providerSyncReason =
      dispatchResult.success === true
        ? null
        : dispatchResult.blockedReason ?? dispatchResult.error ?? "Calendar sync did not run.";

    const payload = {
      id: "meet_" + Date.now(),
      contactId: contactId ?? null,
      title: title ?? null,
      notes: notes ?? null,
      // Both halves. `startAtUtc` is the instant the calendar needs; `timeZone` is what the
      // customer agreed to, and it is the half that cannot be recovered later if dropped.
      startAtUtc: new Date(startMs),
      timeZone: timeZone,
      durationMinutes: duration,
      status: 'SCHEDULED',
      // Honest about provider state, and now able to say something other than "pending":
      // this reports what the dispatch actually returned rather than a constant.
      providerSyncStatus,
      providerEventId,
      providerSyncReason,
      meetUrl,
      createdAt: new Date(),
    };
    await addDoc(collection(store, orgPath(orgScope(req), 'meetings')), payload);
    res.json(payload);
  } catch(e: any) { sendCaught(req, res, e); }
});

meetingsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const dbMeetingsSnap = await getDocs(collection(store, orgPath(orgScope(req), 'meetings'))); const dbMeetings: any[] = []; dbMeetingsSnap.forEach(d => dbMeetings.push(d.data()));
    const mapped = dbMeetings.map(m => ({
      id: m.id,
      contactId: m.contactId,
      prospectName: "Unknown",
      prospectEmail: "unknown@example.com",
      companyName: "Unknown",
      status: m.status,
      // Found by a runtime probe, not by the compiler or the tests: the stored value comes
      // back from Firestore as a `Timestamp`, which has `toMillis()` and `toDate()` and NOT
      // `toISOString()`. The original line was `m.scheduledTime.toISOString()`, so this
      // endpoint has been answering `scheduledAt: undefined` for every meeting it has ever
      // returned — a 200 carrying a field that was never populated.
      scheduledAt: toIsoOrNull(m.startAtUtc ?? m.scheduledTime),
      timeZone: m.timeZone ?? null,
      durationMinutes: m.durationMinutes ?? null,
      meetLink: m.meetUrl,
    }));
    res.json(mapped);
  } catch(e) { console.error(e); sendCaught(req, res, e); }
});
