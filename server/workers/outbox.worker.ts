import { outboxService } from '../services/outbox.service';
import { gmailService } from '../services/gmail.service';
import { db } from '../db/index';
import { messages } from '../db/schema';
import { v4 as uuidv4 } from 'uuid';

import { eq } from 'drizzle-orm';
import { oauthConnections } from '../db/schema';


import { circuitBreaker } from '../agents/salesDecisionEngine';
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

          
          // Get the organizationId for the conversation to fetch the right token
          // Since outboxMessages has conversationId, we need to join conversations to get orgId.
          const convRows = await db.select().from(messages).where(eq(messages.id, 'dummy')).limit(0); // wait, easier to just query conversations
          const { conversations } = require('../db/schema');
          const convs = await db.select().from(conversations).where(eq(conversations.id, job.conversationId));
          const orgId = convs.length > 0 ? convs[0].organizationId : "default";

          const oauths = await db.select().from(oauthConnections).where(eq(oauthConnections.organizationId, orgId));
          const gmailAuth = oauths.find(o => o.provider === 'GMAIL');
          
          if (!gmailAuth || !gmailAuth.accessToken) {
             throw new Error("No valid Gmail OAuth connection found for organization: " + orgId);
          }
          
          gmailService.setCredentials({ access_token: gmailAuth.accessToken });

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
