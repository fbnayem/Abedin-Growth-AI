import { Router } from 'express';
import { outboxService } from '../services/outbox.service.ts';
import { orgScope } from '../tenancy/orgScope.ts';
import { sendCaught, sendError, type ErrorCode } from '../lib/errors.ts';
import { operatorGate, requeueReasonFrom, type Attribution } from '../domain/operatorAction.ts';
import { isProduction } from '../config/environment.ts';

/**
 * P1.2 — The human review console.
 *
 * WHAT WAS WRONG
 * --------------
 * Three separate problems, all in twenty-five lines:
 *
 *   1. NO TENANT ANYWHERE. `db.select().from(outboxMessages)` with no predicate returned
 *      EVERY organisation's queued mail — recipients, subjects and bodies — to any
 *      authenticated caller. `/:id/approve` and `/:id/reject` matched on `id` alone, so an
 *      operator in one tenant could release another tenant's message for sending by knowing
 *      (or guessing) its id. This is the single worst instance of the missing tenant column,
 *      because the console is where a human decides that a message may go to a customer.
 *
 *   2. THE WRONG STORE. These routes read the POSTGRES `outbox_messages` table while the
 *      worker dispatches from the FIRESTORE queue. Approving here set a row nothing consumes,
 *      and with DATABASE_URL unset `db` is a proxy that throws, so the console returned 500
 *      and the operator saw "Failed to fetch outbox" rather than the queue.
 *
 *   3. NO STATE GATE. `set({ status: 'PENDING' })` unconditionally. A cancelled, dead-lettered
 *      or already-sent job could be pushed back into the send queue by a stale browser tab.
 *
 * WHAT IT DOES NOW
 * ----------------
 * Reads and writes the same tenant-scoped Firestore queue the worker consumes, through
 * outboxService, with the org from orgScope(req). An id belonging to another tenant resolves
 * to nothing and answers 404 — it is not "forbidden", because saying "forbidden" would confirm
 * the id exists somewhere.
 *
 * Approval does not bypass the P0.12 integrity check: the worker re-verifies the inbound
 * version and approval digest immediately before dispatch, so a draft that went stale between
 * review and approval is still refused there.
 */
export const outboxRouter = Router();

/** The set an operator is asked to act on. Anything else is history, not a decision. */
const REVIEWABLE_STATUSES = ['HUMAN_REVIEW', 'PENDING', 'DEAD_LETTER'] as const;

/**
 * S38 — who is doing this, as a state rather than a string.
 *
 * This was `req.user?.email || req.user?.uid || 'unknown-operator'`. That fallback reads in an
 * audit log exactly like a user account of that name, and "nobody can be identified for this
 * action" is a different fact from "somebody called unknown-operator did it".
 *
 * In production an unattributed caller may not mutate the queue at all. Releasing a message to
 * a customer is the moment attribution matters most, and `requireAuth` admits anonymous callers
 * only when ALLOW_ANONYMOUS_DEV_AUTH is set — which is ignored in production for the same
 * reason.
 */
function attributedOrRefused(req: any, res: any): Attribution | null {
  const gate = operatorGate(req.user, isProduction);
  if (gate.allowed === false) {
    sendError(req, res, 'ATTRIBUTION_REQUIRED', gate.message);
    return null;
  }
  return gate.attribution;
}

outboxRouter.get('/', async (req, res) => {
  try {
    const orgId = orgScope(req);
    const requested = typeof req.query.status === 'string' ? req.query.status : null;

    // An unrecognised status returns nothing rather than everything. A filter that silently
    // widens is how an operator ends up looking at a list they did not ask for.
    const statuses = requested
      ? (REVIEWABLE_STATUSES as readonly string[]).includes(requested)
        ? [requested]
        : []
      : [...REVIEWABLE_STATUSES];

    const items = (
      await Promise.all(statuses.map((status) => outboxService.listByStatus(orgId, status)))
    ).flat();

    res.json(items);
  } catch (e: any) {
    sendCaught(req, res, e);
  }
});

outboxRouter.get('/:id', async (req, res) => {
  try {
    const orgId = orgScope(req);
    const job = await outboxService.getJob(orgId, req.params.id);
    if (!job) {
      return sendError(req, res, 'NOT_FOUND', 'No such outbox job.');
    }
    res.json(job);
  } catch (e: any) {
    sendCaught(req, res, e);
  }
});

outboxRouter.post('/:id/approve', async (req, res) => {
  try {
    const orgId = orgScope(req);
    const attribution = attributedOrRefused(req, res);
    if (attribution === null) return;
    const result = await outboxService.approveForSending(orgId, req.params.id, attribution);

    if (result.ok === false) {
      return sendError(req, res, result.code as ErrorCode, result.message, {
        status: result.code === 'NOT_FOUND' ? 404 : 409,
      });
    }

    res.json({ success: true, message: 'Outbox item approved for sending.' });
  } catch (e: any) {
    sendCaught(req, res, e);
  }
});

outboxRouter.post('/:id/reject', async (req, res) => {
  try {
    const orgId = orgScope(req);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'Rejected by operator';
    const attribution = attributedOrRefused(req, res);
    if (attribution === null) return;
    const result = await outboxService.cancelJob(orgId, req.params.id, attribution, reason);

    if (result.ok === false) {
      return sendError(req, res, result.code as ErrorCode, result.message, {
        status: result.code === 'NOT_FOUND' ? 404 : 409,
      });
    }

    res.json({ success: true, message: 'Outbox item cancelled.' });
  } catch (e: any) {
    sendCaught(req, res, e);
  }
});

/**
 * S38 — the way back from DEAD_LETTER.
 *
 * There was none: a job that exhausted its attempts or was refused for a stale draft could
 * only be recovered by an engineer editing the datastore by hand, with no record of who
 * changed what.
 *
 * This does NOT re-send. A DEAD_LETTER job returns to HUMAN_REVIEW, so a human still has to
 * approve it — and that approval goes through the same integrity re-check the worker performs
 * immediately before dispatch. Retry therefore cannot bypass the flags, the ownership lock or
 * the policy checks, because it never reaches the gateway on its own.
 */
outboxRouter.post('/:id/requeue', async (req, res) => {
  try {
    const orgId = orgScope(req);
    // The requirement lives in the domain module so it can be tested by calling it. As an
    // inline condition here it could only be asserted by reading the source, and a source
    // assertion cannot tell `if (reason === null)` from `if (false)`.
    const given = requeueReasonFrom(req.body);
    if (given.ok === false) {
      return sendError(req, res, 'VALIDATION_ERROR', given.message);
    }
    const reason = given.reason;

    const attribution = attributedOrRefused(req, res);
    if (attribution === null) return;

    const result = await outboxService.requeue(orgId, req.params.id, attribution, reason);
    if (result.ok === false) {
      return sendError(req, res, result.code as ErrorCode, result.message, {
        status: result.code === 'NOT_FOUND' ? 404 : 409,
      });
    }

    res.json({
      success: true,
      status: result.toStatus,
      message:
        result.toStatus === 'HUMAN_REVIEW'
          ? 'Returned to human review. It will not send until someone approves it.'
          : 'Requeued for another attempt.',
    });
  } catch (e: any) {
    sendCaught(req, res, e);
  }
});
