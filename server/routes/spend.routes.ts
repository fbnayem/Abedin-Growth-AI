import { Router } from 'express';
import { orgScope } from '../tenancy/orgScope.ts';
import { sendCaught } from '../lib/errors.ts';
import { tenantSpendView } from '../services/tenantSpend.service.ts';
import { PRICING_SOURCE } from '../policies/modelPricing.ts';

/**
 * S37 — what this tenant has spent on models, against what it may.
 *
 * A budget nobody can see is a budget nobody trusts: the first question after a refusal at
 * stage BUDGET is "how much, since when, and what is the limit", and this answers it from the
 * same ledger the gate reads. Read-only. The limits are configuration, not a setting a caller
 * can raise from here.
 */
export const spendRouter = Router();

spendRouter.get('/', async (req, res) => {
  try {
    const view = await tenantSpendView(orgScope(req));
    res.json({ ...view, pricing: PRICING_SOURCE });
  } catch (e) {
    sendCaught(req, res, e);
  }
});
