import { Router, type Request, type Response } from 'express';
import { sendCaught } from '../lib/errors';
import { processGrowthCommand } from '../agents/growthCommandAgent';

/**
 * S39 — The growth command agent.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api/growth-command`.
 */
export const growthCommandRouter = Router();

growthCommandRouter.post('/', async (req: Request, res: Response) => {
  try {
    const result = await processGrowthCommand(req.body.command);
    res.json(result);
  } catch(e: any) {
    console.error(e);
    sendCaught(req, res, e);
  }
});
