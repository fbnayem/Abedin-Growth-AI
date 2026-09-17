import { Router, type Request, type Response } from 'express';
import { sendCaught, sendError } from '../lib/errors';
import { parsedBodyOr400 } from '../lib/parsedBody';
import { orgScope } from '../tenancy/orgScope';
import { operatorGate } from '../domain/operatorAction';
import { isProduction } from '../config/environment';
import { createProspects, listProspects, promoteProspect } from '../services/prospect.service';
import type { ContactProvenance } from '../domain/contactDocument';

/**
 * PROSPECTS: PEOPLE WE HAVE IDENTIFIED AND CANNOT YET EMAIL.
 *
 * A LinkedIn profile is a person, an employer and a URL. It is not an address, and this system's
 * contact identity IS the address — so a profile cannot be a contact. These routes are where such
 * a person lives until somebody finds one.
 *
 * THERE IS NO SEND ROUTE HERE, AND THERE WILL NOT BE ONE. A prospect is not contactable. If a
 * future change wants to message one, the change is to find an address and promote it — not to
 * add a dispatch that reaches into this collection.
 */
export const prospectsRouter = Router();

prospectsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const promotedParam = typeof req.query.promoted === 'string' ? req.query.promoted : undefined;
    const rows = await listProspects(orgScope(req), {
      limit: Number(req.query.limit) || undefined,
      // Only the exact strings decide. Anything else means "no filter" rather than a guess at
      // what was meant — a misread filter silently shows the wrong half of a list.
      promoted: promotedParam === 'true' ? true : promotedParam === 'false' ? false : undefined,
    });
    res.json({ prospects: rows, count: rows.length });
  } catch (e: any) { sendCaught(req, res, e); }
});

/**
 * Create prospects from a batch.
 *
 * PREVIEW is the default, like every other ingest in this system: an operator who omits `mode`
 * finds out what would happen rather than discovering it afterwards.
 */
prospectsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/prospects');
    if (body === null) return;
    const gate = operatorGate(req.user, isProduction);
    if (gate.allowed === false) return sendError(req, res, 'ATTRIBUTION_REQUIRED', gate.message);

    // Named and typed rather than passed as an anonymous object: `ContactProvenance` is the
    // anchor `leadSource.invariant.test.ts` scans for, so every place a lead's origin is
    // recorded is a place that test can find and check the `source` value of.
    const provenance: ContactProvenance = {
      // Fixed, not taken from the body. See `createProspectsSchema`: the route a record
      // arrived by decides which balancing assessment can cover it, so a caller who could
      // name it could pick their own justification.
      source: 'LINKEDIN',
      sourceEvidence: body.sourceEvidence,
      // The moment of the call. Not a caller-supplied date: this is when WE obtained the
      // record, and the Article 14 notice quotes it once the prospect becomes a contact.
      sourceCollectedAt: new Date().toISOString(),
    };

    const outcome = await createProspects(orgScope(req), body.rows, provenance, gate.attribution, {
      mode: body.mode ?? 'PREVIEW',
    });
    if (outcome.ok === false) {
      return sendError(
        req,
        res,
        outcome.code === 'STORE_UNAVAILABLE' ? 'STORE_UNAVAILABLE' : 'VALIDATION_ERROR',
        outcome.message
      );
    }
    res.json(outcome);
  } catch (e: any) { sendCaught(req, res, e); }
});

/**
 * Promote a prospect: an address has been found.
 *
 * This is the only route that turns a prospect into something mailable, and it does not create
 * the contact itself — it ends at `ingestRecords`, the one write path every lead source uses.
 */
prospectsRouter.post('/:id/promote', async (req: Request, res: Response) => {
  try {
    const body = parsedBodyOr400(req, res, 'POST /api/prospects/:id/promote');
    if (body === null) return;
    const gate = operatorGate(req.user, isProduction);
    if (gate.allowed === false) return sendError(req, res, 'ATTRIBUTION_REQUIRED', gate.message);

    const outcome = await promoteProspect(
      orgScope(req),
      req.params.id,
      body.email,
      {
        basis: body.basis,
        liaId: body.liaId,
        consentEvidence: body.consentEvidence,
        consentSource: body.consentSource,
        country: body.country,
        addressType: body.addressType,
      },
      gate.attribution,
      {
        mode: body.mode ?? 'PREVIEW',
        addressSourceKind: body.addressSourceKind,
        addressSourceEvidence: body.addressSourceEvidence,
      }
    );
    if (outcome.ok === false) {
      return sendError(
        req,
        res,
        outcome.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : outcome.code === 'STORE_UNAVAILABLE'
            ? 'STORE_UNAVAILABLE'
            : outcome.code === 'ALREADY_PROMOTED'
              ? 'CONTACT_EXISTS'
              : 'VALIDATION_ERROR',
        outcome.message
      );
    }
    res.json(outcome);
  } catch (e: any) { sendCaught(req, res, e); }
});
