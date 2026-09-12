import { Router, type Request, type Response } from 'express';
import { sendCaught, sendError } from '../lib/errors';
import { readSingleton, writeSingleton } from '../lib/singletonRoutes';
import { parsedBodyOr400 } from '../lib/parsedBody';

/**
 * S39 — Settings, a singleton document, and the settings writes that refuse.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api/settings`.
 */
export const settingsRouter = Router();

settingsRouter.get('/', async (req: Request, res: Response) => {
  try {
    return await readSingleton(req, res, 'settings');
  } catch(e: any) { sendCaught(req, res, e); }
});

settingsRouter.post('/', async (req: Request, res: Response) => {
  try {
    // The autonomy gate is deliberately absent from this schema and cannot be set here: it
    // lives in the environment so that a datastore write can pause the system and can never
    // start it (P0.3).
    const body = parsedBodyOr400(req, res, 'POST /api/settings');
    if (body === null) return;
    return await writeSingleton(req, res, 'settings', body);
  } catch(e: any) { sendCaught(req, res, e); }
});

settingsRouter.post('/token', (req: Request, res: Response) => {
  // P1.13 — Was `res.json({ success: true })`.
  //
  // This claimed to store an API token and stored nothing, so an operator who rotated
  // a credential had no way to discover the old one was still in use.
  //
  // A false success on a settings write is quieter and no less wrong: the operator
  // believes a value is in force that was never stored.
  sendError(
    req,
    res,
    'NOT_IMPLEMENTED',
    "This claimed to store an API token and stored nothing, so an operator who rotated a credential had no way to discover the old one was still in use."
  );
});

settingsRouter.post('/autopilot', (req: Request, res: Response) => {
  // P1.13 — Was `res.json({ success: true })`.
  //
  // This claimed to save autopilot settings and saved nothing. An operator who turned
  // autopilot off was told it had been turned off. Nothing currently reads these
  // settings either, so the control does not exist in any form — which is what this
  // now says.
  //
  // A false success on a settings write is quieter and no less wrong: the operator
  // believes a value is in force that was never stored.
  sendError(
    req,
    res,
    'NOT_IMPLEMENTED',
    "This claimed to save autopilot settings and saved nothing. An operator who turned autopilot off was told it had been turned off. Nothing currently reads these settings either, so the control does not exist in any form — which is what this now says."
  );
});
