import { BudgetTracker, ledgerChargeFor } from '../policies/workflowBudgets';
import { costOfCall } from '../policies/modelPricing';
import { tenantSpendGate, recordTenantSpend } from './tenantSpend.service';
import { withModelCallCollector, type ModelCallRecord } from '../lib/modelCallLog';
import { runLogFieldsFor, writeRunLog } from '../lib/runLog';
import { buildContextBundle, type ContextKind } from '../domain/contextBundle';
import { adaptLedgers } from '../domain/ledgerAdapters';
import { metricsService } from './metrics.service';
import { LedgerService } from './ledgers.service';
import { BuyingStage, suppressesReply } from "../../shared/domain/models";
import { db } from '../db/index';
import { messages, conversations, contacts, accounts, conversationFacts } from '../db/schema';
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
import { classifyAutomation, type AutomationVerdict } from '../domain/automatedMail';
import { attachmentVerdict, attachmentsPermitAutonomy } from '../domain/attachmentPolicy';
import { describeAbstention } from '../domain/abstention';
import { auditReplyAgainstPlan } from '../agents/independentAuditor';
import { dispositionFor } from '../domain/adjudication';
import { store } from '../store';
import { collection, doc, getDocs, query, updateDoc, where } from '../store';
import { orgPath } from '../tenancy/orgScope';

const ledgerService = new LedgerService();

/**
 * What processing one inbound message actually did.
 *
 * `ok: true` means the pipeline reached a decision it stands behind — including deciding NOT to
 * reply. `ok: false` means it did not finish, and the message has not been dealt with.
 *
 * The distinction is the point. Before this, `processNewEmail` returned `void`, so "suppressed
 * because the customer asked to unsubscribe" and "threw a TypeError on line 400" were the same
 * value, and every layer above reported success for both.
 */
