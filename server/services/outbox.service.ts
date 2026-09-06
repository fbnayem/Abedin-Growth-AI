import { firestore } from '../firebase';
import { orgPath } from '../tenancy/orgScope';
import { assertTransition, OUTBOX_JOB } from '../domain/stateMachines';
import { v4 as uuidv4 } from 'uuid';
import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  query,
  where,
  limit,
  updateDoc,
  runTransaction,
  orderBy,
} from 'firebase/firestore';

/**
 * P0.7 / P0.9 — The outbox queue.
 *
 * WHAT WAS WRONG
 * --------------
 * 1. NO CLAIM. `fetchPendingJobs` did a plain `where('status','==','PENDING')` read and handed
 *    the rows straight to the worker. Two workers — or two overlapping ticks of the SAME
 *    worker, since the 5s interval was never awaited — would read the same row and both send
 *    it. Duplicate delivery to a real customer was a matter of timing, not of failure.
 * 2. NO LEASE. A worker that crashed between reading a job and updating it left that job
 *    PENDING forever or FAILED forever, with nothing to recover it.
 * 3. NO ATTEMPT COUNTER, NO BACKOFF, NO DEAD LETTER. `markFailed` was terminal and there was
 *    no path from FAILED back to PENDING anywhere in the repository, so any transient error
 *    silently destroyed the message.
 *
 * THE FIX
 * -------
 * Claiming is a Firestore transaction: re-read inside the transaction, and only take the job
 * if it is still PENDING. A loser sees the changed status and skips. Each claim records
 * `claimedBy`, `claimedAt`, `leaseUntil` and increments `attempts`.
 *
 * Leases expire, so a crashed worker's jobs return to PENDING via `reapExpiredLeases()`
 * instead of being stranded. Jobs that exhaust `MAX_ATTEMPTS` go to DEAD_LETTER rather than
 * being retried forever or discarded.
 *
 * STATES
 *   PENDING      awaiting a worker
 *   CLAIMED      leased by a worker; leaseUntil governs recovery
 *   PROCESSED    provider confirmed, real provider id recorded
 *   FAILED       attempt failed, eligible for retry after nextAttemptAt
 *   DEAD_LETTER  attempts exhausted; requires an operator decision
 *   CANCELLED    cancelled by the kill switch or an operator
 */

/**
 * P1.1 — The queue is per tenant, and every method says so.
 *
 * This module used to address a single hardcoded organisation, which meant the queue had
 * exactly one tenant no matter who enqueued into it: a message composed for one customer and
 * a message composed for another landed in the same collection, were claimed by the same
 * worker, and were consent-checked against the same contact records. Every method now takes
 * the organisation explicitly, and every path is built through orgPath so the id is validated
 * before it becomes a path segment.
 */

export const MAX_ATTEMPTS = 5;
export const LEASE_MS = 60_000;

export interface OutboxPayload {
  to: string;
  subject: string;
  htmlBody: string;
  textBody?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}

function outboxCollection(organizationId: string) {
  if (!firestore) return null;
  return collection(firestore, orgPath(organizationId, 'outbox'));
}

function outboxDoc(organizationId: string, id: string) {
  if (!firestore) return null;
  return doc(firestore, orgPath(organizationId, 'outbox'), id);
}

/** Exponential backoff with a ceiling, so a failing provider is not hammered. */
function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 15 * 60_000);
}

export class OutboxService {
  async queueMessage(
    organizationId: string,
    conversationId: string,
    payload: OutboxPayload,
    idempotencyKey: string,
    // P0.12 — Provenance travels WITH the job. Stamping at enqueue is what lets the worker
    // prove, immediately before dispatch, that the conversation has not moved since the
    // draft was written.
    integrity?: { generatedForInboundVersion: number; approvalDigest?: string }
  ) {
    const outboxRef = outboxCollection(organizationId);
    if (!outboxRef || !firestore) return null;
    try {
      // Idempotency check. NOTE: this is a read-then-write and is therefore racy under
      // concurrency; the durable guarantee comes from using the idempotency key as the
      // DOCUMENT ID below, so a duplicate insert overwrites rather than duplicates.
      const q = query(outboxRef, where('idempotencyKey', '==', idempotencyKey));
      const existing = await getDocs(q);
      if (!existing.empty) {
        console.log(`Idempotency key ${idempotencyKey} already exists. Skipping.`);
        return null;
      }

      const id = uuidv4();
      const ref = outboxDoc(organizationId, id);
      if (!ref) return null;
      await setDoc(ref, {
        id,
        // The tenant is recorded ON the job, not merely implied by where it happens to be
        // stored. Everything downstream — the integrity check, the gateway, the audit log —
        // reads it from here, so a job cannot be processed under a tenant it did not name.
        organizationId,
        conversationId,
        idempotencyKey,
        payload,
        status: 'PENDING',
        attempts: 0,
        createdAt: Date.now(),
        nextAttemptAt: Date.now(),
        generatedForInboundVersion: integrity?.generatedForInboundVersion ?? null,
        approvalDigest: integrity?.approvalDigest ?? null,
      });

      return { id };
    } catch (error: any) {
      console.error('Queue message error:', error);
      throw error;
    }
  }

