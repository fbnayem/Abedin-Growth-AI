import { db } from '../db/index';
import { conversations, messages, contacts, accounts } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { emailUnderstandingAgent } from '../agents/emailUnderstanding.agent';
import { buyingStageService } from './buyingStage.service';
import { nextBestActionService } from './nextBestAction.service';
import { replyComposerAgent } from '../agents/replyComposer.agent';
import { outboxService } from './outbox.service';
import { suppressionService } from './suppression.service';
import { technicalAgent } from '../agents/technical.agent';
import { BuyingStage, NextBestAction } from '../domain/models';
import { auditReplyAgainstPlan } from '../agents/independentAuditor'; // We might need to refactor its imports

export class PipelineService {
  async processInboundMessage(rawMessage: any) {
    const { fromEmail, fromName, subject, textBody, providerMessageId, threadId, orgId } = rawMessage;

    // 1. Identity Resolution
    // (mock implementation for brevity, should use IdentityResolverService)
    let contactId = "mock_contact_id";
    let accountId = "mock_account_id";

    // 2. Load Conversation
    let conversationId = "mock_conversation_id";
    let currentBuyingStage = BuyingStage.NEW;

    // 3. Suppression check
    const isSuppressed = await suppressionService.checkSuppression(fromEmail);

    // 4. Email Understanding
    const previousContext = "Prior emails...";
    const understanding = await emailUnderstandingAgent.analyze(textBody, previousContext);

    // Update Suppression if Unsubscribe intent
    if (understanding.unsubscribeIntent) {
      await suppressionService.processUnsubscribe(fromEmail);
    }

    // 5. Buying Stage Update
    const nextStage = buyingStageService.calculateNextStage(currentBuyingStage, understanding.primaryIntent, understanding.purchaseIntent ? 100 : 0, understanding.meetingRequest ? 100 : 0);

    // 6. Next Best Action
    const action = nextBestActionService.determineAction({
      intent: understanding.primaryIntent,
      buyingStage: nextStage,
      meetingReadiness: understanding.meetingRequest ? 100 : 0,
      purchaseReadiness: understanding.purchaseIntent ? 100 : 0,
      unansweredQuestions: understanding.explicitQuestions,
      category: 'CUSTOMER',
      isUnsubscribed: isSuppressed || understanding.unsubscribeIntent,
      isOutOfOffice: false
    });

    if (action === NextBestAction.SUPPRESS || action === NextBestAction.NO_REPLY || action === NextBestAction.CLOSE_LOST) {
      console.log(`Action is ${action}. Halting reply generation.`);
      return;
    }

    // 7. Specialist Knowledge Gathering
    let specialistKnowledge = "";
    if (action === NextBestAction.PROVIDE_TECHNICAL_INFORMATION || understanding.explicitQuestions.length > 0) {
      specialistKnowledge = await technicalAgent.getAnswer(understanding.explicitQuestions.join(", "));
    }

    // 8. Reply Composer
    const draft = await replyComposerAgent.compose({
      conversationContext: previousContext,
      latestEmail: textBody,
      understanding,
      nextBestAction: action,
      buyingStage: nextStage,
      specialistKnowledge,
      toneProfile: "Direct, professional, warm, concise.",
      senderName: "Nayem",
      senderEmail: "info@abedintech.com"
    });

    // 9. Auditor (stubbed for now to fit new types)
    // const audit = auditReplyAgainstPlan({ ... })
    // if (audit.decision === 'BLOCK') return;

    // 10. Transactional Outbox Queue
    const idempotencyKey = `outbound_${providerMessageId}_${Date.now()}`;
    await outboxService.queueMessage(conversationId, {
      to: fromEmail,
      subject: draft.subject,
      htmlBody: draft.bodyHtml,
      textBody: draft.bodyText,
      inReplyTo: providerMessageId,
      threadId: threadId,
    }, idempotencyKey);

    console.log(`Successfully processed inbound message and queued reply for ${fromEmail}`);
  }
}

export const pipelineService = new PipelineService();
