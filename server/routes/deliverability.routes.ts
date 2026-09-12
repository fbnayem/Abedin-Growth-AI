import { Router } from 'express';
import { orgScope } from '../tenancy/orgScope.ts';
import { sendCaught } from '../lib/errors.ts';
import { tenantDeliverability } from '../services/deliverability.service.ts';

/**
 * S27 — is the domain this tenant sends from set up to be believed?
 *
 * Read-only. The same posture the gateway consults before an autonomous send, with the reasons,
 * the DNS records as read, when they were read, and the two parts of deliverability this system
 * does not measure — bounces (handled elsewhere) and complaint feedback (a console) — named
 * rather than left out. A refusal at the gateway with SENDER_IDENTITY_UNVERIFIED points here.
 */
export const deliverabilityRouter = Router();

deliverabilityRouter.get('/', async (req, res) => {
  try {
    res.json(await tenantDeliverability(orgScope(req)));
  } catch (e) {
    sendCaught(req, res, e);
  }
});