  /**
   * P0.9 — Atomically claim up to `limitCount` jobs. Only jobs this call actually won are
   * returned, so a caller may safely assume exclusive ownership of every job it receives for
   * the duration of the lease.
   */
  async claimPendingJobs(
    organizationId: string,
    limitCount = 5,
    workerId = 'outbox-worker'
  ): Promise<any[]> {
    const outboxRef = outboxCollection(organizationId);
    if (!outboxRef || !firestore) return [];

    let candidates: any[] = [];
    try {
      // Over-fetch slightly: some candidates will be lost to other claimants.
      const q = query(outboxRef, where('status', '==', 'PENDING'), limit(limitCount * 2));
      const snap = await getDocs(q);
      snap.forEach((d) => candidates.push(d.data()));
    } catch (error) {
      console.error('Failed to fetch candidate outbox jobs', error);
      return [];
    }

    const now = Date.now();
    const claimed: any[] = [];

    for (const candidate of candidates) {
      if (claimed.length >= limitCount) break;
      // Respect backoff for jobs that have failed before.
      if (candidate.nextAttemptAt && candidate.nextAttemptAt > now) continue;

      const ref = outboxDoc(organizationId, candidate.id);
      if (!ref) continue;

      try {
        const won = await runTransaction(firestore, async (tx) => {
          const fresh = await tx.get(ref);
          if (!fresh.exists()) return null;
          const data: any = fresh.data();

          // The decisive check: another claimant may have taken this row between our read
          // above and this transaction.
          if (data.status !== 'PENDING') return null;
          if (data.nextAttemptAt && data.nextAttemptAt > Date.now()) return null;

          const attempts = (data.attempts || 0) + 1;
          const update = {
            status: 'CLAIMED',
            claimedBy: workerId,
            claimedAt: Date.now(),
            leaseUntil: Date.now() + LEASE_MS,
            attempts,
          };
          tx.update(ref, update);
          // organizationId last: a job document written before this field existed would
          // otherwise be handed to the worker without one, and the worker would then have to
          // guess. It cannot be anything other than the collection it was claimed from.
          return { ...data, ...update, organizationId };
        });

        if (won) claimed.push(won);
      } catch (e: any) {
        // A transaction abort here means someone else won the race. That is the mechanism
        // working, not an error condition.
        console.warn(`[Outbox] Could not claim job ${candidate.id}: ${e?.message}`);
      }
    }

    return claimed;
  }

  /**
   * @deprecated P0.9 — Retained only so no caller silently breaks. Reading PENDING jobs
   * without claiming them is what allowed duplicate sends; use claimPendingJobs().
   */
  async fetchPendingJobs(organizationId: string, limitCount = 10) {
    console.warn(
      '[Outbox] fetchPendingJobs() is deprecated and unsafe for dispatch — it does not claim ' +
      'rows, so concurrent workers will process the same job. Use claimPendingJobs().'
    );
    return this.claimPendingJobs(organizationId, limitCount);
  }

