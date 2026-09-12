import { Router, type Request, type Response } from 'express';
import { sendCaught } from '../lib/errors';
import { simulatePitchBattle } from '../agents/pitchBattleAgent';

/**
 * S39 — The pitch-battle simulation.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api/pitch-battle`.
 */
export const pitchBattleRouter = Router();

pitchBattleRouter.post('/simulate', async (req: Request, res: Response) => {
  try {
    const result = await simulatePitchBattle(req.body);
    res.json(result);
  } catch(e: any) { sendCaught(req, res, e); }
});
