import { Router, type Request, type Response } from 'express';
import { autopilotRunner } from '../autopilotRunner';
import { sendCaught, sendError } from '../lib/errors';
import { orgScope } from '../tenancy/orgScope';
import { runCampaignTick, relationalConversationState } from '../services/campaignEngine.service';
import { campaignScheduler } from '../workers/campaignScheduler';

/**
 * S39 — The autopilot runner.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api/autopilot`.
 */
export const autopilotRouter = Router();

autopilotRouter.post('/run-cycle-now', async (req: Request, res: Response) => {
  // S26 — a real cycle: one campaign tick for this organisation, and its report. Until
  // 2026-09-12 this answered `{ status: "success" }` and ran nothing; then it refused; now the
  // thing it claimed to run exists.
  try {
    const actor = `operator:${req.tenant?.uid ?? 'unknown'}`;
    const report = await runCampaignTick(orgScope(req), { conversationState: relationalConversationState }, new Date(), actor);
    res.json({
      report,
      scheduler: { running: campaignScheduler.isRunning, disabledReason: campaignScheduler.disabledReason, lastTickAt: campaignScheduler.lastTickAt },
    });
  } catch (e: any) { sendCaught(req, res, e); }
});

autopilotRouter.get('/status', (req: Request, res: Response) => {
  res.json(autopilotRunner.status);
});

autopilotRouter.post('/toggle', (req: Request, res: Response) => {
  const isActive = autopilotRunner.startBackgroundLoop();
  res.json({ isActive, status: autopilotRunner.status });
});

autopilotRouter.post('/settings', (req: Request, res: Response) => {
  // S39 — Was `res.json({ settings: req.body })`: the request echoed back as though it had been
  // stored. Nothing stores or reads autopilot settings (see POST /api/settings/autopilot, which
  // says the same), so the echo told an operator a value was in force that existed nowhere.
  sendError(
    req,
    res,
    'NOT_IMPLEMENTED',
    'Autopilot settings are not stored. This endpoint echoed the request back as though it had been saved.'
  );
});
