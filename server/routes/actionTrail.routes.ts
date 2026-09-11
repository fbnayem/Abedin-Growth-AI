import { Router } from 'express';
import { orgScope } from '../tenancy/orgScope';
import { sendCaught, sendError } from '../lib/errors';
import { readActionTrail } from '../services/actionTrail.service';

/**
 * S10 — THE READER THE AUDIT LOG NEVER HAD.
 *
 * `organizations/{org}/actionLogs` had exactly one writer and no reader anywhere in the repository.
 * The trail existed to answer a question — what was proposed, was it dispatched, what did the
 * provider say, and in what order — that nothing in the running system could ask.
 *
 * Tenant-scoped from the caller's own claim, like every other route here: an action id is a
 * timestamp and six random characters, which is not a secret, so the organisation has to come from
 * the request's identity rather than from the path.
 *
 * This file is deliberately thin. The decision — what a usable id is, what an unreadable trail
 * means as opposed to an empty one — lives in `services/actionTrail.service.ts`, where a test calls
 * it without constructing a request.
 */
export const actionTrailRouter = Router();

actionTrailRouter.get('/:actionId/trail', async (req, res) => {
  try {
    const trail = await readActionTrail(orgScope(req), req.params.actionId);

    if (trail.ok === false) {
      return sendError(req, res, trail.code, trail.reason);
    }

    res.json({ actionId: req.params.actionId, events: trail.events });
  } catch (e: any) {
    sendCaught(req, res, e);
  }
});
