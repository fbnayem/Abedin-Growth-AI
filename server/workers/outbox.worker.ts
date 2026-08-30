import { outboxService } from '../services/outbox.service';
import { gmailService } from '../services/gmail.service';
import { db } from '../db/index';
import { messages } from '../db/schema';
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
        // Kill switch is active. Do not process the queue.
        return;
      }
      
      const jobs = await outboxService.fetchPendingJobs(5);
      for (const job of jobs) {
        try {
          console.log(`Processing outbox job ${job.id} for conversation ${job.conversationId}`);
          
          // Double check suppression here in a real app before sending
          // const isSuppressed = await suppressionService.check(job.payload.to);
          // if (isSuppressed) { ... outboxService.markFailed(job.id, "Suppressed"); continue; }

          const result = await gmailService.sendEmail({
            to: job.payload.to,
            subject: job.payload.subject,
            bodyHtml: job.payload.htmlBody,
            bodyText: job.payload.textBody,
            inReplyTo: job.payload.inReplyTo,
            references: job.payload.references,
            threadId: job.payload.threadId,
          });

          // Create the message record in the DB
          await db.insert(messages).values({
            id: uuidv4(),
            conversationId: job.conversationId,
            provider: 'GMAIL',
            providerMessageId: result.messageId,
            providerThreadId: result.threadId,
            direction: 'OUTBOUND',
            sender: 'SYSTEM', // Should be the actual sender
            recipients: [job.payload.to],
            subject: job.payload.subject,
            sanitizedHtmlBody: job.payload.htmlBody,
            textBody: job.payload.textBody,
            status: 'SENT',
            isAutomated: true,
            sentAt: new Date(),
          });

          await outboxService.markProcessed(job.id, result.messageId);
        } catch (jobError: any) {
          console.error(`Error processing outbox job ${job.id}:`, jobError);
          await outboxService.markFailed(job.id, jobError.message || "Unknown error");
        }
      }
    } catch (err) {
      // Avoid crashing the worker loop on DB errors
      console.error("Outbox worker loop error:", err);
    }
  }
}

export const outboxWorker = new OutboxWorker();
