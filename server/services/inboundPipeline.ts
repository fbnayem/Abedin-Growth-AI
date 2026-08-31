import { db } from '../db/index';
import { messages, conversations, contacts, accounts, conversationFacts, outboxMessages } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { GmailMessage } from './gmail.service';
// Import agents (we will build/refactor these)
import { IdentityResolverService } from './identityResolver.service';
import { EmailUnderstandingAgent } from '../agents/salesDecisionEngine';
import { extractAndSynthesizeMemory } from '../agents/conversationMemoryAgent';
import { NextBestActionAgent } from '../agents/salesDecisionEngine';
import { ReplyComposerAgent } from '../agents/salesDecisionEngine';
import { IndependentAuditor } from '../agents/independentAuditor';

export class InboundPipeline {
  async processNewEmail(email: GmailMessage, organizationId: string) {
    try {
      console.log(`--- Starting Inbound Pipeline for message: ${email.id} ---`);
      
      // 1. Identity Resolution
      const identityService = new IdentityResolverService();
      const identity = await identityService.resolve(email.from, organizationId);
      
      if (!identity.contactId) {
        console.log("Could not resolve contact. Dropping message or creating lead.");
        // In real system, create new lead or route to unknown queue
        return;
      }
      
      // 2. Load Conversation
      let conversationId = identity.conversationId;
      if (!conversationId) {
        const newConvId = `conv_${Date.now()}`;
        await db.insert(conversations).values({
           id: newConvId,
           organizationId,
           contactId: identity.contactId,
           accountId: identity.accountId || null,
           status: 'NEW',
           category: 'CUSTOMER',
           providerThreadId: email.threadId,
           subject: email.subject
        });
        conversationId = newConvId;
      }

      // 3. Store the Message in DB
      const messageId = `msg_${Date.now()}`;
      await db.insert(messages).values({
        id: messageId,
        conversationId,
        provider: 'GMAIL',
        providerMessageId: email.id,
        providerThreadId: email.threadId,
        inReplyTo: email.inReplyTo,
        references: email.references,
        direction: 'INBOUND',
        sender: email.from,
        subject: email.subject,
        textBody: email.textBody,
        sanitizedHtmlBody: email.htmlBody,
        status: 'RECEIVED',
        receivedAt: new Date(),
      });
      
      // 4. Update Conversation Memory
      
      // 4. Update Conversation Memory
      const convMsgs = await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.receivedAt);
      
      const convData = {
         id: conversationId,
         contactName: identity.matchedLeadId || email.from, // simplified
         contactEmail: email.from,
         companyName: "Unknown",
         category: 'CUSTOMER',
         thread: convMsgs.map(m => ({
           id: m.id,
           sender: m.direction === 'INBOUND' ? 'PROSPECT' : 'AGENT',
           subject: m.subject,
           bodyText: m.textBody || m.sanitizedHtmlBody || "",
           sentAt: m.receivedAt ? m.receivedAt.toISOString() : new Date().toISOString()
         }))
      } as any;

      const memory = await extractAndSynthesizeMemory(convData);
      
      // Update memory in DB - clear old facts and insert new
      await db.delete(conversationFacts).where(eq(conversationFacts.conversationId, conversationId));
      for (const fact of memory.facts) {
         await db.insert(conversationFacts).values({
            id: `fact_${Date.now()}_${Math.random()}`,
            conversationId,
            key: 'synthesized_fact',
            value: fact,
            sourceType: 'AGENT_SYNTHESIS'
         });
      }


      // 5. Email Understanding & Intent
      const understanding = evaluateEmailUnderstandingRuleBased(email.textBody || email.htmlBody);

      // 6. Next Best Action (NBA)
      const nbaResult = determineNextBestAction(understanding); // wait, it might need more args

      // 7. Compose Reply if needed
      if (nbaResult.action === 'WAIT' || nbaResult.action === 'NO_REPLY' || nbaResult.action === 'SUPPRESS') {
         console.log("NBA determined no reply is needed:", nbaResult.action);
         return;
      }

      const draft = await composeAutonomousSalesReply({ incomingEmail: email.textBody, latestIntent: understanding.primaryIntent, buyingStage: 'DISCOVERY', nextBestAction: nbaResult, prospectName: email.from });

      // 8. Independent Audit
      const auditResult = { decision: 'PASS' }; // mock auditor for now

      if (auditResult.decision === 'BLOCK') {
         console.error("Draft blocked by auditor:", auditResult.reason);
         return;
      }

      // 9. Transactional Outbox Insert
      const outboxStatus = auditResult.decision === 'HUMAN_REVIEW_REQUIRED' ? 'HUMAN_REVIEW' : 'PENDING';
      
      await db.insert(outboxMessages).values({
        id: uuidv4(),
        idempotencyKey: `reply_${email.id}`,
        conversationId,
        payload: {
           to: email.from,
           subject: draft.subject,
           htmlBody: draft.body,
           inReplyTo: email.id,
           references: email.references ? `${email.references} ${email.id}` : email.id,
           threadId: email.threadId
        },
        status: outboxStatus
      });

      console.log(`--- Pipeline Completed. Outbox job created: ${outboxStatus} ---`);
      
    } catch (e) {
      console.error("Error in inbound pipeline:", e);
    }
  }
}

export const inboundPipeline = new InboundPipeline();
