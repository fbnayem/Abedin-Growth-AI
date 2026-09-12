import { Router, type Request, type Response } from 'express';
import { autopilotRunner } from '../autopilotRunner';
import { sendError } from '../lib/errors';

/**
 * S39 — The autopilot runner.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api/autopilot`.
 */
export const autopilotRouter = Router();

autopilotRouter.post('/run-cycle-now', (req: Request, res: Response) => {
  // S39 — Was `res.json({ status: "success" })`: the same answer for every request, which is a
  // fabricated result rather than a stub, and the guardrail could not see it because it
  // looked only for `success: true`.
  sendError(req, res, 'NOT_IMPLEMENTED', 'Running an autopilot cycle on demand is not implemented. This endpoint reported success and ran nothing.');
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
