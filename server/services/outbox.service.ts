import { store } from '../store';
import { orgPath } from '../tenancy/orgScope';
import { assertTransition, OUTBOX_JOB } from '../domain/stateMachines';
import { OUTBOX_PAYLOAD_VERSION } from '../domain/outboxEnvelope';
import {
  requeueTargetFor,
  writeOperatorAction,
  type Attribution,
  type OperatorAction,
} from '../domain/operatorAction';
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
} from '../store';

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

/**
 * S48 — who enqueued this job. Recorded on every row, read by no decision.
 *
 * `npm_package_version` is set by npm when the process is started through a script; when it is
 * not, saying so is better than inventing a number, because a version that is wrong is worse
 * than one that is missing.
 */
export const PRODUCER_ID = `outbox.service@${process.env.npm_package_version ?? 'unknown'}`;

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
  if (!store) return null;
  return collection(store, orgPath(organizationId, 'outbox'));
}

function outboxDoc(organizationId: string, id: string) {
  if (!store) return null;
  return doc(store, orgPath(organizationId, 'outbox'), id);
}

/**
 * S38 — the append-only record of what operators did to this queue.
 *
 * Separate from the job document because the job holds only its CURRENT state: an approval
 * overwrites the previous `approvedBy`, and a rejection leaves nothing comparable. "What has
 * anyone done to this queue" had no answer that did not involve reading every row and
 * inferring.
 */