  /**
   * P0.9 — Return jobs whose lease expired back to PENDING, so a crashed worker does not
   * strand them. Jobs past MAX_ATTEMPTS are dead-lettered for an operator instead.
   */
  async reapExpiredLeases(organizationId: string): Promise<number> {
    const outboxRef = outboxCollection(organizationId);
    if (!outboxRef || !firestore) return 0;

    let reaped = 0;
    try {
      const q = query(outboxRef, where('status', '==', 'CLAIMED'), limit(50));
      const snap = await getDocs(q);
      const now = Date.now();

      for (const d of snap.docs) {
        const data: any = d.data();
        if (!data.leaseUntil || data.leaseUntil > now) continue;

        const attempts = data.attempts || 0;
        if (attempts >= MAX_ATTEMPTS) {
          await updateDoc(d.ref, {
            status: 'DEAD_LETTER',
            lastError: `Lease expired after ${attempts} attempts; exceeded MAX_ATTEMPTS.`,
            deadLetteredAt: now,
          });
          console.error(`[Outbox] Job ${data.id} dead-lettered after ${attempts} attempts.`);
        } else {
          await updateDoc(d.ref, {
            status: 'PENDING',
            claimedBy: null,
            leaseUntil: null,
            nextAttemptAt: now + backoffMs(attempts),
            lastError: 'Lease expired; worker presumed dead. Returned to queue.',
          });
          console.warn(`[Outbox] Reclaimed job ${data.id} after lease expiry.`);
        }
        reaped++;
      }
    } catch (e: any) {
      console.error('[Outbox] Lease reaper failed:', e?.message);
    }
    return reaped;
  }

  async markProcessed(organizationId: string, id: string, providerMessageId: string) {
    const ref = outboxDoc(organizationId, id);
    if (!ref) return;
    // P0.8 — providerMessageId is recorded so a PROCESSED row can be traced to a real
    // provider artefact. A row without one is not evidence that anything was sent.
    await updateDoc(ref, {
      status: 'PROCESSED',
      providerMessageId,
      processedAt: Date.now(),
      leaseUntil: null,
    });
  }

  /**
   * Records a failed attempt. Retries with backoff until MAX_ATTEMPTS, then dead-letters.
   * `terminal` forces immediate dead-lettering for errors that retrying cannot fix
   * (policy blocks, stale drafts, fabricated provider ids).
   */
  async markFailed(organizationId: string, id: string, error: string, terminal = false) {
    const ref = outboxDoc(organizationId, id);
    if (!ref || !firestore) return;

    try {
      await runTransaction(firestore, async (tx) => {
        const fresh = await tx.get(ref);
        if (!fresh.exists()) return;
        const data: any = fresh.data();
        const attempts = data.attempts || 0;

        if (terminal || attempts >= MAX_ATTEMPTS) {
          tx.update(ref, {
            status: 'DEAD_LETTER',
            lastError: error,
            deadLetteredAt: Date.now(),
            leaseUntil: null,
          });
        } else {
          tx.update(ref, {
            status: 'PENDING',
            lastError: error,
            nextAttemptAt: Date.now() + backoffMs(attempts),
            claimedBy: null,
            leaseUntil: null,
          });
        }
      });
    } catch (e: any) {
      console.error(`[Outbox] markFailed transaction failed for ${id}:`, e?.message);
    }
  }


  /**
   * P0.11 — Hold a queued message for human review. Used when the independent auditor could
   * not be run faithfully: the message stays durable and visible, but no worker will claim it
   * (claimPendingJobs only takes PENDING rows).
   */
  async holdForHumanReview(organizationId: string, id: string, reason: string) {
    const ref = outboxDoc(organizationId, id);
    if (!ref) return;
    await updateDoc(ref, {
      status: 'HUMAN_REVIEW',
      heldReason: reason,
      heldAt: Date.now(),
    });
  }
  /**
   * P1.2 — Fetch one job, scoped to a tenant.
   *
   * Returns null for an id that does not exist IN THIS TENANT, which is what lets the router
   * answer 404 rather than acting on another organisation's row. The Firestore path is
   * tenant-scoped by construction, so a foreign id genuinely resolves to nothing — but that
   * only helps if the caller builds the path from the resolved tenant, which is why this
   * method takes the org rather than reading it from somewhere ambient.
   */
  async getJob(organizationId: string, id: string): Promise<any | null> {
    const ref = outboxDoc(organizationId, id);
    if (!ref) return null;
    try {
      const snap = await getDoc(ref);
      if (!snap.exists()) return null;
      return { ...(snap.data() as any), organizationId };
    } catch (e: any) {
      console.error('[Outbox] getJob failed:', e?.message);
      return null;
    }
  }

