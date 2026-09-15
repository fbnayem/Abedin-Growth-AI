import { Router, type Request, type Response } from 'express';
import { sendCaught, sendError } from '../lib/errors';
import { parsedBodyOr400 } from '../lib/parsedBody';
import { orgScope } from '../tenancy/orgScope';
import { operatorGate } from '../domain/operatorAction';
import {
  amendAssessment,
  createAssessment,
  getAssessment,
  listAssessments,
  signAssessment,
  withdrawAssessment,
} from '../services/lia.service';
import { assessmentVerdict } from '../domain/lia';

/**
 * BALANCING ASSESSMENTS, AND THE ONE REPORT THAT SAYS WHETHER A SEND COULD HAPPEN.
 *
 * An assessment is the document legitimate-interest outreach stands on. The rest of what stands
 * between this system and a real message is reported by `outreach.routes.ts`, which is a
 * separate file because it is a separate router — this repository keeps one router per file, so
 * that "which file serves this path" has one answer.
 *
 * SIGNING IS ITS OWN ENDPOINT, NOT A FIELD ON A WRITE. Making `signedBy` a body field would
 * mean a create could sign itself, and the signature would then be worth what any other
 * self-reported field is worth. The signer is taken from the credential and nowhere else.
 */
export const liaRouter = Router();

const isProduction = process.env.NODE_ENV === 'production';

liaRouter.get('/', async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const records = await listAssessments(orgScope(req));
    res.json({
      assessments: records.map((record) => {
        // The verdict is evaluated against the first country the assessment itself names, so a
        // console can show "usable" or "expired" without asking about a particular contact.
        const country = Array.isArray(record.countries) ? (record.countries[0] ?? '') : '';
        const verdict = assessmentVerdict(record, { country, now });
        return {
          ...record,
          usable: verdict.ok,
          whyNotUsable: verdict.ok ? null : `${verdict.code}: ${verdict.message}`,
        };
      }),
    });
  } catch (e: any) { sendCaught(req, res, e); }
});

liaRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const record = await getAssessment(orgScope(req), req.params.id);
    if (record === null) return sendError(req, res, 'NOT_FOUND', `No assessment ${req.params.id}.`);
    const country = Array.isArray(record.countries) ? (record.countries[0] ?? '') : '';
    const verdict = assessmentVerdict(record, { country, now: new Date() });
    res.json({ ...record, usable: verdict.ok, whyNotUsable: verdict.ok ? null : `${verdict.code}: ${verdict.message}` });
  } catch (e: any) { sendCaught(req, res, e); }
});

liaRouter.post('/', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/lia');
    if (body === null) return;
    const gate = operatorGate(req.user, isProduction);
    if (gate.allowed === false) return sendError(req, res, 'ATTRIBUTION_REQUIRED', gate.message);

    const outcome = await createAssessment(orgScope(req), body, gate.attribution);
    if (outcome.ok === false) return sendError(req, res, outcome.code, outcome.message);
    res.status(201).json(outcome.record);
  } catch (e: any) { sendCaught(req, res, e); }
});

liaRouter.post('/:id/amend', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/lia/:id/amend');
    if (body === null) return;
    const gate = operatorGate(req.user, isProduction);
    if (gate.allowed === false) return sendError(req, res, 'ATTRIBUTION_REQUIRED', gate.message);

    const outcome = await amendAssessment(orgScope(req), req.params.id, body, gate.attribution);
    if (outcome.ok === false) return sendError(req, res, outcome.code, outcome.message);
    res.json(outcome.record);
  } catch (e: any) { sendCaught(req, res, e); }
});

liaRouter.post('/:id/sign', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/lia/:id/sign');
    if (body === null) return;
    const gate = operatorGate(req.user, isProduction);
    if (gate.allowed === false) return sendError(req, res, 'ATTRIBUTION_REQUIRED', gate.message);

    const outcome = await signAssessment(orgScope(req), req.params.id, gate.attribution, {
      reviewDueAt: body.reviewDueAt,
    });
    if (outcome.ok === false) return sendError(req, res, outcome.code, outcome.message);
    res.json(outcome.record);
  } catch (e: any) { sendCaught(req, res, e); }
});

liaRouter.post('/:id/withdraw', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/lia/:id/withdraw');
    if (body === null) return;
    // Deliberately NOT gated on an identified operator: withdrawal moves in the safe direction
    // and the service records `unattributed` rather than refusing. See lia.service.ts.
    const gate = operatorGate(req.user, isProduction);
    const attribution = gate.allowed === false
      ? ({ kind: 'UNATTRIBUTED', why: gate.message } as const)
      : gate.attribution;

    const outcome = await withdrawAssessment(orgScope(req), req.params.id, body.reason, attribution);
    if (outcome.ok === false) return sendError(req, res, outcome.code, outcome.message);
    res.json(outcome.record);
  } catch (e: any) { sendCaught(req, res, e); }
});
