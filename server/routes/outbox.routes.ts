import { Router } from 'express';
import { outboxService } from '../services/outbox.service.ts';
import { orgScope } from '../tenancy/orgScope.ts';

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

function actorOf(req: any): string {
  return req.user?.email || req.user?.uid || 'unknown-operator';
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
    console.error('[outbox] list failed:', e?.message);
    res.status(500).json({ error: { code: 'OUTBOX_LIST_FAILED', message: 'Failed to fetch outbox.' } });
  }
});

outboxRouter.get('/:id', async (req, res) => {
  try {
    const orgId = orgScope(req);
    const job = await outboxService.getJob(orgId, req.params.id);
    if (!job) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such outbox job.' } });
    }
    res.json(job);
  } catch (e: any) {
    console.error('[outbox] get failed:', e?.message);
    res.status(500).json({ error: { code: 'OUTBOX_GET_FAILED', message: 'Failed to fetch outbox job.' } });
  }
});

outboxRouter.post('/:id/approve', async (req, res) => {
  try {
    const orgId = orgScope(req);
    const result = await outboxService.approveForSending(orgId, req.params.id, actorOf(req));

    if (result.ok === false) {
      const status = result.code === 'NOT_FOUND' ? 404 : 409;
      return res.status(status).json({ error: { code: result.code, message: result.message } });
    }

    res.json({ success: true, message: 'Outbox item approved for sending.' });
  } catch (e: any) {
    console.error('[outbox] approve failed:', e?.message);
    res.status(500).json({ error: { code: 'OUTBOX_APPROVE_FAILED', message: 'Approval failed.' } });
  }
});

outboxRouter.post('/:id/reject', async (req, res) => {
  try {
    const orgId = orgScope(req);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'Rejected by operator';
    const result = await outboxService.cancelJob(orgId, req.params.id, actorOf(req), reason);

    if (result.ok === false) {
      const status = result.code === 'NOT_FOUND' ? 404 : 409;
      return res.status(status).json({ error: { code: result.code, message: result.message } });
    }

    res.json({ success: true, message: 'Outbox item cancelled.' });
  } catch (e: any) {
    console.error('[outbox] reject failed:', e?.message);
    res.status(500).json({ error: { code: 'OUTBOX_REJECT_FAILED', message: 'Rejection failed.' } });
  }
});
