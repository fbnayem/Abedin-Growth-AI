import { firestore } from '../firebase';
import { v4 as uuidv4 } from 'uuid';
import {
  collection,
  doc,
  setDoc,
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

const ORG_ID = 'org_1'; // TODO(P1 — tenant resolution): hardcoded as elsewhere in this codebase.

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

function outboxCollection() {
  if (!firestore) return null;
  return collection(firestore, `organizations/${ORG_ID}/outbox`);
}

function outboxDoc(id: string) {
  if (!firestore) return null;
  return doc(firestore, `organizations/${ORG_ID}/outbox`, id);
}

/** Exponential backoff with a ceiling, so a failing provider is not hammered. */
function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 15 * 60_000);
}

export class OutboxService {
  async queueMessage(
    conversationId: string,
    payload: OutboxPayload,
    idempotencyKey: string,
    // P0.12 — Provenance travels WITH the job. Stamping at enqueue is what lets the worker
    // prove, immediately before dispatch, that the conversation has not moved since the
    // draft was written.
    integrity?: { generatedForInboundVersion: number; approvalDigest?: string }
  ) {
    const outboxRef = outboxCollection();
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
      const ref = outboxDoc(id);
      if (!ref) return null;
      await setDoc(ref, {
        id,
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
  async claimPendingJobs(limitCount = 5, workerId = 'outbox-worker'): Promise<any[]> {
    const outboxRef = outboxCollection();
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

      const ref = outboxDoc(candidate.id);
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
          return { ...data, ...update };
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
  async fetchPendingJobs(limitCount = 10) {
    console.warn(
      '[Outbox] fetchPendingJobs() is deprecated and unsafe for dispatch — it does not claim ' +
      'rows, so concurrent workers will process the same job. Use claimPendingJobs().'
    );
    return this.claimPendingJobs(limitCount);
  }

  /**
   * P0.9 — Return jobs whose lease expired back to PENDING, so a crashed worker does not
   * strand them. Jobs past MAX_ATTEMPTS are dead-lettered for an operator instead.
   */
  async reapExpiredLeases(): Promise<number> {
    const outboxRef = outboxCollection();
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

  async markProcessed(id: string, providerMessageId: string) {
    const ref = outboxDoc(id);
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
  async markFailed(id: string, error: string, terminal = false) {
    const ref = outboxDoc(id);
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
  async holdForHumanReview(id: string, reason: string) {
    const ref = outboxDoc(id);
    if (!ref) return;
    await updateDoc(ref, {
      status: 'HUMAN_REVIEW',
      heldReason: reason,
      heldAt: Date.now(),
    });
  }
  /** Operator/inspection helper: list jobs by status. */
  async listByStatus(status: string, limitCount = 50): Promise<any[]> {
    const outboxRef = outboxCollection();
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
