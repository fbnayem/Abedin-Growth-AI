import { Router, type Request, type Response } from 'express';
import { collection, getDocs, getDoc, addDoc, doc, store } from '../store';
import { orgScope, orgPath } from '../tenancy/orgScope';
import { assertTransition, CAMPAIGN } from '../domain/stateMachines';
import { sendCaught, sendError } from '../lib/errors';
import { parsedBodyOr400 } from '../lib/parsedBody';
import { expectedVersionFrom, mutateWithVersion, sendMutationOutcome, sendVersionRequired, versionOf } from '../lib/concurrency';
import { enrolRecipients, listRecipients, runCampaignTick, relationalConversationState } from '../services/campaignEngine.service';

/**
 * S39 — Campaigns.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api/campaigns`.
 */
export const campaignsRouter = Router();

campaignsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const snap = await getDocs(collection(store, orgPath(orgScope(req), 'campaigns')));
    const items: any[] = [];
    // P1.3 — The version travels with every row. A client cannot state the version it is
    // updating unless the read gives it one, so omitting this would make the write path
    // impossible to use correctly rather than merely easy to use incorrectly.
    snap.forEach((d: any) => items.push({ ...d.data(), version: versionOf(d.data(), true) }));
    res.json(items);
  } catch(e: any) { sendCaught(req, res, e); }
});

/**
 * P1.3/P1.4 — Campaign pause and resume.
 *
 * This was a TOGGLE: read the status, negate it, write it back, in two round trips. A toggle
 * cannot express intent — the request says "the other one", not what the operator wanted —
 * so two clicks in the same second both read ACTIVE and both write PAUSED, and a campaign an
 * operator meant to stop keeps running with the UI showing it stopped.
 *
 * The caller now states the status it wants and the version it read. Asking for the status a
 * campaign is already in succeeds without incrementing the version: pausing something already
 * paused is the operator getting what they asked for, not a conflict.
 */
export const setCampaignStatus = async (req: Request, res: Response) => {
  try {
    // S39 — validated before the read: the state must be one the machine knows and the body
    // may carry nothing else. Both spellings of the route share this handler and this contract.
    const body = parsedBodyOr400(req, res, 'POST /api/campaigns/:id/status');
    if (body === null) return;
    const desired = body.status;
    const docRef = doc(store, orgPath(orgScope(req), 'campaigns'), req.params.id);
    const snap = await getDoc(docRef);
    if (!snap.exists()) {
      return sendError(req, res, 'NOT_FOUND', 'No such campaign.');
    }

    const current: any = snap.data();
    const currentVersion = versionOf(current, true);

    // P1.4 — The legal set and the legal MOVES both come from the one transition map, so an
    // ARCHIVED campaign cannot be reactivated and a COMPLETED one cannot be paused. Neither
    // rule was expressible when this was a toggle.
    const verdict = assertTransition(CAMPAIGN, current.status, desired);
    if (verdict.ok === false) {
      return sendError(req, res, verdict.code, verdict.message, { status: 422 });
    }
    if (verdict.changed === false) {
      res.setHeader('ETag', `"${currentVersion}"`);
      return res.json({ ...current, version: currentVersion });
    }

    const expected = expectedVersionFrom(req);
    if (expected.ok === false) return sendVersionRequired(req, res, expected, currentVersion);

    const outcome = await mutateWithVersion(docRef, expected.value, (existing: any) => ({
      ...existing,
      status: desired,
      statusChangedAt: new Date().toISOString(),
    }));
    return sendMutationOutcome(req, res, outcome);
  } catch(e: any) { sendCaught(req, res, e); }
};

// Both spellings: /status is what it does, /toggle is what existing callers send.
campaignsRouter.post('/:id/status', setCampaignStatus);

campaignsRouter.post('/:id/toggle', setCampaignStatus);

/**
 * S26 — enrol contacts. One record per (campaign, contact), created only if absent, so a second
 * enrolment reports ALREADY_ENROLLED and overwrites nothing. The first step is due after its
 * stated delay; the tick decides everything else, with the guards.
 */
campaignsRouter.post('/:id/recipients', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/campaigns/:id/recipients');
    if (body === null) return;
    const actor = `operator:${req.tenant?.uid ?? 'unknown'}`;
    const outcome = await enrolRecipients(orgScope(req), req.params.id, body.contactIds, actor);
    if (outcome.ok === false) {
      if (outcome.code === 'CAMPAIGN_NOT_FOUND') return sendError(req, res, 'NOT_FOUND', outcome.message);
      if (outcome.code === 'STORE_UNAVAILABLE') return sendError(req, res, 'STORE_UNAVAILABLE', outcome.message);
      return sendError(req, res, 'VALIDATION_ERROR', outcome.message, { status: 422, details: { code: outcome.code } });
    }
    res.status(201).json({
      campaignId: req.params.id,
      enrolled: outcome.results.filter((r) => r.outcome === 'ENROLLED').length,
      results: outcome.results,
    });
  } catch (e: any) { sendCaught(req, res, e); }
});