export type InboundOutcome =
  | {
      ok: true;
      /**
       * S28 — AUTOMATED is distinct from SUPPRESSED on purpose. A suppressed message is one
       * the planner decided not to answer; an automated one was never eligible to be
       * answered, and no model was asked about it. Collapsing the two would hide the fact
       * that a bounce loop is running.
       */
      disposition: 'QUEUED' | 'SUPPRESSED' | 'BLOCKED' | 'AUTOMATED' | 'ABSTAINED';
      detail: string;
      modelCalls: ModelCallRecord[];
      conversationId?: string | null;
      messageId?: string | null;
      /** §21 — the manifest of what the model was shown, for the run log. */
      contextHash?: string | null;
      contextIds?: string[];
    }
  | {
      ok: false;
      /** Where it stopped, so a failure is triageable without reading a stack trace. */
      stage: 'TENANT' | 'IDENTITY' | 'BUDGET' | 'UNHANDLED';
      detail: string;
      modelCalls?: ModelCallRecord[];
      conversationId?: string | null;
      messageId?: string | null;
      contextHash?: string | null;
      contextIds?: string[];
    };

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

  /**
   * Process one inbound message, and SAY WHAT HAPPENED.
   *
   * This returned `void` and ended in `catch (e) { console.error(...); }`. Every failure on the
   * path — the throwing Drizzle proxy, a TypeError in the composer, a BUDGET_EXCEEDED throw —
   * terminated it identically and silently: the caller awaited a promise that resolved
   * normally, the webhook's `.catch` never fired, and Google was answered 200 OK. **A dropped
   * customer email was reported as success at every layer above.**
   *
   * A void return cannot distinguish "suppressed on purpose" from "threw on line 400", so the
   * outcome is now a value. The method still does not throw — an inbound webhook that 500s
   * invites a redelivery storm — but the failure is in the return type where a caller must look
   * at it (§2, §14).
   */
  async processNewEmail(email: GmailMessage, organizationId: string): Promise<InboundOutcome> {
    const budgetTracker = new BudgetTracker();
    const modelCalls: ModelCallRecord[] = [];

    const startedAt = Date.now();

    const outcome = await withModelCallCollector(
      {
        record: (call) => {
          modelCalls.push(call);
          // From the provider, not a literal. `null` stays null all the way into the tracker:
          // an unmeasured call is unmeasured, not free.
          //
          // This CAN throw BUDGET_EXCEEDED, deliberately: a ceiling that only reports after
          // the work is finished is not a ceiling. The throw surfaces inside the pipeline and
          // is caught below as a failure outcome, which is where it belongs.
          // S37 — priced here, from the provider's table, on the record the provider produced.
          // An unpriced call is partial at the reply and charged the ceiling in the ledger.
          const cost = costOfCall(call);
          budgetTracker.recordModelCall(call.totalTokens, cost.costMinor, cost.upperBound);
        },
      },
      () => this.runPipeline(email, organizationId, budgetTracker, modelCalls)
    );

    // §21 — ONE run log per run, written HERE rather than at each `return` inside the pipeline.
    //
    // There are five exit paths and a catch. Writing the log at each of them would mean six
    // chances to forget one, and the path most worth recording — the failure — is the one a
    // person adding a sixth exit is least likely to think about. Wrapping the call means every
    // path is covered by construction, including ones added later.
    //
    // Nothing wrote one of these before: `/api/logs` read a collection with no producer, and
    // the PostgreSQL table with the right columns had never had a row inserted.
    const spend = budgetTracker.snapshot();
    if (isValidOrgId(organizationId)) {
      // The status mapping lives in runLog.ts as a pure function, not inline here. As four
      // lines in this method it was untestable, and mutating it to record a FAILED run as
      // SUCCESS survived the entire suite.
      const { status, disposition, summary, stage } = runLogFieldsFor(outcome);

      await writeRunLog({
        organizationId,
        agentType: 'InboundPipeline',
        actionType: 'AUTONOMOUS_REPLY',
        status,
        disposition,
        // `detail` is system-generated prose in every branch — an action name, an audit reason,
        // an error message. The customer's words never reach it (§18).
        summary,
        stage,
        conversationId: outcome.conversationId ?? null,
        messageId: outcome.messageId ?? email?.id ?? null,
        contextHash: outcome.contextHash ?? null,
        contextIds: outcome.contextIds ?? null,
        durationMs: Date.now() - startedAt,
        modelCalls,
        budget: spend,
        now: new Date().toISOString(),
      });

      // S37 — the tenant ledger, from the same snapshot the run log carries, in one transaction
      // per run. Only runs that called a model are charged; a bounce classified without one
      // spends nothing and writes nothing. A failed write is loud and remembered: the gate
      // refuses further model calls in this process until a write succeeds.
      if (spend.modelCalls > 0) {
        const recorded = await recordTenantSpend(organizationId, ledgerChargeFor(spend));
        if (recorded.ok === false) {
          console.error(`[InboundPipeline] ${email?.id ?? 'unknown'}: ${recorded.reason}`);
        }
      }
    } else {
      // Refusing rather than writing under a default tenant: a run log is tenant-scoped data,
      // and an unattributable one would be filed under somebody (§1).
      console.error(
        '[InboundPipeline] Run NOT logged: no valid organisation id, so there is no tenant to ' +
          'file it under. The refusal to process is recorded in the returned outcome.'
      );
    }

    return outcome;
  }

  /**
   * S28/S26 — a permanent bounce suppresses the recipient.
   *
   * `hardBounced` is one of five flags the ActionGateway already reads before every send
   * (`executeEmailSend`), and until now NOTHING WROTE ANY OF THEM. A read with no writer is
   * a control that cannot fire: the gateway has been checking a field that was always
   * undefined, and reporting "not suppressed" every time.
   *
   * Only a PERMANENT failure suppresses. A 4.x.x is a temporary condition — a full mailbox,
   * a greylisting delay — and treating it as permanent would silently retire a live
   * customer over a transient server state.
   *
   * This never throws. A suppression write that fails must not abort the pipeline, but it
   * must be loud: the alternative is a bounce loop nobody can see.
   */
  private async applyBounceSuppression(
    organizationId: string,
    contactId: string,
    automation: AutomationVerdict
  ): Promise<void> {
    if (automation.permanentFailure !== true) return;
    if (!store) {
      console.error(
        '[InboundPipeline] PERMANENT BOUNCE but the datastore is unavailable, so the ' +
          `recipient could NOT be suppressed (contact ${contactId}, ` +
          `status ${automation.dsnStatus ?? 'unknown'}). This address will be mailed again.`
      );
      return;
    }
    try {
      await updateDoc(doc(store, orgPath(organizationId, 'contacts'), contactId), {
        hardBounced: true,
        emailStatus: 'BOUNCED',
        hardBouncedAt: new Date(),
        hardBounceReason: `${automation.dsnStatus ?? 'unknown'}: ${automation.reason}`,
      });
      console.warn(
        `[InboundPipeline] Contact ${contactId} suppressed after a permanent delivery ` +
          `failure (${automation.dsnStatus ?? 'no status'}` +
          `${automation.failedRecipient === null ? '' : `, ${automation.failedRecipient}`}).`
      );
    } catch (e) {
      console.error(
        '[InboundPipeline] FAILED to suppress a hard-bounced recipient. The gateway will ' +
          `keep sending to contact ${contactId}.`,
        e
      );
    }
  }

  private async runPipeline(
    email: GmailMessage,
    organizationId: string,
    budgetTracker: BudgetTracker,
    modelCalls: ModelCallRecord[]
  ): Promise<InboundOutcome> {
    // Outside the try, so the finally can read it. It also starts the clock earlier, which is
    // correct: time spent failing tenant resolution or classification is still time the
    // customer waited, and a measurement that begins after the risky part is a measurement of
    // the safe part.
    const startTime = Date.now();
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
        return { ok: false, stage: 'TENANT', detail: 'No valid organisation id on the message.' };
      }

      // S28 — what kind of message is this, before anything is spent on it.
      //
      // Nothing classified inbound mail at all: `automationClassification` was a column
      // with no writer, and the only bounce-address check in the repository lived inside
      // `isSuppressed`, whose sole caller is the independent auditor — which is stubbed to
      // a constant on this path. A mailer-daemon delivery failure therefore ran the entire
      // pipeline and was answered as though the prospect had written it.
      //
      // The verdict is computed here, from headers and MIME structure only, so it is
      // available to the message record. The REFUSAL happens after the message is stored:
      // a bounce is evidence and must be kept, it just must not be replied to.
      const automation = classifyAutomation({ headers: email.headers, body: email.parsed });

      // S17 — WHAT IS ATTACHED DECIDES WHETHER THIS MAY BE ANSWERED WITHOUT A PERSON.
      //
      // The walk records attachments (§1t) and nothing read them. An executable on an inbound
      // sales email is not a document to compose a reply about, and a filename carrying a
      // direction override is one chosen to be misread.
      //
      // This does NOT drop the message and does not stop the pipeline: the message is stored
      // either way, because it is evidence. It forces the resulting draft to HUMAN_REVIEW.
      const attachments = attachmentVerdict(
        email.parsed.attachments,
        email.parsed.attachmentCount
      );
      if (attachmentsPermitAutonomy(attachments.disposition) === false) {
        console.warn(`[InboundPipeline] ${email.id}: ${attachments.reason}`);
      }

      const budgetTracker = new BudgetTracker();
      budgetTracker.recordStep();
      console.log(`--- Starting Inbound Pipeline for message: ${email.id} ---`);

      // 1. Identity Resolution
      const identityService = new IdentityResolverService();
      const identity = await identityService.resolve(email.from, organizationId);

      if (!identity.contactId) {
        console.log("Could not resolve contact. Dropping message or creating lead.");
        // In real system, create new lead or route to unknown queue
        return { ok: false, stage: 'IDENTITY', detail: 'Could not resolve the sender to a contact.' };
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
        // S16/S35 — renamed. The column was called `sanitizedHtmlBody` and held provider
        // HTML that nothing had sanitized: a name asserting a property no code provided.
        rawHtmlBody: email.untrustedHtmlBody,
        // The TEXT rendering, which is what anything that reads the content should use.
        htmlAsText: email.htmlAsText,
        // S28 — the column that had no writer.
        automationClassification: automation.classification,
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

      // S28 — the gate. Placed here, before the first model call, because the cheapest
      // thing to do with a bounce is nothing, and the most expensive is to reason about it.
      if (automation.replyPermitted === false) {
        console.warn(
          `[InboundPipeline] ${automation.classification} from ${email.from}: ${automation.reason} ` +
            `Signals: ${automation.signals.join('; ') || 'none'}`
        );
        await this.applyBounceSuppression(organizationId, contactId, automation);
        return {
          ok: true,
          disposition: 'AUTOMATED',
          detail: `${automation.classification}: ${automation.reason}`,
          modelCalls,
          conversationId,
          messageId,
        };
      }

      // S37 — THE TENANT'S SPEND, BEFORE THE FIRST MODEL CALL.
      //
      // Here and not at the top: the steps above touch no model, and a tenant over budget must
      // still have its inbound mail stored and threaded — a refusal to spend is not a refusal
      // to listen. Everything from here on can spend. The gate fails closed when the ledger
      // cannot be read, and while a spend write in this process has failed and not since
      // succeeded (see tenantSpend.service.ts).
      const spendGate = await tenantSpendGate(organizationId);
      if (spendGate.allowed === false) {
        console.error(`[InboundPipeline] ${email.id}: refusing to call a model. ${spendGate.reason}`);
        return {
          ok: false,
          stage: 'BUDGET',
          detail: spendGate.reason,
          modelCalls,
          conversationId,
          messageId: email.id,
        };
      }

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
           // The TEXT rendering first: `rawHtmlBody` is provider markup, and handing it
           // to the model as "what the customer said" is how tag names end up quoted
           // back at a prospect.
           bodyText: m.textBody || m.htmlAsText || "",
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
      //
      // `onRejected` is passed rather than omitted: the returned array alone cannot tell "the
      // model extracted nothing" from "the model extracted two contradictory readings of one
      // key and we declined to invent a supersession between them".
      // S23 — an abstention records NOTHING.
      //
      // These observations become durable facts with provenance pointing at a real customer
      // message, and every later prompt reads them back as things the customer said. A fact
      // derived from a memory no model produced has a source that does not exist.
      if (memory.abstention !== undefined) {
        console.warn(
          `[InboundPipeline] memory extraction abstained (${memory.abstention.reason}); ` +
            `recording no facts for message ${messageId}. ${memory.abstention.detail}`
        );
      }
      const observations =
        memory.abstention !== undefined
          ? []
          : observationsFromMemory(memory, messageId, {
              onRejected: (r) =>
                console.warn(
                  `[InboundPipeline] dropped extracted key '${r.key}' (raw: ${r.rawKeys.join(', ')}) ` +
                    `for conversation ${conversationId}: ${r.reason}`
                ),
            });
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
      // Was `email.textBody || email.htmlBody`, so an HTML-only email ran the
      // out-of-office and unsubscribe substring checks against MARKUP — matching tag
      // names and attribute values rather than anything the sender wrote.
      const understanding = evaluateEmailUnderstandingRuleBased(email.textBody || email.htmlAsText);

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
      //
      // This was:
      //
      //     if (nbaResult.action === 'DO_NOTHING' as any || nbaResult.action === 'SUPPRESS_NO_ACTION' as any)
      //
      // Neither literal is a member of NextBestActionType, and the two casts are the only
      // reason the compiler did not say so. The guard was dead. Measured by running the
      // decision engine over real inputs:
      //
      //     unsubscribe     isUnsub=true   action=SUPPRESS   guard fires? NO
      //     out of office   isOOO=true     action=NO_REPLY   guard fires? NO
      //
      // So a prospect who asked to be removed from the list was sent a drafted sales reply,
      // and an out-of-office autoresponder was answered as though a human had written it.
      // `suppressesReply` is exhaustive over the union and fails closed on anything it does
      // not recognise, because sending is the permission (§14).
      if (suppressesReply(nbaResult.action)) {
         console.log(`[InboundPipeline] Suppressed: action=${nbaResult.action} — ${nbaResult.reason}`);
         return { ok: true, disposition: 'SUPPRESSED', detail: `${nbaResult.action}: ${nbaResult.reason}`, modelCalls, conversationId, messageId };
      }

      // The line that stood here was:
      //
      //     budgetTracker.recordModelCall(500, 0.01); // Mock cost
      //
      // A constant token count and a constant cost, recorded BEFORE the call, charged even when
      // the call failed or returned fallbackData — while the two real model calls on this path
      // were never recorded at all. Three calls at a fabricated 500 tokens cannot reach an
      // 8000-token ceiling, so no amount of real spending could trip the budget. Usage is now
      // reported by the client that makes the call, through the collector opened around this
      // whole method, and calls the provider says nothing about count as UNMEASURED, not zero.

      // P1.6/P1.8 — facts recorded earlier in THIS pipeline are now read back and given to
      // the planner. Until now nothing called `listActiveFacts`: facts were written on every
      // inbound message and never read by anything, so the conversation history the system
      // was carefully maintaining reached no prompt. Superseded facts are excluded by
      // `activeFacts` (§20), so a value the customer has since corrected cannot come back as
      // current.
      //
      // S21 — every source is loaded into the SAME bundle, and a source that could not be read
      // is named. Three of the five live in PostgreSQL, which this deployment cannot reach, so
      // "no open questions" and "the open-questions table threw" would otherwise be the same
      // empty array reaching the same prompt (§14).
      const unavailable: ContextKind[] = [];
      const noteUnavailable = (kind: ContextKind, what: string, e: unknown) => {
        unavailable.push(kind);
        console.error(
          `[InboundPipeline] ${what} could not be read for conversation ${conversationId}; ` +
            'recorded as UNAVAILABLE rather than as empty:',
          e instanceof Error ? e.message : e
        );
      };

      let activeFactRecords: Awaited<ReturnType<typeof listActiveFacts>> = [];
      try {
        activeFactRecords = await listActiveFacts(organizationId, conversationId);
        console.log(
          `[InboundPipeline] ${activeFactRecords.length} active fact(s) selected for ` +
            `conversation ${conversationId}.`
        );
      } catch (e: any) {
        noteUnavailable('FACT', 'the fact store', e);
      }

      // Raw rows in, adapted records out. `adaptLedgers` had ZERO callers: it exists because
      // the tables name their columns `questionText` and `statement` while the bundle needs
      // `question` and `objection`, and because it re-checks the tenant, drops superseded and
      // expired rows, and REPORTS what it dropped. Passing raw rows here would have been a
      // type error, which is how this was found.
      let questionRows: Record<string, unknown>[] = [];
      try {
        questionRows = (await ledgerService.getOpenQuestions(
          organizationId,
          conversationId
        )) as unknown as Record<string, unknown>[];
      } catch (e: any) {
        noteUnavailable('OPEN_QUESTION', 'the question ledger', e);
      }

      let objectionRows: Record<string, unknown>[] = [];
      try {
        objectionRows = (await ledgerService.getUnresolvedObjections(
          organizationId,
          conversationId
        )) as unknown as Record<string, unknown>[];
      } catch (e: any) {
        noteUnavailable('UNRESOLVED_OBJECTION', 'the objection ledger', e);
      }

      const adapted = adaptLedgers(
        { questions: questionRows, objections: objectionRows },
        organizationId,
        new Date().toISOString()
      );
      if (adapted.rejected.length > 0) {
        // A row refused is not a row absent. Reported so a ledger that is silently discarding
        // half its contents cannot look like a customer with nothing outstanding.
        console.warn(
          `[InboundPipeline] ${adapted.rejected.length} ledger row(s) refused for conversation ` +
            `${conversationId}:`,
          adapted.rejected
        );
      }

      const contextBundle = buildContextBundle({
        // The thread as this pipeline knows it. The inbound message is always included by the
        // selection rule; earlier turns are bounded by it rather than concatenated wholesale.
        thread: [
          {
            id: messageId,
            sender: 'PROSPECT',
            subject: email.subject ?? null,
            bodyText: email.textBody || email.htmlAsText || '',
            sentAt: new Date().toISOString(),
          },
        ],
        facts: activeFactRecords,
        openQuestions: adapted.openQuestions,
        unresolvedObjections: adapted.unresolvedObjections,
        // Not loaded on this path yet, and said so rather than passed as empty: neither has a
        // reachable reader here, so claiming "there are none" would be an invention.
        outstandingCommitments: adapted.outstandingCommitments,
        quotes: [],
        companyFacts: [],
        unavailable: [...unavailable, 'OUTSTANDING_COMMITMENT', 'QUOTE', 'COMPANY_FACT'],
        now: new Date().toISOString(),
      });

      console.log(
        `[InboundPipeline] context ${contextBundle.contextHash}: ` +
          `${contextBundle.contextIds.length} record(s), ${contextBundle.totalChars} chars, ` +
          `${contextBundle.unavailable.length} source(s) unavailable.`
      );

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
        rawInboundText: email.textBody || email.htmlAsText || '',
        contextBundle,
      });

      // 7a. S23 — ABSTENTION IS NOT SUPPRESSION.
      //
      // A suppressed reply is a decision: the planner considered this conversation and
      // chose not to answer. An abstention is the absence of a decision — no model could
      // answer, or generation is disabled. Reporting them under one disposition would hide
      // a total model outage inside the ordinary suppression count, which is the single
      // most important thing an operator needs to see and the least visible.
      //
      // Checked BEFORE the suppression guard, because `abstainedReply` deliberately sets
      // NO_REPLY so that the guard stops the draft even if this branch is ever removed.
      // That belt-and-braces ordering means the more specific branch has to come first.
      if (draft.abstention !== undefined) {
        console.warn(
          `[InboundPipeline] Composer abstained: ${describeAbstention(draft.abstention)}`
        );
        return {
          ok: true,
          disposition: 'ABSTAINED',
          detail: describeAbstention(draft.abstention),
          modelCalls,
          conversationId,
          messageId,
          contextHash: contextBundle.contextHash,
          contextIds: contextBundle.contextIds,
        };
      }

      // 7b. The planner can suppress too, and until now nothing listened.
      //
      // Two branches inside composeAutonomousSalesReply return an empty draft carrying a
      // suppressing action: prompt injection detected in the inbound text (§18), and a quote
      // lookup that failed while the plan intended to state a price (§14). Both returned
      // `{ subject: "", body: "", replyPlan: { nextBestAction: "SUPPRESS" | "NO_REPLY" } }` —
      // and the pipeline carried straight on and queued the empty body as an outbox row.
      // Same predicate as the pre-compose guard, so the two boundaries cannot drift apart.
      if (suppressesReply(draft.replyPlan.nextBestAction)) {
        console.warn(
          `[InboundPipeline] Planner suppressed the reply: ${draft.replyPlan.nextBestAction} — ` +
            draft.replyPlan.reason
        );
        return { ok: true, disposition: 'SUPPRESSED', detail: `${draft.replyPlan.nextBestAction}: ${draft.replyPlan.reason}`, modelCalls, conversationId, messageId, contextHash: contextBundle.contextHash, contextIds: contextBundle.contextIds };
      }

      // 8. Independent Audit — P0.11, now actually run.
      //
      // What stood here was a call to a local `runIndependentAudit()` that took no arguments,
      // awaited nothing, ignored the draft and returned a frozen literal. It was the honest
      // choice at the time: the pipeline was passing `{} as any` into the planner, so the
      // auditor genuinely could not be invoked faithfully, and a constant HUMAN_REVIEW_REQUIRED
      // beat asserting a PASS nobody computed.
      //
      // P1.8 removed the `as any`. Every input the auditor needs has been correctly built and
      // in scope ever since — `draft`, `identity`, `understanding`, `nbaResult`,
      // `conversationId` — so the reason the constant existed had already gone, and the
      // comment stating that reason had gone stale with it.
      //
      // Consequences of leaving it, all of which held until this change:
      //   - `auditDecision === BLOCK` and `=== PASS` were both statically unreachable, and the
      //     deliberately widened return type was what stopped the compiler saying so.
      //   - No suppression check, duplicate lock, phone/link/merge-tag sanitisation, CTA
      //     registry check or pricing check ran on ANY drafted reply.
      //   - `audit.sanitizedBody` did not exist on this path, so what was queued was
      //     `draft.body` verbatim, straight from the model.
      //
      // `quoteAvailability` is passed as NOT_LOOKED_UP rather than omitted, because the
      // context bundle above already records QUOTE in `unavailable`. Saying so lets the
      // auditor refuse to clear a stated amount against a price book that may not apply to
      // this customer, instead of reading "we did not look" as "they have no quote".
      const audit = await auditReplyAgainstPlan({
        draftBody: draft.body,
        replyPlan: draft.replyPlan,
        identity,
        emailUnderstanding: understanding,
        nextBestAction: nbaResult,
        conversationId,
        quoteAvailability: 'NOT_LOOKED_UP',
      });

      const auditReason =
        audit.findings.length > 0
          ? audit.findings.map((f) => `[${f.severity}] ${f.check}: ${f.detail}`).join(' | ')
          : 'No finding; every control that ran found nothing.';

      console.warn(
        `[InboundPipeline] audit -> ${audit.decision}: ${audit.findings.length} finding(s)` +
          (audit.findings.length > 0
            ? ': ' + audit.findings.map((f) => `${f.severity} ${f.check}`).join(', ')
            : '')
      );

      // One mapping from verdict to outbox action, in server/domain/adjudication.ts, so both
      // halves of it move together. Inline, they could drift: a fifth verdict added to the
      // type would compile here as neither BLOCK nor PASS and be queued for review by
      // accident rather than by decision.
      const sendDisposition = dispositionFor(audit.decision);

      if (sendDisposition.queue === false) {
        console.error('Draft blocked by auditor:', auditReason);
        return { ok: true, disposition: 'BLOCKED', detail: auditReason, modelCalls, conversationId, messageId, contextHash: contextBundle.contextHash, contextIds: contextBundle.contextIds };
      }

      // 9. Transactional Outbox Insert
      //
      // P0.7 — This wrote to the POSTGRES `outboxMessages` table while outbox.worker.ts polls
      // the FIRESTORE queue, so nothing produced here was ever consumed: the Firestore queue
      // had no reachable producer and always returned empty. Both sides now use the same
      // store, through outboxService, which is also where the idempotency key and the
      // claim/lease fields live.
      //
      // S24 — from the verdict, via the shared mapping. REWRITE and ESCALATE both mean a
      // control fired; the difference between them is what an operator needs in order to
      // triage, not whether to hold.
      // S17 — an attachment finding forces human review regardless of what the audit decided.
      //
      // Written as an override of the audit rather than as a branch inside it, because the two
      // are answering different questions: the auditor grades the DRAFT, and this grades what
      // arrived. A clean draft in reply to a message carrying `invoice.pdf.exe` is exactly the
      // case where the auditor has nothing to object to.
      //
      // It can only ever tighten. `HUMAN_REVIEW` is the held status, so an attachment finding
      // cannot release a draft the auditor held.
      const outboxStatus = attachmentsPermitAutonomy(attachments.disposition)
        ? sendDisposition.status
        : 'HUMAN_REVIEW';

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
        // P0.11 — `draft.body` was queued here, so even on the paths where the auditor did
        // run its rewrites were discarded: the phone-number redaction, the Meet/Calendar URL
        // correction, the merge-tag resolution and the CTA-registry alignment all wrote to
        // `sanitizedBody`, and nothing read it. What a human approves is now what the
        // auditor produced.
        htmlBody: audit.sanitizedBody,
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

      // P0.11 — ONE write, at the status the audit reached.
      //
      // This was an enqueue at PENDING followed by `holdForHumanReview` flipping it to
      // HUMAN_REVIEW. Between those two awaits the row was PENDING, and `claimPendingJobs`
      // selects exactly `status == PENDING` on a continuous worker tick — so a tick landing
      // in that window claimed and dispatched a draft the auditor had refused. The hold was
      // also skipped entirely when `queueMessage` returned null on an idempotency-key
      // collision, leaving whatever status the pre-existing row already carried.
      const queued = await outboxService.queueMessage(
        organizationId,
        conversationId,
        outboundPayload,
        `reply_${email.id}`,
        { generatedForInboundVersion: inboundVersion, approvalDigest },
        outboxStatus,
        // The operator is told which control held this. An attachment finding and an audit
        // objection lead to different actions, and a single "held for review" says neither.
        attachments.reason === null ? auditReason : `${attachments.reason} | ${auditReason}`
      );

      if (queued === null) {
        // The idempotency key already exists, so this draft was NOT stored, and the row that
        // holds the key was written by an earlier run whose status this call did not set.
        // Reporting QUEUED here would claim an outbox row reflects this audit when it does
        // not.
        console.warn(
          `[InboundPipeline] outbox key reply_${email.id} already exists; this draft was not ` +
            'stored, and the existing row keeps its own status.'
        );
        return {
          ok: true,
          disposition: 'SUPPRESSED',
          detail: `Duplicate outbox key reply_${email.id}; existing row retained. This audit reached ${audit.decision}.`,
          modelCalls,
          conversationId,
          messageId,
          contextHash: contextBundle.contextHash,
          contextIds: contextBundle.contextIds,
        };
      }

      console.log(`--- Pipeline Completed. Outbox job created: ${outboxStatus} ---`);

      // What the budget actually saw, rather than the fabricated constant it used to be fed.
      // `tokensArePartial` is reported because a total assembled from calls the provider said
      // nothing about is a lower bound, and printing it bare would read as the whole spend.
      const spend = budgetTracker.snapshot();
      console.log(
        `[InboundPipeline] ${spend.modelCalls} model call(s), ` +
          `${spend.tokens} reported token(s)${spend.tokensArePartial ? ' (PARTIAL — ' + spend.unmeasuredCalls + ' call(s) unmeasured)' : ''}, ` +
          `${spend.elapsedMs}ms. Models: ${modelCalls.map((c) => c.model ?? 'NONE(fallback)').join(', ') || 'none'}`
      );

      return { ok: true, disposition: 'QUEUED', detail: `outbox=${outboxStatus}`, modelCalls, conversationId, messageId, contextHash: contextBundle.contextHash, contextIds: contextBundle.contextIds };

    } catch (e) {
      // This was `console.error(...)` and nothing else — no rethrow, no durable record, no
      // marking for retry or human attention. Every defect on this path terminated here
      // identically and silently, the caller's promise resolved normally, and the webhook
      // returned 200 OK to Google. An inbound customer email was dropped while every layer
      // above it reported success.
      //
      // Still not rethrown: a webhook that 500s invites a redelivery storm, and the retry
      // decision belongs to the caller. But the failure is now IN THE RETURN VALUE, where a
      // caller has to look at it to ignore it.
      const message = e instanceof Error ? e.message : String(e);
      const budgetHit = message.startsWith('BUDGET_EXCEEDED');
      console.error(
        `[InboundPipeline] FAILED for message ${email?.id ?? 'unknown'} in organisation ` +
          `${organizationId}: ${message}`,
        e
      );
      metricsService.incrementCounter('AI_FAILURE');
      return {
        ok: false,
        stage: budgetHit ? 'BUDGET' : 'UNHANDLED',
        detail: message,
        modelCalls,
      };
    } finally {
      // S45 — in a `finally`, not on the success path.
      //
      // The emit used to sit just before the successful return, so a p95 computed from these
      // samples described only the requests that worked. A pipeline failing half its inbound
      // mail would have shown a healthy latency objective, because the slow and broken half was
      // never measured — the metric would have been most reassuring exactly when it mattered.
      metricsService.recordLatency('INBOUND_PROCESSING', Date.now() - startTime);
    }
  }
}

export const inboundPipeline = new InboundPipeline();
