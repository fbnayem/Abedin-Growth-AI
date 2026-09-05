import { outboxService } from '../services/outbox.service';
import { aiSafetyService } from '../services/aiSafety.service';
import { actionGateway, ActionType } from '../gateway/actionGateway';
import { firestore } from '../firebase';
import { collection, addDoc } from 'firebase/firestore';
import { v4 as uuidv4 } from 'uuid';
import { circuitBreaker } from '../agents/salesDecisionEngine';

export class OutboxWorker {
  private isRunning = false;
  private interval: NodeJS.Timeout | null = null;

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("Starting Outbox Worker...");
    this.interval = setInterval(() => this.processQueue(), 5000);
  }

  stop() {
    this.isRunning = false;
    if (this.interval) clearInterval(this.interval);
  }

  private async processQueue() {
    try {
      if (!circuitBreaker.globalAutonomousSendEnabled) {
        return;
      }

      if (!firestore) return;

      const jobs = await outboxService.fetchPendingJobs(5);
      
      for (const job of jobs) {
        try {
          console.log(`Processing outbox job ${job.id} for conversation ${job.conversationId}`);

          // Need organizationId from conversation to pass to ActionGateway
          const orgId = "org_1"; // Defaulting for now based on migration

          const actionRequest = {
            actionType: ActionType.EMAIL_SEND,
            organizationId: orgId,
            targetId: job.payload.to,
            conversationId: job.conversationId,
            proposedBy: 'OutboxWorker',
            payload: {
              to: job.payload.to,
              subject: job.payload.subject,
              htmlBody: job.payload.htmlBody,
              textBody: job.payload.textBody,
              inReplyTo: job.payload.inReplyTo,
              references: job.payload.references,
              threadId: job.payload.threadId,
            }
          };

          // Route ALL outbound emails through the Action Gateway (Requirement C & A)
          const result = await actionGateway.dispatchAction(actionRequest);

          if (result.success) {
             // Successfully sent (or simulated successful send via gateway)
             const providerMsgId = result.providerResult?.messageId || 'sim_' + Date.now();
             const providerThreadId = result.providerResult?.threadId || 'sim_thread_' + Date.now();

             // Create message record
             await addDoc(collection(firestore, `organizations/${orgId}/conversations/${job.conversationId}/messages`), {
                id: uuidv4(),
                conversationId: job.conversationId,
                provider: 'GMAIL',
                providerMessageId: providerMsgId,
                providerThreadId: providerThreadId,
                direction: 'OUTBOUND',
                sender: 'SYSTEM',
                recipients: [job.payload.to],
                subject: job.payload.subject,
                sanitizedHtmlBody: job.payload.htmlBody,
                textBody: job.payload.textBody,
                status: 'SENT',
                isAutomated: true,
                sentAt: new Date(),
             });

             await outboxService.markProcessed(job.id, providerMsgId);
          } else {
             if (result.blockedReason) {
                // Feature flag blocked it, mark as failed so it doesn't loop forever
                await outboxService.markFailed(job.id, result.blockedReason);
             } else {
                throw new Error(result.error || "Gateway execution failed");
             }
          }

        } catch (jobError: any) {
          console.error(`Error processing outbox job ${job.id}:`, jobError);
          await outboxService.markFailed(job.id, jobError.message || "Unknown error");
        }
      }
    } catch (err) {
      console.error("Outbox worker loop error:", err);
    }
  }
}

export const outboxWorker = new OutboxWorker();
