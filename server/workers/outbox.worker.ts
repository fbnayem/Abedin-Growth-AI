import { outboxService } from '../services/outbox.service';
import {
  lockStateOf,
  mayProceed,
  refusalFor,
  LOCK_STATUS,
} from '../domain/autonomyLock';
import { actionGateway, ActionType, isFabricatedProviderId } from '../gateway/actionGateway';

import { db } from '../db/index';
import { messages } from '../db/schema';

import { conversations } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { store } from '../store';
import { getCircuitBreakerState } from '../services/circuitBreaker.service';
import { verifyDraftIntegrity } from '../services/draftIntegrity.service';
import { orgPath } from '../tenancy/orgScope';
import { listServiceableOrgIds } from '../tenancy/organizations';
import { collection, addDoc, doc, getDoc, getDocs, query, where } from '../store';
import { v4 as uuidv4 } from 'uuid';
import { circuitBreaker } from '../agents/salesDecisionEngine';
import { readEnvelope, mayDispatch, deadLetterReason } from '../domain/outboxEnvelope';

export class OutboxWorker {
  public isRunning = false;
  private interval: NodeJS.Timeout | null = null;
  /**
   * P0.5/P0.9 — Re-entrancy guard. `setInterval(() => this.processQueue(), 5000)` does not
   * await the previous tick, so with no timeouts on outbound calls a stalled provider request
   * left ticks accumulating every 5 seconds without bound. This flag ensures at most one tick
   * is in flight; combined with fetchWithTimeout, a hung provider can no longer pile up work.
   */
  private processing = false;
  private reapCounter = 0;
  private readonly workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`Starting Outbox Worker (${this.workerId})...`);
    this.interval = setInterval(() => {
      void this.processQueue();
    }, 5000);
  }

  stop() {
    this.isRunning = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    console.log(`Outbox Worker (${this.workerId}) stopped.`);
  }

  private async processQueue() {
    if (this.processing) {
      // A previous tick is still running. Skipping is correct: the queue is durable and the
      // next tick will pick up whatever is left.
      return;
    }
    this.processing = true;
    try {
      // P0.3 — Consult the DURABLE kill switch, not just the in-process flag, so a pause set
      // on another replica (or before this process started) is observed here too.
      const cbState = await getCircuitBreakerState();
      if (!cbState.globalAutonomousSendEnabled) {
        return;
      }

      if (!store) return;

      // P1.1 — The queue is per tenant, so the worker asks which tenants it serves rather
      // than assuming there is one. An empty list means this process does not know whose
      // work it would be sending; it holds everything and says so (see listServiceableOrgIds).
      const orgIds = await listServiceableOrgIds();

      // P0.9 — Periodically return jobs stranded by a crashed worker. Every 12th tick ≈ 60s,
      // which matches the lease length. Reaping is per tenant for the same reason claiming is.
      const shouldReap = ++this.reapCounter % 12 === 0;

      for (const orgId of orgIds) {
        try {
          if (shouldReap) {
            await outboxService.reapExpiredLeases(orgId);
          }
          await this.processOrganization(orgId);
        } catch (orgError) {
          // One tenant's failure must not stop the others being served.
          console.error(`Outbox worker failed for organisation ${orgId}:`, orgError);
        }
      }
    } catch (err) {
      console.error("Outbox worker loop error:", err);
    } finally {
      // Must always clear, or a single throw permanently wedges the worker.
      this.processing = false;
    }
  }

  /**
   * Process one tenant's queue. Every datastore path below is built from THIS org id, and the
   * gateway request carries it, so a job can only ever be dispatched under the tenant whose
   * queue it was claimed from.
   */
  private async processOrganization(orgId: string) {
      // P0.9 — Atomically CLAIM jobs rather than reading PENDING rows. Every job returned
      // here is exclusively owned by this worker for the duration of its lease, so two
      // workers (or two overlapping ticks) can no longer send the same message.
      const jobs = await outboxService.claimPendingJobs(orgId, 5, this.workerId);

      for (const job of jobs) {
        try {
          console.log(`Processing outbox job ${job.id} for conversation ${job.conversationId}`);

          // Need organizationId from conversation to pass to ActionGateway


          // P0.7 — STORE UNIFICATION.
          //
          // These two guards previously queried POSTGRES (`db.select()`) while the queue they
          // guard lives in FIRESTORE. Two consequences, both bad:
          //   - With DATABASE_URL unset, `db` is a Proxy that throws on property access, so
          //     the first guard threw, every job was caught by the outer handler and marked
          //     FAILED, and nothing was ever dispatched.
          //   - With Postgres connected but unpopulated (its actual state, since the Firestore
          //     write path never writes to it), both guards evaluated ZERO rows and therefore
          //     always PASSED — a stale-draft protection that could never fire.
          // Both now read the same store the queue lives in.

          // Rule P: HUMAN OWNERSHIP LOCK.
          // Note the ActionGateway performs this check too (checkHumanOwnershipLock); it is
          // repeated here so a lock set after queueing stops the job before dispatch.
          //
          // The truthiness test that used to be here read `autonomyPausedByHuman` and a legacy
          // status directly. It let coercion decide: `"false"` is truthy and `0` is falsy, and
          // a conversation document that did not exist read as "no human has taken this".
          // `lockStateOf` answers in three states and is shared with the gateway, so the two
          // can no longer disagree about the same conversation.
          const convSnap = await getDoc(
            doc(store!, orgPath(orgId, 'conversations'), job.conversationId)
          );
          const lock = lockStateOf(convSnap.exists(), convSnap.data());
          if (!mayProceed(lock)) {
              console.warn(`${refusalFor(lock, job.conversationId)} Skipping autonomous send.`);
              await outboxService.markFailed(orgId, job.id, LOCK_STATUS, true);
              continue;
          }

          // P0.12 — STALE DRAFT AND APPROVAL INTEGRITY (addendum §8, §9).
          //
          // The wall-clock comparison that used to live here is gone. It read
          // `latestInbound.receivedAt > job.createdAt` from a Postgres table the Firestore
          // write path never populated, so it evaluated zero rows and always passed — and §8
          // forbids wall-clock as the primary mechanism regardless, because clock skew and
          // same-millisecond arrivals both defeat it.
          //
          // The draft now carries the conversation's inbound version from the moment it was
          // generated, and that version must EQUAL the conversation's current version right
          // now. Any difference means a message arrived in between. The approval digest is
          // re-checked at the same moment, so content altered after approval is refused.
          //
          // This is the last point at which a send can be stopped, which is exactly why the
          // check belongs here rather than only at approval time.
          const integrity = await verifyDraftIntegrity(job);
          if (integrity.ok === false) {
              const { code, reason } = integrity;
              console.warn(`[OutboxWorker] ${code} for job ${job.id}: ${reason}`);
              // Terminal: a stale or altered draft is never made valid by retrying it. It must
              // be regenerated from the current conversation, or re-approved.
              await outboxService.markFailed(orgId, job.id, `${code}: ${reason}`, true);
              continue; // Skip sending
          }

          // S48 — CAN THIS BUILD ACT ON THIS JOB AT ALL?
          //
          // Asked here, before the gateway, because the gateway's `payload` is typed `any` and
          // every guard downstream reads fields off it. A guard that evaluates a payload it
          // does not understand is not a guard: during a rolling deploy it would apply a new
          // constraint to an old job that cannot carry it, or — on a rollback — quietly drop
          // the fields a newer build added and report the send as a success.
          //
          // Terminal, not retried. Neither an unsupported version nor a payload that does not
          // parse becomes valid by waiting; retrying would reach the same dead letter five
          // attempts later, having kept the queue busy failing in the meantime.
          const envelope = readEnvelope(job);
          if (mayDispatch(envelope) === false) {
            const reason = deadLetterReason(envelope);
            console.warn(`[OutboxWorker] refusing job ${job.id}: ${reason}`);
            await outboxService.markFailed(orgId, job.id, reason, true);
            continue;
          }

          const actionRequest = {
            actionType: ActionType.EMAIL_SEND,
            organizationId: orgId,
            targetId: envelope.payload.to,
            conversationId: job.conversationId,
            proposedBy: 'OutboxWorker',
            payload: {
              // From the PARSED payload, not from `job.payload`. Reading the raw document here
              // would make the validation above decorative: the check would pass and the send
              // would still use whatever the datastore happened to hold.
              to: envelope.payload.to,
              subject: envelope.payload.subject,
              htmlBody: envelope.payload.htmlBody,
              textBody: envelope.payload.textBody,
              inReplyTo: envelope.payload.inReplyTo,
              references: envelope.payload.references,
              threadId: envelope.payload.threadId,
              // S32 — the job's idempotency key is what the outbound Message-ID is derived
              // from, and therefore what makes this send reconcilable after an ambiguous
              // outcome. The gateway refuses to send without it rather than sending something
              // it could never afterwards ask the provider about.
              idempotencyKey: job.idempotencyKey,
            }
          };

          // Route ALL outbound emails through the Action Gateway (Requirement C & A)
          const result = await actionGateway.dispatchAction(actionRequest);

          if (result.success) {
             // P0.8 — These two lines used to read:
             //   const providerMsgId = result.providerResult?.messageId || 'sim_' + Date.now();
             // so a gateway success carrying NO provider id still produced a durable message
             // record with status SENT and an id that looked real. Addendum §3: a message
             // cannot become SENT without a real provider result. A success without a
             // verifiable provider id is now a contradiction, and the job fails closed.
             const providerMsgId = result.providerResult?.messageId;
             const providerThreadId = result.providerResult?.threadId;

             if (!providerMsgId || isFabricatedProviderId(providerMsgId)) {
                await outboxService.markFailed(
                  orgId,
                  job.id,
                  `FABRICATED_PROVIDER_ID: gateway reported success but returned ` +
                  `${providerMsgId ? `a locally-minted id (${providerMsgId})` : 'no provider message id'}. ` +
                  `Refusing to record this as SENT.`
                );
                console.error(
                  `[OutboxWorker] Refused to mark job ${job.id} SENT: provider id missing or fabricated.`
                );
                continue;
             }

             // Create message record
             await addDoc(
               collection(store!, orgPath(orgId, 'conversations', job.conversationId, 'messages')),
               {
                id: uuidv4(),
                conversationId: job.conversationId,
                provider: 'GMAIL',
                providerMessageId: providerMsgId,
                providerThreadId: providerThreadId,
                direction: 'OUTBOUND',
                sender: 'SYSTEM',
                recipients: [envelope.payload.to],
                subject: envelope.payload.subject,
                // Renamed with the inbound field. This one is our OWN html, but a column
                // whose name means different things in different rows is worse than one
                // that is merely blunt.
                rawHtmlBody: envelope.payload.htmlBody,
                textBody: envelope.payload.textBody,
                status: 'SENT',
                isAutomated: true,
                sentAt: new Date(),
               }
             );

             await outboxService.markProcessed(orgId, job.id, providerMsgId);
          } else {
             if (result.isAmbiguousResult) {
                // Addendum §32 — an ambiguous provider result is NOT a failure. The provider
                // may have delivered the message and only the response been lost.
                //
                // This branch used to end here, with an unconditional terminal dead-letter and
                // a comment saying it "requires an operator or the reconciliation worker to
                // resolve". There was no reconciliation worker, so EVERY ambiguous send was
                // dead-lettered — including the ones that genuinely never left, which the
                // customer is still waiting for. Safe, and wrong about half the time.
                //
                // The gateway now asks the provider before returning, and the verdict decides
                // which of two different things this is. Note what is NOT here: a branch for
                // APPLIED. An applied send comes back with `success: true` and the provider's
                // own id, so it is recorded as SENT by the path above — where a delivered
                // message belongs.
                const verdict = result.reconciliation?.verdict ?? 'STILL_UNKNOWN';
                const evidence = result.reconciliation?.evidence ?? 'no reconciliation was attempted';

                if (verdict === 'NOT_APPLIED') {
                  // Asked, and answered: the provider does not have it, and the settle window
                  // has passed. The ambiguity is resolved to an ordinary failure, so this goes
                  // back through backoff and retry like any other — which is the point of
                  // reconciling rather than dead-lettering everything.
                  console.warn(
                    `[OutboxWorker] Job ${job.id} was ambiguous and reconciled to NOT_APPLIED. ` +
                    `Retryable. ${evidence}`
                  );
                  await outboxService.markFailed(
                    orgId,
                    job.id,
                    `RECONCILED_NOT_APPLIED: ${evidence}`
                  );
                } else {
                  // STILL_UNKNOWN. Terminal, as before: retrying an irreversible action whose
                  // outcome we could not establish is how duplicate emails reach a customer.
                  console.warn(
                    `[OutboxWorker] Job ${job.id} is ambiguous and reconciliation could not ` +
                    `resolve it. Dead-lettering to prevent an un-reconciled retry. ${evidence}`
                  );
                  await outboxService.markFailed(
                    orgId,
                    job.id,
                    `AMBIGUOUS_PROVIDER_RESULT: reconciliation returned ${verdict}. ${evidence}`,
                    true
                  );
                }
             } else if (result.blockedReason) {
                // Policy/flag block. Terminal: retrying cannot change a policy decision.
                await outboxService.markFailed(orgId, job.id, `POLICY_BLOCKED: ${result.blockedReason}`, true);
             } else if (result.errorCode === 'PROVIDER_NOT_CONFIGURED') {
                // Terminal: no amount of retrying creates a credential.
                await outboxService.markFailed(orgId, job.id, `PROVIDER_NOT_CONFIGURED: ${result.error}`, true);
             } else if (result.errorCode === 'UNRECONCILABLE_SEND') {
                // S32 — terminal. The send was refused because it could not be given an
                // identity the provider could later be asked about, and retrying reproduces
                // that refusal exactly. It needs a deployment change (OUTBOUND_MESSAGE_ID_DOMAIN),
                // not another attempt.
                await outboxService.markFailed(orgId, job.id, `UNRECONCILABLE_SEND: ${result.error}`, true);
             } else {
                throw new Error(result.error || "Gateway execution failed");
             }
          }

        } catch (jobError: any) {
          // Retryable by default: transient provider/network errors get backoff and retry,
          // and exhaust into DEAD_LETTER rather than looping forever.
          console.error(`Error processing outbox job ${job.id}:`, jobError);
          await outboxService.markFailed(orgId, job.id, jobError.message || "Unknown error");
        }
      }
  }
}

export const outboxWorker = new OutboxWorker();
