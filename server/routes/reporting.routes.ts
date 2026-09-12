import { Router, type Request, type Response } from 'express';
import { collection, getDocs, doc, query, orderBy, limit, store } from '../store';
import { orgScope, orgPath } from '../tenancy/orgScope';
import { sendCaught, sendError } from '../lib/errors';

/**
 * S39 — Reporting: the dashboard, the funnel, and the run log.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api`.
 */
export const reportingRouter = Router();

reportingRouter.get('/logs', async (req: Request, res: Response) => {
  try {
    // This ordered by `timestamp`. The only AIRunLog shape in the repository uses
    // `createdAt` and has no `timestamp` field at all — and Firestore EXCLUDES documents
    // that lack the ordered field, so this route would have returned [] even after a writer
    // was added, silently, with HTTP 200. An empty observability surface reading as "no
    // problems" is the §14 failure applied to logs.
    //
    // `writerExists` is true since server/lib/runLog.ts landed: the inbound pipeline writes
    // one row per run, on every exit path including the failures. An empty list now means
    // no run has happened, which is a different fact from "nothing records them" — and
    // saying which is the whole reason this field is here rather than a bare array.
    const snap = await getDocs(query(collection(store, orgPath(orgScope(req), 'ai_run_logs')), orderBy('createdAt', 'desc'), limit(50)));
    const items: any[] = [];
    snap.forEach((d: any) => items.push(d.data()));
    res.json({
      items,
      writerExists: true,
      note:
        items.length === 0
          ? 'No runs have been recorded for this organisation yet. The inbound pipeline writes ' +
            'one row per run, so an empty list here means no message has been processed — not ' +
            'that runs go unrecorded.'
          : null,
    });
  } catch(e: any) { sendCaught(req, res, e); }
});

reportingRouter.get('/dashboard', async (req: Request, res: Response) => {
  try {
    if (!store) return sendError(req, res, 'STORE_UNAVAILABLE', 'The datastore is not available.');
    const orgId = orgScope(req);

    const contactsSnap = await getDocs(collection(store, orgPath(orgId, 'contacts')));
    let qualifiedLeadsCount = 0;
    contactsSnap.forEach(doc => {
       const s = doc.data().status;
       if (s === "QUALIFIED" || s === "ENGAGED" || s === "DEMO_SCHEDULED") qualifiedLeadsCount++;
    });

    const convsSnap = await getDocs(collection(store, orgPath(orgId, 'conversations')));
    let positiveConversationsCount = 0;
    convsSnap.forEach(doc => {
       const s = doc.data().status;
       if (s === "ACTIVE" || s === "HUMAN_NEEDED" || s === "MEETING_REQUESTED") positiveConversationsCount++;
    });

    const meetingsSnap = await getDocs(collection(store, orgPath(orgId, 'meetings')));
    let meetingsBookedCount = 0;
    meetingsSnap.forEach(doc => {
       if (doc.data().status === "CONFIRMED") meetingsBookedCount++;
    });

    const oppsSnap = await getDocs(collection(store, orgPath(orgId, 'opportunities')));
    let pipelineValue = 0;
    oppsSnap.forEach(doc => {
        // `value` comes back from the store as `unknown` rather than the SDK's `any`.
        // Coerced explicitly: a non-numeric value used to be added straight into the total,
        // where `undefined` would have turned the whole pipeline figure into NaN.
        const value = Number(doc.data().value);
        pipelineValue += Number.isFinite(value) ? value : 0;
    });

    res.json({
      kpis: {
        qualifiedLeads: qualifiedLeadsCount,
        positiveConversations: positiveConversationsCount,
        meetingsBooked: meetingsBookedCount,
        pipelineValue,
        investorConversations: 0,
        partnerConversations: 0,
        projectedMonthlyRevenue: Math.floor(pipelineValue * 0.15),
      },
      attentionItems: [],
      dailyBrief: [],
      status: "AI Growth Engine: Active",
    });
  } catch (e) {
    console.error(e);
    sendCaught(req, res, e);
  }
});

reportingRouter.get('/analytics/funnel', async (req: Request, res: Response) => {
  try {
    const allContactsSnap = await getDocs(collection(store, orgPath(orgScope(req), 'contacts'))); const allContacts: any[] = []; allContactsSnap.forEach(d => allContacts.push(d.data()));
    const allConvsSnap = await getDocs(collection(store, orgPath(orgScope(req), 'conversations'))); const allConvs: any[] = []; allConvsSnap.forEach(d => allConvs.push(d.data()));
    const allMeetingsSnap = await getDocs(collection(store, orgPath(orgScope(req), 'meetings'))); const allMeetings: any[] = []; allMeetingsSnap.forEach(d => allMeetings.push(d.data()));

    const discovered = allContacts.length;
    const qualified = 15; // mock complex AI score for now
    const outreachSent = allConvs.length;
    const opened = allConvs.filter(c => c.status !== 'NEW').length;
    const replied = allConvs.filter(c => c.status === 'REPLIED').length;
    const positive = allConvs.filter(c => c.intentConfidence && c.intentConfidence > 0.8).length || 3;
    const demoBooked = allMeetings.length;

    res.json({
      funnel: [
        { label: "1. Discovered", count: discovered, dropoff: "100%", color: "bg-slate-700" },
        { label: "2. AI Qualified (Score > 80)", count: qualified, dropoff: discovered ? `${((qualified/discovered)*100).toFixed(1)}%` : "0%", color: "bg-blue-600" },
        { label: "3. Outreach Sent", count: outreachSent, dropoff: qualified ? `${((outreachSent/qualified)*100).toFixed(1)}%` : "0%", color: "bg-indigo-600" },
        { label: "4. Opened", count: opened, dropoff: outreachSent ? `${((opened/outreachSent)*100).toFixed(1)}% Open Rate` : "0%", color: "bg-purple-600" },
        { label: "5. Replied", count: replied, dropoff: opened ? `${((replied/opened)*100).toFixed(1)}% Reply Rate` : "0%", color: "bg-amber-600" },
        { label: "6. Positive Intent", count: positive, dropoff: replied ? `${((positive/replied)*100).toFixed(1)}% Positivity` : "0%", color: "bg-emerald-600" },
        { label: "7. Demo Booked", count: demoBooked, dropoff: positive ? `${((demoBooked/positive)*100).toFixed(1)}% Conversion` : "0%", color: "bg-emerald-500" },
      ]
    });
  } catch(e) {
    console.error(e);
    res.json({ funnel: [] });
  }
});
