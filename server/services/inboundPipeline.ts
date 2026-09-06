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
import { referencedMessageIds, resolveThread, type ThreadCandidate } from '../domain/threadResolution';
import { inArray } from 'drizzle-orm';
import {
  evaluateEmailUnderstandingRuleBased,
  determineNextBestAction,
  composeAutonomousSalesReply,
  UNASSESSED_PURCHASE_READINESS,
  UNASSESSED_MEETING_READINESS,
} from '../agents/salesDecisionEngine';
import { extractAndSynthesizeMemory } from '../agents/conversationMemoryAgent';
import { recordFacts, listActiveFacts } from '../lib/factStore';
import { observationsFromMemory } from '../domain/memoryFacts';

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
  /**
   * P1.5 — Find the conversation this message belongs to, or start one.
   *
   * The decision itself is in domain/threadResolution, which is pure and therefore testable
   * against the case that matters: a candidate found by a header the SENDER controls. This
   * method does the lookups and the write.
   *
   * The order is deliberate. The provider's own thread id is tried first because Gmail
   * computed it server-side from the whole message; the reply headers are tried second
   * because anyone can set them. Both are confirmed against the tenant and the contact before
   * anything is appended — an unconfirmed match would let a stranger's email join a customer's
   * thread, and the composer would then draft using that thread's history (§18).
   */
  private async resolveConversation(
    email: GmailMessage,
    organizationId: string,
    contactId: string
  ): Promise<string> {
    const signals = {
      organizationId,
      contactId,
      providerThreadId: email.threadId,
      inReplyTo: email.inReplyTo,
      references: email.references,
    };

    let byProviderThread: ThreadCandidate | null = null;
    if (typeof email.threadId === 'string' && email.threadId.length > 0) {
      const rows = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            eq(conversations.providerThreadId, email.threadId)
          )
        )
        .limit(1);
      if (rows.length > 0) {
        byProviderThread = {
          conversationId: rows[0].id,
          organizationId: rows[0].organizationId,
          contactId: rows[0].contactId,
          providerThreadId: rows[0].providerThreadId,
        };
      }
    }

    // The referenced Message-IDs, bounded by the parser because the sender chooses how many
    // arrive. Looked up in one query rather than one per id.
    const byReference: ThreadCandidate[] = [];
    const referenced = referencedMessageIds(signals);
    if (byProviderThread === null && referenced.length > 0) {
      const parents = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, organizationId),
            inArray(messages.providerMessageId, referenced)
          )
        );

      // Preserve the parser's ordering — nearest ancestry first — rather than whatever order
      // the datastore returned.
      const byMessageId = new Map(parents.map((m) => [m.providerMessageId, m]));
      const conversationIds = referenced
        .map((id) => byMessageId.get(id)?.conversationId)
        .filter((id): id is string => typeof id === 'string');

      if (conversationIds.length > 0) {
        const rows = await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.organizationId, organizationId),
              inArray(conversations.id, conversationIds)
            )
          );
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const id of conversationIds) {
          const row = byId.get(id);
          if (row) {
            byReference.push({
              conversationId: row.id,
              organizationId: row.organizationId,
              contactId: row.contactId,
              providerThreadId: row.providerThreadId,
            });
          }
        }
      }
    }

    const resolution = resolveThread(signals, { byProviderThread, byReference });

    if (resolution.kind === 'EXISTING') {
      console.log(
        `[InboundPipeline] message ${email.id} joins conversation ${resolution.conversationId} ` +
          `(${resolution.method}, confidence ${resolution.confidence}).`
      );
      return resolution.conversationId;
    }

    // A rejected candidate is logged rather than silently dropped: a mismatch here is either a
    // bug in our threading or somebody probing it, and both are worth seeing.
    if (resolution.rejected) {
      console.warn(
        `[InboundPipeline] REFUSED to append message ${email.id} to conversation ` +
          `${resolution.rejected.conversationId}: it ${resolution.rejected.why}. ` +
          `Starting a new thread instead.`
      );
    }

    const newConversationId = `conv_${uuidv4()}`;
    await db.insert(conversations).values({
      id: newConversationId,
      organizationId,
      contactId,
      status: 'NEW',
      category: 'CUSTOMER',
      providerThreadId: email.threadId ?? null,
      subject: email.subject,
    });
    console.log(
      `[InboundPipeline] Started conversation ${newConversationId} for message ${email.id}: ` +
        resolution.reason
    );
    return newConversationId;
  }

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

      // 2. Which conversation does this message belong to?
      //
      // P1.5 — This was `let conversationId = identity.contactId; // hack`, followed by an
      // `if (!conversationId)` that the guard above makes unreachable. So no conversation
      // row has ever been written, and every message was stored with a CONTACT id in a
      // column whose foreign key points at `conversations`.
      //
      // Behaviourally the cost is larger than the broken key: keying a conversation by WHO
      // someone is means every thread with that person is one transcript, and that
      // transcript is what the reply composer reads as context. `providerThreadId`,
      // `inReplyTo` and `references` were captured into columns and never consulted.
      const contactId = identity.contactId;
      const conversationId = await this.resolveConversation(email, organizationId, contactId);

      // 3. Store the Message in DB
      const messageId = `msg_${Date.now()}`;
      await db.insert(messages).values({
        id: messageId,
        organizationId,
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
      const convMsgs = await db
        .select()
        .from(messages)
        .where(
          and(eq(messages.organizationId, organizationId), eq(messages.conversationId, conversationId))
        )
        .orderBy(messages.receivedAt);

      const convData = {
         id: conversationId,
         // P1.5 — This was `(identity as any).matchedLeadId`, which is a contact ID, not a
         // name. It is interpolated into the conversation-memory prompt, so the model has
         // been reading a database key as the customer's name. The `as any` is why the
         // compiler never mentioned that the field does not exist on the declared type.
         contactName: identity.name || email.from,
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

      // P1.6 — Record what this message told us, WITHOUT destroying what we already knew.
      //
      // This was a hard DELETE of every fact for the conversation, followed by a loop over
      // `(memory as any).facts` — a member `ConversationMemory` does not have. So the loop
      // threw on `undefined` AFTER the delete had already run: an inbound message erased the
      // conversation history and wrote nothing back. Every provenance column was left unset,
      // and it all executed against the throwing Drizzle proxy in any case.
      //
      // Facts are now superseded rather than replaced. A repeated value is a CONFIRMATION
      // (the customer said the same thing again), a changed value CLOSES the old fact with a
      // `validUntil` and opens a new one. "Their budget was 5k, then 15k" and "their budget
      // is 15k" are different claims and only the first can be audited.
      //
      // Every observation names the message it came from, and every one derived from the
      // model reading a customer email is marked AGENT_SYNTHESIS — the LOWEST authority tier.
      // That label is load-bearing: these facts re-enter later prompts, and without a tier a
      // model’s summary of a stranger’s email would rank alongside something an operator
      // entered, which is how one injected sentence becomes a durable instruction (§18).
      const observations = observationsFromMemory(memory, messageId);
      const factOutcome = await recordFacts(organizationId, conversationId, observations);
      if (factOutcome.rejected.length > 0) {
        // Logged rather than thrown: a malformed fact from a model is routine, and it must
        // not discard the well-formed ones alongside it.
        console.warn(
          `[InboundPipeline] ${factOutcome.rejected.length} observation(s) rejected for ` +
            `conversation ${conversationId}:`,
          factOutcome.rejected
        );
      }
      console.log(
        `[InboundPipeline] recorded ${factOutcome.recorded} fact observation(s) for ` +
          `conversation ${conversationId}.`
      );


      // 5. Email Understanding & Intent
      const understanding = evaluateEmailUnderstandingRuleBased(email.textBody || email.htmlBody);

      // 6. Next Best Action (NBA)
      // The two `{} as any` arguments here read as placeholders and behaved as ones: neither
      // throws, so `purchaseReadiness.score >= 85` was `undefined >= 85` (false) and
      // `meetingReadiness.shouldOfferBooking` was `undefined` (falsy). Two branches of the
      // decision engine could never fire, silently. Named constants keep the same safe
      // behaviour and make it legible.
      const nbaResult = determineNextBestAction(
        understanding,
        BuyingStage.DISCOVERY,
        UNASSESSED_PURCHASE_READINESS,
        UNASSESSED_MEETING_READINESS
      );

      // 7. Compose Reply if needed
      if (nbaResult.action === 'DO_NOTHING' as any || nbaResult.action === 'SUPPRESS_NO_ACTION' as any) {
         console.log("NBA determined no reply is needed:", nbaResult.action);
         return;
      }

      budgetTracker.recordModelCall(500, 0.01); // Mock cost

      // P1.6/P1.8 — facts recorded earlier in THIS pipeline are now read back and given to
      // the planner. Until now nothing called `listActiveFacts`: facts were written on every
      // inbound message and never read by anything, so the conversation history the system
      // was carefully maintaining reached no prompt. Superseded facts are excluded by
      // `activeFacts` (§20), so a value the customer has since corrected cannot come back as
      // current.
      let knownRelevantFacts: string[] = [];
      try {
        const active = await listActiveFacts(organizationId, conversationId);
        knownRelevantFacts = active.map((f) => `${f.key}: ${f.value}`);
        console.log(
          `[InboundPipeline] ${knownRelevantFacts.length} active fact(s) supplied to the planner ` +
            `for conversation ${conversationId}.`
        );
      } catch (e: any) {
        // Recorded, not swallowed. An empty fact list and an unreadable fact store are
        // different states, and only one of them means "we know of nothing" (§14).
        console.error(
          `[InboundPipeline] Could not read facts for conversation ${conversationId}; the ` +
            `planner will run without them:`,
          e?.message ?? e
        );
      }

      // P1.8 remainder — the call that has never once produced a draft.
      //
      // It was:
      //
      //     composeAutonomousSalesReply({ incomingEmail: email.textBody,
      //       latestIntent: understanding.primaryIntent, buyingStage: BuyingStage.DISCOVERY,
      //       nextBestAction: nbaResult, prospectName: email.from } as any)
      //
      // The signature requires `identity`, `emailUnderstanding` and `rawInboundText`. Four of
      // the six fields were passed under names the function does not read, and `as any`
      // stopped the compiler saying so. At runtime `input.identity` was `undefined` and the
      // first unconditional use of it threw:
      //
      //     TypeError: Cannot read properties of undefined (reading 'contactId')
      //
      // measured by calling the function with this exact argument object. The enclosing
      // handler is `catch (e) { console.error(...) }`, so every inbound email reached here,
      // threw, was logged to stdout and the pipeline returned as though it had worked. No
      // draft, no outbox job, no alert.
      //
      // The correctly resolved `identity` was already in scope ~130 lines above. The cast is
      // gone, so the compiler now checks this call.
      const draft = await composeAutonomousSalesReply({
        organizationId,
        identity,
        emailUnderstanding: understanding,
        nextBestAction: nbaResult,
        buyingStage: BuyingStage.DISCOVERY,
        rawInboundText: email.textBody || email.htmlBody || '',
        knownRelevantFacts,
      });

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