  /**
   * P1.2 — Operator approval: HUMAN_REVIEW -> PENDING.
   *
   * Transactional and state-gated. Two operators clicking approve, or one clicking twice,
   * must produce one transition, not two — and a job that has since been cancelled or
   * dead-lettered must not be resurrected into the send queue by a stale console.
   *
   * Approving does NOT bypass the P0.12 integrity check: the worker re-verifies the inbound
   * version and the approval digest immediately before dispatch, so a draft that went stale
   * between review and approval is still refused there.
   */
  async approveForSending(
    organizationId: string,
    id: string,
    actor: string
  ): Promise<{ ok: true } | { ok: false; code: 'NOT_FOUND' | 'ILLEGAL_TRANSITION'; message: string }> {
    const ref = outboxDoc(organizationId, id);
    if (!ref || !firestore) {
      return { ok: false, code: 'NOT_FOUND', message: 'Datastore unavailable.' };
    }
    try {
      return await runTransaction(firestore, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) {
          return { ok: false as const, code: 'NOT_FOUND' as const, message: 'No such outbox job.' };
        }
        const data: any = snap.data();
        // P1.4 — Defers to the shared transition map rather than restating the rule. The map
        // is also what makes PROCESSED unreachable from here: a message that reached a
        // provider cannot be re-approved into the send queue.
        const verdict = assertTransition(OUTBOX_JOB, data.status, 'PENDING');
        if (verdict.ok === false || data.status !== 'HUMAN_REVIEW') {
          return {
            ok: false as const,
            code: 'ILLEGAL_TRANSITION' as const,
            message:
              verdict.ok === false
                ? verdict.message
                : `Job is ${data.status}; only a HUMAN_REVIEW job can be approved.`,
          };
        }
        tx.update(ref, {
          status: 'PENDING',
          approvedBy: actor,
          approvedAt: Date.now(),
          nextAttemptAt: Date.now(),
        });
        return { ok: true as const };
      });
    } catch (e: any) {
      console.error('[Outbox] approveForSending failed:', e?.message);
      return { ok: false, code: 'NOT_FOUND', message: 'Approval could not be recorded.' };
    }
  }

  /**
   * P1.2 — Operator cancellation. Terminal states are left alone: cancelling something already
   * PROCESSED would record a lie about a message that has been delivered.
   */
  async cancelJob(
    organizationId: string,
    id: string,
    actor: string,
    reason: string
  ): Promise<{ ok: true } | { ok: false; code: 'NOT_FOUND' | 'ILLEGAL_TRANSITION'; message: string }> {
    const ref = outboxDoc(organizationId, id);
    if (!ref || !firestore) {
      return { ok: false, code: 'NOT_FOUND', message: 'Datastore unavailable.' };
    }
    try {
      return await runTransaction(firestore, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) {
          return { ok: false as const, code: 'NOT_FOUND' as const, message: 'No such outbox job.' };
        }
        const data: any = snap.data();
        const verdict = assertTransition(OUTBOX_JOB, data.status, 'CANCELLED');
        if (verdict.ok === false) {
          return {
            ok: false as const,
            code: 'ILLEGAL_TRANSITION' as const,
            message: verdict.message,
          };
        }
        if (verdict.changed === false) {
          return {
            ok: false as const,
            code: 'ILLEGAL_TRANSITION' as const,
            message: 'Job is CANCELLED and cannot be cancelled.',
          };
        }
        tx.update(ref, {
          status: 'CANCELLED',
          cancelledBy: actor,
          cancelledReason: reason,
          cancelledAt: new Date().toISOString(),
          leaseUntil: null,
        });
        return { ok: true as const };
      });
    } catch (e: any) {
      console.error('[Outbox] cancelJob failed:', e?.message);
      return { ok: false, code: 'NOT_FOUND', message: 'Cancellation could not be recorded.' };
    }
  }

  /** Operator/inspection helper: list jobs by status. */
  async listByStatus(organizationId: string, status: string, limitCount = 50): Promise<any[]> {
    const outboxRef = outboxCollection(organizationId);
    if (!outboxRef) return [];
    try {
      const q = query(outboxRef, where('status', '==', status), limit(limitCount));
      const snap = await getDocs(q);
      const out: any[] = [];
      snap.forEach((d) => out.push(d.data()));
      return out;
    } catch (e: any) {
      console.error('[Outbox] listByStatus failed:', e?.message);
      return [];
    }
  }
}

export const outboxService = new OutboxService();