campaignsRouter.get('/:id/recipients', async (req: Request, res: Response) => {
  try {
    const recipients = await listRecipients(orgScope(req), req.params.id);
    res.json({ campaignId: req.params.id, count: recipients.length, recipients });
  } catch (e: any) { sendCaught(req, res, e); }
});

/**
 * S26 — one tick, now, for this organisation, by this operator. What the scheduler would do on
 * its interval, run by hand and answered with the report: what was reconciled, what was
 * dispatched (to the outbox, not to the network), what was refused and by which guards.
 */
campaignsRouter.post('/run-tick', async (req: Request, res: Response) => {
  try {
    const actor = `operator:${req.tenant?.uid ?? 'unknown'}`;
    const report = await runCampaignTick(orgScope(req), { conversationState: relationalConversationState }, new Date(), actor);
    res.json({ report });
  } catch (e: any) { sendCaught(req, res, e); }
});

campaignsRouter.post('/generate-strategy', async (req: Request, res: Response) => {
  try {
    const { name, engineType, targetAudience, targetIndustries, targetLocations, enrolledCount, isABTestingEnabled } = req.body;

    const projectedReach = enrolledCount || 0;

    // S27 — the 68% and 12% are gone.
    //
    // They were `Math.floor(projectedReach * 0.68)` and `* 0.12`, persisted onto the campaign
    // as `projectedMetrics` and rendered as a projection. Nothing measured them: this system
    // has never sent an autonomous email, there is no open pixel, no click redirect and no
    // bounce webhook, so there is no engagement history for any rate to have come from.
    //
    // The worst case in S27 is a founder scaling spend on `enrolledCount * 0.68` and
    // reporting it to an investor. A number with no source is worse than a blank, because a
    // blank prompts the question and a number answers it.

    // S6 — DRAFT, because that is the only state `CAMPAIGN.initial` declares, and the machine
    // says ACTIVE is reachable only FROM draft. This is a deliberate behaviour change: a new
    // campaign is no longer born in the state that means "sending". The console already renders
    // DRAFT — it has a filter chip for it — and its toggle sends DRAFT -> ACTIVE, which the map
    // permits, so activating is one click and is now a decision somebody makes rather than a
    // default nobody chose.
    const newCampaign = {
      id: "camp_" + Date.now(),
      name: name || "Untitled Campaign",
      engineType: engineType || "CUSTOMER",
      status: "DRAFT",
      targetAudience: targetAudience || "",
      targetLocations: targetLocations || [],
      targetIndustries: targetIndustries || [],
      enrolledCount: projectedReach,
      sentCount: 0,
      openedCount: 0,
      repliedCount: 0,
      convertedCount: 0,
      // Reach is the enrolment count, which is a fact. Engagement and conversion are not
      // reported at all until something measures them.
      projectedMetrics: { reach: projectedReach, engagement: null, conversion: null, why: 'not measured: no open, click or bounce ingestion exists' },
      aiStrategySummary: `Generated custom sequence for ${targetAudience}. Leveraging local market context for ${(targetLocations || []).join(', ')}. ${isABTestingEnabled ? "A/B Testing automatically configured across 2 variants." : ""}`,
      steps: [
        {
           stepNumber: 1,
           title: "The Vision Hook",
           delayDays: 0,
           subjectTemplate: "Quick question regarding {{companyName}}",
           bodyTemplate: "Hi {{firstName}},\n\nI noticed you're a leader in the ${(targetIndustries || [])[0] || 'space'} in ${(targetLocations || [])[0] || 'your area'}. How are you currently managing growth?\n\nBest,\nNayem"
        },
        {
           stepNumber: 2,
           title: "The Value Add",
           delayDays: 3,
           subjectTemplate: "Thoughts on {{companyName}}?",
           bodyTemplate: "Hi {{firstName}},\n\nJust following up on my previous note. We recently helped a similar company scale their operations by 40%.\n\nLet me know if you'd like to see a quick demo.\n\nBest,\nNayem"
        },
        {
           stepNumber: 3,
           title: "Multi-channel Bump",
           delayDays: 5,
           stepType: "LINKEDIN_TASK",
           subjectTemplate: "LinkedIn Connection",
           bodyTemplate: "Hi {{firstName}}, I'm Nayem. Would love to connect and share insights."
        }
      ],
      createdAt: new Date().toISOString(),
      isABTestingEnabled: !!isABTestingEnabled
    };

    await addDoc(collection(store, orgPath(orgScope(req), 'campaigns')), newCampaign);
    res.json(newCampaign);
  } catch(e: any) { sendCaught(req, res, e); }
});
