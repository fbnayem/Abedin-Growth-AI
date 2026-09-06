import { CanaryRolloutService } from './canary.service';
import { BudgetTracker } from '../policies/workflowBudgets';
import { MetricsService } from './metrics.service';
import { LedgerService } from './ledgers.service';
import { BuyingStage } from "../../shared/domain/models";
import { db } from '../db/index';
import { messages, conversations, contacts, accounts, conversationFacts, outboxMessages } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { GmailMessage } from './gmail.service';
import { outboxService } from './outbox.service';
import { incrementInboundVersion, computeApprovalDigest } from './draftIntegrity.service';
import { isValidOrgId } from '../tenancy/orgScope';
// Import agents (we will build/refactor these)
import { IdentityResolverService } from './identityResolver.service';
import { evaluateEmailUnderstandingRuleBased, determineNextBestAction, composeAutonomousSalesReply } from '../agents/salesDecisionEngine';
import { extractAndSynthesizeMemory } from '../agents/conversationMemoryAgent';

type AuditDecision = 'PASS' | 'BLOCK' | 'HUMAN_REVIEW_REQUIRED';

/**
 * P0.11 — Placeholder for the independent audit, returning a SAFE decision rather than a
 * fabricated one.
 *
 * When auditReplyAgainstPlan() is wired to real ReplyPlan / ClientIdentityResolution /
 * EmailUnderstanding inputs, this becomes a call to it and the branching at the call site
 * starts doing real work. Until then it returns HUMAN_REVIEW_REQUIRED, so drafts are held
 * rather than sent on the strength of a verdict nobody computed.
 *
 * The explicit return type matters: it stops TypeScript narrowing the result to a single
 * literal and reporting the caller's PASS/BLOCK branches as unreachable, which would invite
 * someone to delete them.
 */
function runIndependentAudit(): { decision: AuditDecision; reason: string } {
  return {
    decision: 'HUMAN_REVIEW_REQUIRED',
    reason:
      'Independent auditor not yet wired to real ReplyPlan/identity inputs; routing to human ' +
      'review rather than asserting a PASS that was never computed.',
  };
}

