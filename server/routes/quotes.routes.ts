import { Router, type Request, type Response } from 'express';
import { sendCaught, sendError } from '../lib/errors';
import { orgScope } from '../tenancy/orgScope';
import { operatorGate, attributionFor } from '../domain/operatorAction';
import { isProduction } from '../config/environment';
import { getQuote, submitQuote, approveQuote, withdrawQuote } from '../services/quote.service';

/**
 * S25 — a quote's own moves. Submit and withdraw ask the machine; approve asks the machine and
 * the operator gate, because a quote APPROVED by nobody binds nothing (the shared rule), and in
 * production an unattributed approval is refused rather than recorded under a placeholder.
 */
export const quotesRouter = Router();

quotesRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const quote = await getQuote(orgScope(req), req.params.id);
    if (quote === null) return sendError(req, res, 'NOT_FOUND', 'No such quote.');
    res.json(quote);
  } catch (e: any) { sendCaught(req, res, e); }
});

const answer = (req: Request, res: Response, outcome: Awaited<ReturnType<typeof submitQuote>>) => {
  if (outcome.ok) return res.json(outcome.quote);
  if (outcome.code === 'NOT_FOUND') return sendError(req, res, 'NOT_FOUND', outcome.message);
  if (outcome.code === 'ILLEGAL_TRANSITION') return sendError(req, res, 'ILLEGAL_TRANSITION', outcome.message, { status: 422 });
  if (outcome.code === 'ATTRIBUTION_REQUIRED') return sendError(req, res, 'ATTRIBUTION_REQUIRED', outcome.message);
  if (outcome.code === 'STORE_UNAVAILABLE') return sendError(req, res, 'STORE_UNAVAILABLE', outcome.message);
  return sendError(req, res, 'VALIDATION_ERROR', outcome.message);
};

quotesRouter.post('/:id/submit', async (req: Request, res: Response) => {
  try {
    answer(req, res, await submitQuote(orgScope(req), req.params.id));
  } catch (e: any) { sendCaught(req, res, e); }
});

quotesRouter.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const gate = operatorGate(req.user, isProduction);
    if (gate.allowed === false) return sendError(req, res, 'ATTRIBUTION_REQUIRED', gate.message);
    answer(req, res, await approveQuote(orgScope(req), req.params.id, gate.attribution));
  } catch (e: any) { sendCaught(req, res, e); }
});

quotesRouter.post('/:id/withdraw', async (req: Request, res: Response) => {
  try {
    answer(req, res, await withdrawQuote(orgScope(req), req.params.id, attributionFor(req.user)));
  } catch (e: any) { sendCaught(req, res, e); }
});
