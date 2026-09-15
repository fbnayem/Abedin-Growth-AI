import { Router, type Request, type Response } from 'express';
import { sendCaught } from '../lib/errors';
import { orgScope } from '../tenancy/orgScope';
import { outreachReadiness } from '../services/outreachPreflight.service';

/**
 * WHAT IS STILL BLOCKING A REAL SEND.
 *
 * `/api/readiness` answers "can this system touch anything outside itself?" — one boolean per
 * production-action flag. This answers the question an operator actually has, which is "if I
 * turned sending on right now, what would happen?", and the answer is usually not the flag.
 *
 * It is a READ. It changes nothing, so it is safe to run at any time, which is the point: a
 * readiness check people are afraid to run is one they will not run.
 *
 * `ready` is false whenever ANY check blocks, and a check whose input could not be read blocks
 * too. So a datastore outage during a preflight answers "not ready, could not check" rather
 * than a confident wrong answer in either direction — the same rule §14 applies to consent,
 * applied to readiness.
 *
 * The response also carries `uncheckable`: the things this report knows it cannot verify, named
 * rather than omitted. A readiness report that quietly scopes itself down to what it can measure
 * is how "ready" comes to mean "ready in the ways we happened to test".
 */
export const outreachRouter = Router();

outreachRouter.get('/preflight', async (req: Request, res: Response) => {
  try {
    res.json(await outreachReadiness(orgScope(req)));
  } catch (e: any) { sendCaught(req, res, e); }
});