export class InboundPipeline {
  async processNewEmail(email: GmailMessage, organizationId: string) {
    try {
      // P1.1 — This argument was accepted and then dropped: nothing downstream used it, so
      // every inbound message was processed, stored and replied to under one implied tenant.
      // It is now threaded through the whole pipeline, and it is validated here because it
      // arrives from an oauth_connections record — a collection that is world-writable until
      // firestore.rules is closed (P0.0) — and ends up in datastore paths.
      if (!isValidOrgId(organizationId)) {
        console.error(
          '[InboundPipeline] Refusing to process a message with no valid organisation id. ' +
            'An unattributable message is not processed under a default tenant.'
        );
        return;
      }

      const startTime = Date.now();
      const budgetTracker = new BudgetTracker();
      budgetTracker.recordStep();
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
      let conversationId = identity.contactId; // hack
      if (!conversationId) {
        const newConvId = `conv_${Date.now()}`;
        await db.insert(conversations).values({
           id: newConvId,
           organizationId,
           contactId: identity.contactId,
           accountId: (identity as any).accountId || null,
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

      // P0.12 — Record that the conversation has advanced, atomically, as part of ingesting
      // this message. Every draft generated from here on is stamped with this version, and
      // the worker refuses to send any draft whose stamp no longer matches. This must happen
      // AFTER the message is persisted and BEFORE any draft is composed, or a draft could be
      // stamped with a version that does not include the message it is replying to.
      const inboundVersion = await incrementInboundVersion(organizationId, conversationId);
      console.log(`[InboundPipeline] conversation ${conversationId} -> inbound version ${inboundVersion}`);

      // 4. Update Conversation Memory
      const convMsgs = await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.receivedAt);

      const convData = {
         id: conversationId,
         contactName: (identity as any).matchedLeadId || email.from, // simplified
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
      for (const fact of (memory as any).facts) {
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
      const nbaResult = determineNextBestAction(understanding, BuyingStage.DISCOVERY, {} as any, {} as any);

      // 7. Compose Reply if needed
      if (nbaResult.action === 'DO_NOTHING' as any || nbaResult.action === 'SUPPRESS_NO_ACTION' as any) {
         console.log("NBA determined no reply is needed:", nbaResult.action);
         return;
      }

      budgetTracker.recordModelCall(500, 0.01); // Mock cost
      const draft = await composeAutonomousSalesReply({ incomingEmail: email.textBody, latestIntent: understanding.primaryIntent, buyingStage: BuyingStage.DISCOVERY, nextBestAction: nbaResult, prospectName: email.from } as any);

      // 8. Independent Audit
      //
      // P0.11 — This line was `const auditResult = { decision: 'PASS', reason: '' };`. That
      // single hardcoded value disabled THREE controls at once, because suppression checking,
      // claim grounding and the circuit breaker all sit behind auditReplyAgainstPlan(): every
      // draft passed, unconditionally, no matter what it contained.
      //
      // The real auditor needs a ReplyPlan, a resolved ClientIdentityResolution and the full
      // EmailUnderstanding. This pipeline does not build them yet — note the `{} as any`
      // arguments passed to determineNextBestAction above — so the auditor cannot be invoked
      // faithfully here without that plumbing.
      //
      // Given that, the choice is between inventing a verdict and admitting we do not have
      // one. Addendum §14 and §23 are explicit: when required information is absent, apply a
      // safe policy rather than fabricating it. So an un-runnable audit now routes the draft
      // to HUMAN_REVIEW instead of asserting PASS. The effect is that autonomous replies stop
      // until the auditor is properly wired — which is the correct failure direction, and
      // visible, rather than a silent bypass that looks like a working control.
      const { decision: auditDecision, reason: auditReason } = runIndependentAudit();
      console.warn(`[InboundPipeline] audit -> ${auditDecision}: ${auditReason}`);

      if (auditDecision === 'BLOCK') {
         console.error("Draft blocked by auditor:", auditReason);
         return;
      }

      // 9. Transactional Outbox Insert
      //
      // P0.7 — This wrote to the POSTGRES `outboxMessages` table while outbox.worker.ts polls
      // the FIRESTORE queue, so nothing produced here was ever consumed: the Firestore queue
      // had no reachable producer and always returned empty. Both sides now use the same
      // store, through outboxService, which is also where the idempotency key and the
      // claim/lease fields live.
      const outboxStatus = auditDecision === 'PASS' ? 'PENDING' : 'HUMAN_REVIEW';

      // P0.12 — Stamp the draft with the conversation version it was generated from, plus a
      // digest of exactly what would be sent. The worker re-checks both immediately before
      // dispatch, so a message that arrives between now and then invalidates this draft
      // rather than being silently overtaken.
      //
      // `inboundVersion` was incremented above when this message was recorded, so it is the
      // version this draft genuinely reflects.
      const outboundPayload = {
        to: email.from,
        subject: draft.subject,
        htmlBody: draft.body,
        inReplyTo: email.id,
        references: email.references ? `${email.references} ${email.id}` : email.id,
        threadId: email.threadId,
      };

      const approvalDigest = computeApprovalDigest({
        organizationId,
        to: outboundPayload.to,
        subject: outboundPayload.subject,
        htmlBody: outboundPayload.htmlBody,
        conversationId,
        inboundVersion,
      });

      const queued = await outboxService.queueMessage(
        organizationId,
        conversationId,
        outboundPayload,
        `reply_${email.id}`,
        { generatedForInboundVersion: inboundVersion, approvalDigest }
      );

      // queueMessage defaults new rows to PENDING; anything not cleared by the auditor must
      // be held for a human instead.
      if (queued && outboxStatus !== 'PENDING') {
        await outboxService.holdForHumanReview(organizationId, queued.id, auditReason);
      }

      console.log(`--- Pipeline Completed. Outbox job created: ${outboxStatus} ---`);
      MetricsService.getInstance().recordLatency("INBOUND_PROCESSING", Date.now() - startTime);

    } catch (e) {
      console.error("Error in inbound pipeline:", e);
    }
  }
}

export const inboundPipeline = new InboundPipeline();