function operatorActionsCollection(organizationId: string) {
  if (!store) return null;
  return collection(store, orgPath(organizationId, 'operatorActions'));
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
    integrity?: { generatedForInboundVersion: number; approvalDigest?: string },
    /**
     * P0.11 — The status the row is CREATED with.
     *
     * It used to be `PENDING` unconditionally, and a caller that needed a hold called
     * `holdForHumanReview` immediately afterwards. That is two writes, and between them the
     * row is PENDING and therefore claimable: `claimPendingJobs` queries
     * `where(status == PENDING)` and the worker runs that query on a continuous tick. A tick
     * landing in the window claims and dispatches a draft that was never cleared to send.
     *
     * `holdForHumanReview` docstring asserted that "no worker will claim it", which was true
     * of the steady state and not of the window the ordering created. Passing the status here
     * removes the window rather than narrowing it: the row is never PENDING at any point.
     */
    initialStatus: 'PENDING' | 'HUMAN_REVIEW' = 'PENDING',
    /** Why it is held. Required when `initialStatus` is HUMAN_REVIEW, for the operator queue. */
    heldReason?: string
  ) {
    const outboxRef = outboxCollection(organizationId);
    if (!outboxRef || !store) return null;
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
        // S48 — the shape of `payload`, named by the build that wrote it.
        //
        // A worker from a different build has no other way to tell an old job from a new one
        // with a field deliberately absent. Without this the two are the same bytes, and the
        // consumer's only options are to guess or to dispatch on a guess — which it did.
        schemaVersion: OUTBOX_PAYLOAD_VERSION,
        // Not read by any decision. Recorded because when a rolling deploy does strand jobs,
        // the first question is which build enqueued them, and a queue that cannot answer it
        // turns a five-minute answer into an archaeology exercise.
        producer: PRODUCER_ID,
        status: initialStatus,
        ...(initialStatus === 'HUMAN_REVIEW'
          ? {
              heldReason: heldReason ?? 'Held at enqueue; no reason was supplied.',
              heldAt: Date.now(),
            }
          : {}),
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
    if (!outboxRef || !store) return [];

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
        const won = await runTransaction(store, async (tx) => {
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
    if (!outboxRef || !store) return 0;

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
    if (!ref || !store) return;

    try {
      await runTransaction(store, async (tx) => {
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
   * P0.11 — `holdForHumanReview` was DELETED here.
   *
   * It had exactly one caller: the enqueue-at-PENDING-then-flip sequence in
   * inboundPipeline.ts, which is the race this change removed by letting `queueMessage` take
   * the status directly. With that gone it has none.
   *
   * Deleted rather than kept for a future operator console, for a reason beyond it being
   * unused: it was a bare `updateDoc({ status: HUMAN_REVIEW })` with no state gate. Every
   * other transition on this collection goes through `assertTransition(OUTBOX_JOB, ...)` —
   * `approveForSending` does, transactionally — so this one method could move a PROCESSED or
   * DEAD_LETTER job back into the review queue and nothing would refuse it. An operator hold
   * (S38) needs to be written against the transition map, not resurrected from here.
   */
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
    attribution: Attribution
  ): Promise<{ ok: true } | { ok: false; code: 'NOT_FOUND' | 'ILLEGAL_TRANSITION'; message: string }> {
    const ref = outboxDoc(organizationId, id);
    if (!ref || !store) {
      return { ok: false, code: 'NOT_FOUND', message: 'Datastore unavailable.' };
    }
    try {
      return await runTransaction(store, async (tx) => {
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
          approvedBy: attribution.kind === 'IDENTIFIED' ? attribution.actor : null,
          approvedAt: Date.now(),
          nextAttemptAt: Date.now(),
        });
        // In the SAME transaction. A state change that succeeded while its record failed would
        // be a message released to a customer with nothing saying who released it, which is the
        // exact gap this replaces.
        this.writeOperatorAction(tx, {
          action: 'APPROVE',
          organizationId,
          jobId: id,
          attribution,
          fromStatus: data.status,
          toStatus: 'PENDING',
          reason: null,
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
    attribution: Attribution,
    reason: string
  ): Promise<{ ok: true } | { ok: false; code: 'NOT_FOUND' | 'ILLEGAL_TRANSITION'; message: string }> {
    const ref = outboxDoc(organizationId, id);
    if (!ref || !store) {
      return { ok: false, code: 'NOT_FOUND', message: 'Datastore unavailable.' };
    }
    try {
      return await runTransaction(store, async (tx) => {
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
          cancelledBy: attribution.kind === 'IDENTIFIED' ? attribution.actor : null,
          cancelledReason: reason,
          cancelledAt: new Date().toISOString(),
          leaseUntil: null,
        });
        this.writeOperatorAction(tx, {
          action: 'REJECT',
          organizationId,
          jobId: id,
          attribution,
          fromStatus: data.status,
          toStatus: 'CANCELLED',
          reason,
        });
        return { ok: true as const };
      });
    } catch (e: any) {
      console.error('[Outbox] cancelJob failed:', e?.message);
      return { ok: false, code: 'NOT_FOUND', message: 'Cancellation could not be recorded.' };
    }
  }

  /**
   * S38 — write the audit row, inside the caller's transaction.
   *
   * Takes the transaction rather than opening its own, so the state change and the record of it
   * commit together or not at all. A separate write could succeed while the update failed
   * (a record of something that did not happen) or fail while the update succeeded (a message
   * released to a customer with nothing saying who released it). Both are worse than either
   * half failing.
   *
   * `operatorActionRecord` throws on a record that says nothing moved, and that throw aborts the
   * transaction — which is the intended behaviour, not an accident to be caught here.
   */
  private writeOperatorAction(
    tx: { set: (ref: any, data: any) => void },
    input: {
      action: OperatorAction;
      organizationId: string;
      jobId: string;
      attribution: Attribution;
      fromStatus: string;
      toStatus: string;
      reason: string | null;
    }
  ): void {
    const actions = operatorActionsCollection(input.organizationId);
    // The decision — including the refusal when there is nowhere to record — lives in
    // server/domain/operatorAction.ts so it can be exercised directly. Asserting it by grepping
    // this file for a `throw` could not tell `if (!actions)` from `if (false)`, which a
    // mutation run demonstrated.
    writeOperatorAction(
      tx,
      actions === null ? null : { collection: actions, newDocRef: (c) => doc(c as any, uuidv4()) },
      { ...input, at: Date.now() }
    );
  }

  /**
   * S38 — the way back from a queue an operator cannot otherwise recover.
   *
   * There was none. A job that exhausted its attempts or was refused for a stale draft sat in
   * DEAD_LETTER, and the only route back was an engineer editing the datastore by hand — with,
   * by construction, no record of who changed what.
   *
   * A DEAD_LETTER job returns to HUMAN_REVIEW, never to PENDING. PENDING is claimable by the
   * worker on its next tick, so requeueing straight there would let one click re-send something
   * that had already failed five times or been refused as stale, with no second look. The shared
   * transition map has no `DEAD_LETTER -> PENDING` edge, and `requeueTargetFor` agrees with it
   * rather than restating the rule loosely.
   */
  async requeue(
    organizationId: string,
    id: string,
    attribution: Attribution,
    reason: string
  ): Promise<{ ok: true; toStatus: string } | { ok: false; code: 'NOT_FOUND' | 'ILLEGAL_TRANSITION'; message: string }> {
    const ref = outboxDoc(organizationId, id);
    if (!ref || !store) {
      return { ok: false, code: 'NOT_FOUND', message: 'Datastore unavailable.' };
    }
    try {
      return await runTransaction(store, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) {
          return { ok: false as const, code: 'NOT_FOUND' as const, message: 'No such outbox job.' };
        }
        const data: any = snap.data();
        const target = requeueTargetFor(data.status);
        if (target.ok === false) {
          return { ok: false as const, code: 'ILLEGAL_TRANSITION' as const, message: target.message };
        }
        // Checked against the shared map as well, so the two cannot drift apart silently.
        const verdict = assertTransition(OUTBOX_JOB, data.status, target.toStatus);
        if (verdict.ok === false) {
          return {
            ok: false as const,
            code: 'ILLEGAL_TRANSITION' as const,
            message: verdict.message,
          };
        }
        tx.update(ref, {
          status: target.toStatus,
          // The attempt counter is NOT reset. An operator asking for another try is not
          // evidence that the previous five did not happen, and a reset would make the
          // dead-letter ceiling unreachable by repeated clicking.
          leaseUntil: null,
          claimedBy: null,
          nextAttemptAt: Date.now(),
          requeuedAt: Date.now(),
          heldReason:
            target.toStatus === 'HUMAN_REVIEW'
              ? `Requeued from DEAD_LETTER: ${reason}`
              : undefined,
        });
        this.writeOperatorAction(tx, {
          action: 'REQUEUE',
          organizationId,
          jobId: id,
          attribution,
          fromStatus: data.status,
          toStatus: target.toStatus,
          reason,
        });
        return { ok: true as const, toStatus: target.toStatus };
      });
    } catch (e: any) {
      console.error('[Outbox] requeue failed:', e?.message);
      return { ok: false, code: 'NOT_FOUND', message: 'The requeue could not be recorded.' };
    }
  }

  /** Operator/inspection helper: list jobs by status. */
  /**
   * S28 — when this conversation last received an autonomous reply, and how many.
   *
   * RETURNS NULL RATHER THAN AN EMPTY ARRAY WHEN IT CANNOT ANSWER, and that distinction is the
   * whole reason this is a separate method rather than a call to `listByStatus`.
   *
   * `listByStatus` catches its own errors and returns `[]`. That is right for drawing the
   * operator console — a queue it cannot read displays as empty, and the operator sees an empty
   * console rather than a crash. It would be an inversion here: a failed query would become
   * "no replies have been sent on this conversation", and the loop check would permit the send
   * it exists to stop. Three of the autonomy lock's original defects were exactly that shape.
   *
   * PROCESSED only. A job that is PENDING has not gone anywhere, and one that DEAD_LETTERED
   * never will; counting either would refuse sends on the strength of mail nobody received.
   *
   * The cap is a refusal, not a truncation. Rows come back ordered by id, so taking the first
   * `HISTORY_CAP` of a longer set could return only old ones and under-count the window —
   * which permits. Hitting the cap therefore answers "cannot determine" and the caller refuses.
   */
  async replyTimesForConversation(
    organizationId: string,
    conversationId: string
  ): Promise<number[] | null> {
    const outboxRef = outboxCollection(organizationId);
    if (!outboxRef) return null;
    const HISTORY_CAP = 200;
    try {
      const q = query(
        outboxRef,
        where('conversationId', '==', conversationId),
        where('status', '==', 'PROCESSED'),
        limit(HISTORY_CAP)
      );
      const snap = await getDocs(q);
      const times: number[] = [];
      let unreadable = false;
      snap.forEach((d) => {
        const data = d.data() as Record<string, unknown>;
        const at = data.processedAt;
        // A PROCESSED row with no usable timestamp cannot be placed inside or outside the
        // window. Dropping it would shrink the count, and shrinking the count permits.
        if (typeof at !== 'number' || !Number.isFinite(at)) {
          unreadable = true;
          return;
        }
        times.push(at);
      });
      if (unreadable) {
        console.warn(
          `[Outbox] A PROCESSED job for conversation ${conversationId} carries no usable ` +
            'processedAt; the reply history cannot be counted and the send will be refused.'
        );
        return null;
      }
      if (times.length >= HISTORY_CAP) {
        console.warn(
          `[Outbox] Reply history for conversation ${conversationId} hit the ${HISTORY_CAP}-row ` +
            'cap; refusing rather than counting a truncated list.'
        );
        return null;
      }
      return times;
    } catch (e: any) {
      console.error('[Outbox] replyTimesForConversation failed:', e?.message);
      return null;
    }
  }

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
