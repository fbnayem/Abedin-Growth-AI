import { Router, type Request, type Response } from 'express';
import { collection, getDocs, getDoc, addDoc, doc, store } from '../store';
import { orgScope, orgPath } from '../tenancy/orgScope';
import { assertTransition, creationState, OPPORTUNITY } from '../domain/stateMachines';
import { createOpportunitySchema, parseOrRespond } from '../lib/validation';
import { sendCaught, sendError } from '../lib/errors';
import { parsedBodyOr400 } from '../lib/parsedBody';
import { expectedVersionFrom, mutateWithVersion, sendMutationOutcome, sendVersionRequired, versionOf } from '../lib/concurrency';

/**
 * S39 — The pipeline of opportunities.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api/pipeline`.
 */
export const pipelineRouter = Router();

pipelineRouter.get('/', async (req: Request, res: Response) => {
  try {
    // P1.3 — See /api/campaigns: the version travels with every row.
    const snap = await getDocs(collection(store, orgPath(orgScope(req), 'opportunities')));
    const items: any[] = [];
    snap.forEach((d: any) => items.push(d.data()));
    res.json(items);
  } catch(e: any) { sendCaught(req, res, e); }
});

/**
 * P1.2/P1.3/P1.4 — Move an opportunity to a stage.
 *
 * Three separate defects lived in six lines here:
 *
 *   - The route was registered for POST while the only caller in the repository
 *     (src/App.tsx handleUpdatePipelineStage) sends PUT. Every stage change from the UI has
 *     been 404ing. Both verbs are now registered; PUT is the correct one for an idempotent
 *     "set the stage to X".
 *   - `req.body.stage` was written straight to the document with no validation, so any
 *     string — "won", "", an object — became a pipeline stage and was persisted and rendered.
 *   - The write was blind: no version, so two operators dragging the same card both win and
 *     neither is told.
 */
export const setOpportunityStage = async (req: Request, res: Response) => {
  try {
    // S39 — validated before the read: a stage the machine does not know, or a body carrying
    // more than the stage, is refused here rather than half-honoured below.
    const body = parsedBodyOr400(req, res, 'PUT /api/pipeline/:id/stage');
    if (body === null) return;
    const docRef = doc(store, orgPath(orgScope(req), 'opportunities'), req.params.id);

    // The path is tenant-scoped, so an id belonging to another organisation resolves to
    // nothing. 404, not 403: saying "forbidden" would confirm the id exists in some other
    // tenant.
    const snap = await getDoc(docRef);
    if (!snap.exists()) {
      return sendError(req, res, 'NOT_FOUND', 'No such opportunity.');
    }

    const current: any = snap.data();
    const currentVersion = versionOf(current, true);
    const desired = body.stage;

    const verdict = assertTransition(OPPORTUNITY, current.stage, desired);
    if (verdict.ok === false) {
      // 422, not 400: the request is well-formed, it is the state change that is not
      // permitted. A client can tell "you sent nonsense" from "you may not do that".
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
      stage: desired,
      stageChangedAt: new Date().toISOString(),
    }));
    return sendMutationOutcome(req, res, outcome);
  } catch(e: any) { sendCaught(req, res, e); }
};

pipelineRouter.put('/:id/stage', setOpportunityStage);

pipelineRouter.post('/:id/stage', setOpportunityStage);

pipelineRouter.post('/', async (req: Request, res: Response) => {
  try {
    const input = parseOrRespond(createOpportunitySchema, req, res);
    if (input === null) return;

    // P1.4 said "a supplied stage is honoured only if it is a legal starting point", and
    // checked `transitions[stage] !== undefined` — whether the stage EXISTS. Every legal stage
    // was honoured, so an opportunity could be created WON. S6: the map is asked the right
    // question, and a stage that is not an entry point is refused rather than quietly replaced.
    // Move it afterwards with PUT /api/pipeline/:id/stage, which asks the map too.
    const creation = creationState(OPPORTUNITY, input.stage);
    if (creation.ok === false) {
      return sendError(req, res, 'VALIDATION_ERROR', creation.message);
    }
    const stage = creation.state;

    const payload = {
      id: `opp_${Date.now()}`,
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stage,
      // `value` was previously `req.body.estimatedValue || req.body.value || 0` with no type
      // check, so a string produced NaN downstream and rendered as "NaN".
      value: input.estimatedValue ?? input.value ?? 0,
      currency: input.currency ?? 'GBP',
      title: input.title ?? null,
      companyName: input.companyName ?? null,
      contactName: input.contactName ?? null,
      contactEmail: input.contactEmail ?? null,
      nextStep: input.nextStep ?? null,
      expectedCloseDate: input.expectedCloseDate ?? null,
    };
    await addDoc(collection(store, orgPath(orgScope(req), 'opportunities')), payload);
    res.json(payload);
  } catch(e: any) {
    console.error(e);
    sendCaught(req, res, e);
  }
});
