import { Router, type Request, type Response } from 'express';
import { getDoc, doc, store } from '../store';
import { orgScope, orgPath } from '../tenancy/orgScope';
import { sendCaught, sendError } from '../lib/errors';
import { expectedVersionFrom, mutateWithVersion, sendMutationOutcome, sendVersionRequired, versionOf } from '../lib/concurrency';
import { generateCompanyBrain } from '../agents/companyBrainAgent';
import { readSingleton, writeSingleton } from '../lib/singletonRoutes';
import { parsedBodyOr400 } from '../lib/parsedBody';

/**
 * S39 — The company brain, a singleton document.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api/company-brain`.
 */
export const companyBrainRouter = Router();

companyBrainRouter.get('/', async (req: Request, res: Response) => {
  try {
    return await readSingleton(req, res, 'company_brain');
  } catch(e: any) { sendCaught(req, res, e); }
});

companyBrainRouter.post('/', async (req: Request, res: Response) => {
  try {
    // S11 — this took `req.body` whole. The company brain is stringified into EVERY outbound
    // prompt, so a key written here is a key the model reads as part of its instructions —
    // the injection channel §18 describes, arriving as an ordinary API call rather than
    // through a retrieved document. The schema is strict, so an unexpected field is refused
    // rather than dropped: a caller that sent something it believed would be saved is told it
    // was not.
    const body = parsedBodyOr400(req, res, 'POST /api/company-brain');
    if (body === null) return;
    return await writeSingleton(req, res, 'company_brain', body);
  } catch(e: any) { sendCaught(req, res, e); }
});

companyBrainRouter.post('/generate', async (req: Request, res: Response) => {
  try {
    // P1.3 — Regeneration replaced the company brain blind, which is the most damaging
    // instance of the lost update in this file: the brain is stringified into every outbound
    // prompt, so silently discarding an operator's edit changes what customers are told.
    const ref = doc(store, orgPath(orgScope(req), 'company_brain'), 'main');
    const expected = expectedVersionFrom(req);
    if (expected.ok === false) {
      const snap = await getDoc(ref);
      return sendVersionRequired(req, res, expected, versionOf(snap.exists() ? snap.data() : null, snap.exists()));
    }

    // Generated BEFORE the transaction: it is an external model call, and produceNext runs
    // inside a transaction that may be retried. A retryable block must not make paid calls.
    // S11 — validated against the registry, like its sibling. This passed `req.body` straight
    // to the agent, which interpolates every field into the prompt.
    const input = parsedBodyOr400(req, res, 'POST /api/company-brain/generate');
    if (input === null) return;

    const generated = await generateCompanyBrain(input);
    if (generated.ok === false) {
      // Nothing is written. An abstention used to be a hand-written template stored as though a
      // model had produced it, and an off-contract answer used to be stored whole.
      return sendError(
        req,
        res,
        generated.code === 'MODEL_UNAVAILABLE' ? 'PROVIDER_UNAVAILABLE' : 'MODEL_OUTPUT_INVALID',
        generated.reason
      );
    }

    const brain: Record<string, unknown> = { ...generated.brain };
    const outcome = await mutateWithVersion(ref, expected.value, () => brain);
    return sendMutationOutcome(req, res, outcome);
  } catch(e: any) { sendCaught(req, res, e); }
});
