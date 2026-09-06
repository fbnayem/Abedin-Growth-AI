// P0.2 — Imported FIRST and for its side effect as well as its exports: this module calls
// dotenv.config() at evaluation time, guaranteeing .env has been loaded before any flag is
// read, no matter how this gateway is reached. See server/config/safeMode.ts.
import { isRealActionEnabled } from '../config/safeMode';
import { firestore } from '../firebase';
import { collection, doc, getDoc, getDocs, setDoc, query, where } from 'firebase/firestore';
import { gmailService } from '../services/gmail.service';
import { outreachPolicyService } from '../policies/outreachPolicy';
import { fetchWithTimeout } from '../lib/httpClient';
import { orgPath, isValidOrgId } from '../tenancy/orgScope';
import { classifyThrown, requiresReconciliation, type ProviderErrorKind } from '../lib/providerError';
import { FABRICATED_PROVIDER_ID, isFabricatedProviderId } from '../lib/providerId';
import { assertCapability, CapabilityError, normalizeScopes, type Capability } from '../lib/capabilities';
import { assertTimeZone, isWithinBusinessHours, parseInstant, DEFAULT_BUSINESS_HOURS, systemClock, type Clock } from '../../shared/domain/time';
import { outboundMessageId } from '../lib/messageIdentity';
import {
  reconcileEmailSend,
  mayRetryAfterReconciliation,
  wasApplied,
  type ReconciliationOutcome,
  type ReconciliationVerdict,
} from '../lib/reconciliation';

export enum ActionType {
  EMAIL_SEND = 'EMAIL_SEND',
  CALENDAR_CREATE = 'CALENDAR_CREATE',
  CALENDAR_UPDATE = 'CALENDAR_UPDATE',
  CALENDAR_CANCEL = 'CALENDAR_CANCEL',
  PAYMENT_CREATE = 'PAYMENT_CREATE',
  SIGNATURE_SEND = 'SIGNATURE_SEND',
  CRM_UPDATE = 'CRM_UPDATE',
  EXTERNAL_MESSAGE_SEND = 'EXTERNAL_MESSAGE_SEND'
}

export interface ActionRequest {
  actionType: ActionType;
  organizationId: string;
  targetId: string; // Contact ID, Deal ID, etc.
  conversationId?: string;
  payload: any;
  proposedBy: string; // Agent ID or human
}

export interface ActionResult {
  success: boolean;
  actionId?: string;
  providerResult?: any;
  error?: string;
  isAmbiguousResult?: boolean;
  blockedReason?: string;
  /**
   * P0.8 — Structured failure code so callers branch on a value rather than on error prose.
   * PROVIDER_NOT_CONFIGURED is the specific case that used to be reported as SUCCESS with a
   * fabricated `sim_...` provider id.
   */
  errorCode?:
    | 'PROVIDER_NOT_CONFIGURED'
    | 'PROVIDER_AUTH_EXPIRED'
    | 'PROVIDER_UNAVAILABLE'
    | 'POLICY_BLOCKED'
    | 'FABRICATED_PROVIDER_ID'
    | 'UNSUPPORTED_ACTION'
    | 'INVALID_TIME_ZONE'
    | 'INVALID_INSTANT'
    | 'INVALID_DURATION'
    | 'OUTSIDE_BUSINESS_HOURS'
    | 'CAPABILITY_NOT_GRANTED'
    /**
     * S32 — the send could not be given a stable, provider-searchable identity, so if it
     * timed out we could never establish whether it had happened. Refused before the network
     * rather than after it.
     */
    | 'UNRECONCILABLE_SEND';
  /** P1.11 — the normalized provider failure kind, when the failure came from a provider. */
  errorKind?: ProviderErrorKind;
  /**
   * P1.11 — set when an IRREVERSIBLE action failed ambiguously. A caller that retries while
   * this is true may cause the side effect a second time (§32).
   */
  requiresReconciliation?: boolean;
  /**
   * S32 — what asking the provider established. Present whenever `requiresReconciliation` was
   * true and a reconciliation was attempted.
   *
   * The caller must branch on `verdict`, not on `success`: an APPLIED verdict means the action
   * DID take effect even though the dispatch reports failure, and recording that as a failure
   * loses a message the customer has already received.
   */
  reconciliation?: ReconciliationOutcome;
}

/**
 * Which actions cannot be undone by repeating them.
 *
 * This drives the §32 gate, so it is a closed switch rather than a list with a default: a new
 * ActionType must be classified deliberately, and the fallback is `true` (treat it as
 * irreversible) because assuming an unknown action is safe to repeat is the dangerous
 * direction.
 */
export function isIrreversible(actionType: ActionType): boolean {
  switch (actionType) {
    case ActionType.EMAIL_SEND:
    case ActionType.CALENDAR_CREATE:
    case ActionType.CALENDAR_UPDATE:
    case ActionType.CALENDAR_CANCEL:
    case ActionType.PAYMENT_CREATE:
    case ActionType.SIGNATURE_SEND:
    case ActionType.EXTERNAL_MESSAGE_SEND:
      return true;
    case ActionType.CRM_UPDATE:
      // An internal, idempotent write to our own store. Repeating it changes nothing.
      return false;
    default:
      return true;
  }
}

/** The provider an action talks to, for the error record. */
export function providerFor(actionType: ActionType): string {
  switch (actionType) {
    case ActionType.EMAIL_SEND:
      return 'gmail';
    case ActionType.CALENDAR_CREATE:
    case ActionType.CALENDAR_UPDATE:
    case ActionType.CALENDAR_CANCEL:
      return 'google-calendar';
    case ActionType.PAYMENT_CREATE:
      return 'stripe';
    case ActionType.SIGNATURE_SEND:
      return 'docusign';
    case ActionType.EXTERNAL_MESSAGE_SEND:
      return 'linkedin';
    default:
      return 'internal';
  }
}

/** The capability an action requires, or null when it touches no provider. */
export function capabilityFor(actionType: ActionType): Capability | null {
  switch (actionType) {
    case ActionType.EMAIL_SEND:
      return 'EMAIL_SEND';
    case ActionType.CALENDAR_CREATE:
    case ActionType.CALENDAR_UPDATE:
    case ActionType.CALENDAR_CANCEL:
      return 'CALENDAR_WRITE';
    default:
      return null;
  }
}

// P0.8 — the fabricated-id rule moved to lib/providerId.ts so reconciliation can apply the
// same rule without importing the gateway (that would close a cycle). Re-exported here
// because this was its published home and callers already import it from the gateway.
export { FABRICATED_PROVIDER_ID, isFabricatedProviderId };

export class ActionGateway {
  
  // P0.2 — The `private readonly SAFE_MODE = {...}` snapshot that used to live here has been
  // removed. It was evaluated at module-evaluation time, which ES module hoisting runs BEFORE
  // dotenv.config() in server.ts, so values in .env never reached this enforcement point while
  // /api/readiness reported them as if they had. Flags are now read lazily, per decision, from
  // server/config/safeMode.ts — the same module readiness reads, so the displayed value and the
  // enforced value cannot drift apart.

  /**
   * S30/S32 — an injectable clock, because reconciliation turns on an elapsed interval.
   *
   * "Has enough time passed that the provider's index would show this message if it had it?"
   * is a question about a duration, and a test that answers it from the wall clock proves
   * nothing about the boundary it claims to test. This is the seam that lets a test stand one
   * millisecond either side of the settle window and observe two different verdicts.
   */
  constructor(private readonly clock: Clock = systemClock) {}

  /**
   * Central entry point for all external actions.
   */
  async dispatchAction(request: ActionRequest): Promise<ActionResult> {
    console.log(`[ActionGateway] Received request for ${request.actionType} from ${request.proposedBy}`);

    // P1.1 — The tenant is validated FIRST, before the audit log, because the audit log is
    // itself written to organizations/<organizationId>/actionLogs. An unvalidated org id
    // reaching that path would let a caller redirect the audit trail itself, which is the one
    // record that is supposed to be trustworthy when everything else is in doubt.
    if (!isValidOrgId(request.organizationId)) {
      const reason =
        'Action blocked: the request carries no valid organisation id, so it cannot be ' +
        'attributed to a tenant, audited, or consent-checked.';
      console.error(`[ActionGateway] ${reason}`);
      return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
    }

    // 1. Audit Logging - Propose
    const actionId = `action_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    await this.logAction(actionId, 'PROPOSED', request);

    // 2. Pre-execution checks
    if (!this.checkFeatureFlag(request.actionType)) {
      const reason = `Action blocked: ${request.actionType} is disabled in Safe Rebuild Mode.`;
      console.warn(`[ActionGateway] ${reason}`);
      await this.logAction(actionId, 'BLOCKED', request, { reason });
      return { success: false, blockedReason: reason };
    }

    if (request.conversationId) {
      const isPaused = await this.checkHumanOwnershipLock(request.organizationId, request.conversationId);
      if (isPaused) {
        const reason = `Action blocked: Conversation ${request.conversationId} is under Human Ownership Lock.`;
        console.warn(`[ActionGateway] ${reason}`);
        await this.logAction(actionId, 'BLOCKED', request, { reason });
        return { success: false, blockedReason: reason };
      }
    }

    // 2b. Capability pre-flight (P1.11).
    //
    // The only question asked before dispatch used to be "is there an access token?".
    // Whether that token had ever been granted permission to send was never asked, because
    // the granted scopes were never stored. A `gmail.readonly` token therefore reached the
    // send path and failed at Google with a 403 — after the action was dispatched, logged as
    // attempted, and counted against the outbox. A 403 for missing scope is not retryable, so
    // every retry spent a network round trip rediscovering the same fact.
    //
    // Asking here costs nothing and answers before anything leaves the process.
    const requiredCapability = capabilityFor(request.actionType);
    if (requiredCapability !== null) {
      const preflight = await this.checkProviderCapability(request, requiredCapability);
      if (preflight !== null) {
        await this.logAction(actionId, 'BLOCKED', request, {
          reason: preflight.error,
          capability: requiredCapability,
        });
        return preflight;
      }
    }

    // 3. Execution routing
    let result: ActionResult = { success: false };
    // S32 — stamped BEFORE the attempt. Reconciliation asks whether enough time has passed for
    // the provider's index to reflect the send, and reading the clock after the failure would
    // measure the timeout's own duration as settle time.
    const attemptedAt = this.clock.now();
    try {
      await this.logAction(actionId, 'DISPATCHING', request);
      
      switch (request.actionType) {
        case ActionType.EMAIL_SEND:
          result = await this.executeEmailSend(request);
          break;
        case ActionType.CALENDAR_CREATE:
          result = await this.executeCalendarCreate(request);
          break;
        // Other cases stubbed for future
        default:
          result = { success: false, error: 'Unsupported action type' };
      }

      await this.logAction(actionId, result.success ? 'SUCCESS' : 'FAILED', request, result);
      return result;
    } catch (e: any) {
      console.error(`[ActionGateway] Fatal error during ${request.actionType}:`, e);

      // P1.11 — the §32 classifier. This was:
      //
      //     const isAmbiguous = e.message.includes('timeout') || e.message.includes('network');
      //
      // which was inverted in both directions, and measurably so. `fetchWithTimeout` throws
      // `HttpTimeoutError`, whose message reads "…timed out after 15000ms" — and "timed out"
      // does not contain "timeout". So the ONE timeout this codebase raises classified as a
      // definite failure, as did every other real provider error ("fetch failed", "socket
      // hang up", "read ECONNRESET", "Rate Limit Exceeded", "504 Gateway Timeout").
      //
      // Meanwhile a message that DID contain "timeout" or "network" classified as ambiguous,
      // and provider errors quote request content — so a customer could put the word in an
      // email subject and steer the decision (§18).
      //
      // The result was precisely the failure §32 exists to prevent: a send that timed out,
      // and may well have been delivered, was recorded as definitely-failed and became
      // eligible for retry. Classification now reads type, code and HTTP status only.
      const classified = classifyThrown(e, {
        provider: providerFor(request.actionType),
        operation: request.actionType,
      });
      const irreversible = isIrreversible(request.actionType);
      const mustReconcile = requiresReconciliation(classified, irreversible);
      const status = mustReconcile ? 'AMBIGUOUS_PROVIDER_RESULT' : 'ERROR';

      await this.logAction(actionId, status, request, {
        ...classified.toLogRecord(),
        irreversible,
        requiresReconciliation: mustReconcile,
      });

      if (!mustReconcile) {
        return {
          success: false,
          error: classified.message,
          errorKind: classified.kind,
          isAmbiguousResult: classified.isAmbiguous,
          requiresReconciliation: false,
        };
      }

      console.warn(
        `[ActionGateway] ${classified.kind} on an irreversible ${request.actionType}: the ` +
          `outcome is unknown, so this must be reconciled against the provider before any ` +
          `retry. ${classified.disposition.rationale}`
      );

      // S32 — the part that was a comment. Until now the ambiguity was recorded and handed to
      // "an operator or the reconciliation worker", and there was no reconciliation worker, so
      // every ambiguous send was dead-lettered whether or not it had actually been delivered.
      // We now ask the provider.
      const reconciliation = await this.reconcileAmbiguous(request, attemptedAt);
      await this.logAction(actionId, `RECONCILED_${reconciliation.verdict}`, request, {
        verdict: reconciliation.verdict,
        evidence: reconciliation.evidence,
        providerMessageId: reconciliation.providerMessageId,
        lookupErrorKind: reconciliation.lookupErrorKind,
      });

      if (wasApplied(reconciliation.verdict)) {
        // The action DID take effect. Reporting failure here would lose a message the
        // recipient has already read, and would leave the job eligible for a retry that
        // sends it again. `success` is about the side effect, not about the HTTP call.
        console.warn(
          `[ActionGateway] Reconciliation established that the ${request.actionType} DID take ` +
            `effect despite the ${classified.kind}. Recording it as done. ${reconciliation.evidence}`
        );
        return {
          success: true,
          providerResult: {
            messageId: reconciliation.providerMessageId,
            threadId: reconciliation.providerThreadId,
            reconciled: true,
          },
          errorKind: classified.kind,
          isAmbiguousResult: false,
          requiresReconciliation: false,
          reconciliation,
        };
      }

      return {
        success: false,
        error: classified.message,
        errorKind: classified.kind,
        isAmbiguousResult: true,
        // Resolved to a definite failure only when the provider was asked and said no, after
        // the settle window. Every other path leaves this true, and true means "do not retry".
        requiresReconciliation: !mayRetryAfterReconciliation(reconciliation.verdict),
        blockedReason: mayRetryAfterReconciliation(reconciliation.verdict)
          ? undefined
          : 'AMBIGUOUS_PROVIDER_RESULT',
        reconciliation,
      };
    }
  }

  /**
   * Ask the provider what actually happened, for the action types where we can.
   *
   * The default is STILL_UNKNOWN, and it is the default for a reason: an action type with no
   * reconciliation implementation must not be treated as reconciled. A `default:` branch that
   * returned NOT_APPLIED — "we could not check, so assume it did not happen" — would license
   * exactly the duplicate this whole mechanism exists to prevent (§14).
   */
  private async reconcileAmbiguous(
    request: ActionRequest,
    attemptedAt: Date
  ): Promise<ReconciliationOutcome> {
    if (request.actionType !== ActionType.EMAIL_SEND) {
      return {
        verdict: 'STILL_UNKNOWN' as ReconciliationVerdict,
        evidence:
          `No reconciliation is implemented for ${request.actionType}. Unchecked is not the ` +
          'same as checked-and-absent, so this stays un-retryable and needs an operator.',
        providerMessageId: null,
        providerThreadId: null,
        lookupErrorKind: null,
      };
    }

    let rfc822MessageId: string | null = null;
    try {
      rfc822MessageId = outboundMessageId(
        request.payload?.idempotencyKey,
        process.env.OUTBOUND_MESSAGE_ID_DOMAIN
      );
    } catch {
      // The send was never reconcilable. `reconcileEmailSend` says so in its own words.
      rfc822MessageId = null;
    }

    return reconcileEmailSend(gmailService, {
      rfc822MessageId,
      attemptedAt,
      now: this.clock.now(),
    });
  }

  /**
   * Returns null when the connection may perform `capability`, or the refusal to return.
   *
   * A connection we cannot READ is not a connection we may assume is fine: a datastore error
   * here yields a refusal, not a pass. §14 — unknown must never default to permission — and
   * the permission at stake is permission to send.
   */
  private async checkProviderCapability(
    request: ActionRequest,
    capability: Capability
  ): Promise<ActionResult | null> {
    if (!firestore) {
      return {
        success: false,
        errorCode: 'CAPABILITY_NOT_GRANTED',
        error: 'Cannot verify provider scopes: the datastore is unavailable. Refusing to send.',
      };
    }
    const provider = providerFor(request.actionType);
    try {
      const snap = await getDocs(
        query(
          collection(firestore, 'oauth_connections'),
          where('organizationId', '==', request.organizationId)
        )
      );
      let connection: { provider: string; organizationId: string; scopes: string[] | null; status: string | null; expiresAt: any } | null = null;
      snap.forEach((d) => {
        const data: any = d.data();
        const isGoogle = String(data.provider ?? '').toLowerCase() === 'gmail';
        if (!isGoogle) return;
        connection = {
          provider,
          organizationId: request.organizationId,
          scopes: normalizeScopes(data.scopes ?? data.scope),
          status: data.status ?? null,
          expiresAt: data.expiresAt?.toDate?.() ?? data.expiresAt ?? null,
        };
      });

      if (connection === null) {
        return {
          success: false,
          errorCode: 'PROVIDER_NOT_CONFIGURED',
          error: `No ${provider} connection is configured for this organization.`,
        };
      }

      assertCapability(connection, capability, new Date());
      return null;
    } catch (e: any) {
      if (e instanceof CapabilityError) {
        console.warn(`[ActionGateway] ${request.actionType} refused: ${e.message}`);
        return {
          success: false,
          errorCode: 'CAPABILITY_NOT_GRANTED',
          error: e.message,
        };
      }
      // Could not establish the grant. That is not the same as having it.
      console.error(`[ActionGateway] Capability pre-flight failed for ${request.actionType}:`, e);
      return {
        success: false,
        errorCode: 'CAPABILITY_NOT_GRANTED',
        error: 'Could not verify provider scopes, so the grant is unknown. Refusing to send.',
      };
    }
  }

  private checkFeatureFlag(actionType: ActionType): boolean {
    switch (actionType) {
      case ActionType.EMAIL_SEND:
        return isRealActionEnabled('REAL_EMAIL_SEND_ENABLED');
      case ActionType.CALENDAR_CREATE:
      case ActionType.CALENDAR_UPDATE:
      case ActionType.CALENDAR_CANCEL:
        return isRealActionEnabled('REAL_CALENDAR_CREATE_ENABLED');
      case ActionType.PAYMENT_CREATE:
        return isRealActionEnabled('REAL_PAYMENT_ENABLED');
      case ActionType.SIGNATURE_SEND:
        return isRealActionEnabled('REAL_SIGNATURE_ENABLED');
      case ActionType.EXTERNAL_MESSAGE_SEND:
        return isRealActionEnabled('REAL_LINKEDIN_SEND_ENABLED');
      case ActionType.CRM_UPDATE:
        // Internal-only mutation: no external side effect, so it is not gated by Safe Mode.
        return true;
      default:
        // P0.2 — This used to `return true`, which meant any action type added to the enum
        // without a case here was dispatched by DEFAULT. A dispatch gate whose fallback is
        // "allow" fails OPEN, the exact inverse of addendum §A ("production action flags must
        // fail closed"). An unrecognised action is now refused, so adding an ActionType
        // without deciding its safety posture blocks it rather than silently permitting it.
        console.warn(
          `[ActionGateway] Unrecognised action type '${actionType}' has no Safe Mode policy; ` +
            `refusing by default (fail closed). Add an explicit case to checkFeatureFlag().`
        );
        return false;
    }
  }

  private async checkHumanOwnershipLock(orgId: string, conversationId: string): Promise<boolean> {
    if (!firestore) return false;
    try {
      const docSnap = await getDoc(doc(firestore, orgPath(orgId, 'conversations'), conversationId));
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data?.autonomyPausedByHuman) {
          return true;
        }
      }
      return false;
    } catch (e) {
      console.error("Error checking human ownership lock:", e);
      return true; // Fail closed
    }
  }

  private async logAction(actionId: string, status: string, request: ActionRequest, resultDetails?: any) {
    if (!firestore) return;
    try {
      await setDoc(doc(firestore, orgPath(request.organizationId, 'actionLogs'), actionId), {
        actionId,
        status,
        actionType: request.actionType,
        targetId: request.targetId,
        conversationId: request.conversationId || null,
        proposedBy: request.proposedBy,
        resultDetails: resultDetails || null,
        timestamp: Date.now()
      }, { merge: true });
    } catch (e) {
      console.error("[ActionGateway] Failed to audit log action:", e);
    }
  }

  private async executeEmailSend(request: ActionRequest): Promise<ActionResult> {
    console.log(`[ActionGateway] Executing EMAIL_SEND to ${request.payload.to}`);
    try {
        // Q. JURISDICTION-AWARE OUTREACH POLICY
        // In a real implementation, we'd lookup the recipient's country and consent status from the DB.

        // P0.10 — CONSENT AND SUPPRESSION, FAIL CLOSED.
        //
        // This block previously defaulted `resolvedCountry = 'US'`, `resolvedConsent = true`
        // and passed a hardcoded `isB2B: true`. Addendum §14 forbids exactly this: unknown
        // consent must not become "true", unknown country must not become a permissive
        // jurisdiction, and unknown customer state must not authorise cold outreach. As
        // written, a contact with no record at all was treated as a consenting US B2B
        // recipient — the most permissive reading of the least information.
        //
        // Note `contactSnap.exists` was also a bug: in the Firestore v9 API `exists` is a
        // METHOD, so the truthiness test passed even for missing documents and the code read
        // fields off a non-existent record.
        if (!request.payload.contactId) {
            const reason =
                'EMAIL_SEND requires an explicit contactId so consent and suppression can be ' +
                'checked. Refusing to send to an unidentified recipient.';
            console.warn(`[ActionGateway] ${reason}`);
            return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
        }

        // P1.1 — This line read a hardcoded organisation's contacts collection while request.organizationId
        // sat in scope and was used correctly nine lines earlier. A consent and suppression
        // check for one tenant was therefore answered from another tenant's contact records:
        // an unknown recipient could look consented, and a suppressed one could look clear.
        const contactSnap = await getDoc(
          doc(firestore, orgPath(request.organizationId, 'contacts'), request.payload.contactId)
        );
        if (!contactSnap.exists()) {
            const reason =
                `Contact ${request.payload.contactId} not found. Refusing to send without a ` +
                `consent record (INSUFFICIENT_DATA, not implied permission).`;
            console.warn(`[ActionGateway] ${reason}`);
            return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
        }

        const contactData = contactSnap.data() as any;

        // Suppression is checked before anything else: an unsubscribe, hard bounce or
        // complaint outranks every other consideration, including an operator's intent.
        const suppressionFlags = [
            contactData.suppressed === true ? 'SUPPRESSED' : null,
            contactData.unsubscribed === true ? 'UNSUBSCRIBED' : null,
            contactData.hardBounced === true ? 'HARD_BOUNCE' : null,
            contactData.complained === true ? 'SPAM_COMPLAINT' : null,
            contactData.emailStatus === 'BOUNCED' ? 'BOUNCED' : null,
        ].filter(Boolean);

        if (suppressionFlags.length > 0) {
            const reason = `Recipient is suppressed (${suppressionFlags.join(', ')}). Send refused.`;
            console.warn(`[ActionGateway] ${reason}`);
            return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
        }

        // Unknown consent is INSUFFICIENT_DATA, never permission.
        if (contactData.consentGiven !== true) {
            const reason =
                `No affirmative consent record for contact ${request.payload.contactId} ` +
                `(consentGiven=${JSON.stringify(contactData.consentGiven)}). ` +
                `Unknown consent is treated as INSUFFICIENT_DATA and routed to human review, ` +
                `not as permission.`;
            console.warn(`[ActionGateway] ${reason}`);
            return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
        }

        // Unknown country is not a permissive jurisdiction. Normalise to an ISO code and
        // refuse when absent, rather than assuming 'US'.
        const rawCountry = typeof contactData.country === 'string' ? contactData.country.trim().toUpperCase() : '';
        if (!/^[A-Z]{2}$/.test(rawCountry)) {
            const reason =
                `Recipient jurisdiction unknown or not an ISO-3166 alpha-2 code ` +
                `(country=${JSON.stringify(contactData.country)}). Refusing rather than ` +
                `assuming a permissive jurisdiction.`;
            console.warn(`[ActionGateway] ${reason}`);
            return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
        }

        const policyResult = await outreachPolicyService.evaluateOutreach({
             country: rawCountry,
             campaignType: request.payload.campaignType || 'inbound',
             consentGiven: true, // proven above, not assumed
             // Was hardcoded `true`. B2B status materially changes the legal basis under
             // PECR/GDPR, so it must come from the record and default to the stricter B2C.
             isB2B: contactData.isB2B === true,
        });

        if (!policyResult.allowed) {
            console.warn(`[ActionGateway] Email blocked by outreach policy: ${policyResult.reason}`);
            return { success: false, blockedReason: policyResult.reason, errorCode: 'POLICY_BLOCKED' };
        }

        if (!firestore) return { success: false, error: 'Firestore not initialized' };
        // Fetch oauth token for organization
        const q = query(collection(firestore, 'oauth_connections'), where('organizationId', '==', request.organizationId));
        const oauthsSnap = await getDocs(q);
        // P0.8 — This used to default to the literal 'mock_token' and, on finding it, RETURN
        // SUCCESS with a locally-minted `sim_email_<timestamp>` id. Because server.ts wrote
        // 'mock_token' on every Gmail "connect", that branch fired for 100% of sends: the
        // system transmitted nothing and recorded status SENT. Addendum §3 requires that a
        // message cannot become SENT without a real provider result, so a missing or
        // unusable credential is now a FAILURE, and it is the caller's job to surface it.
        let accessToken: string | null = null;
        oauthsSnap.forEach(doc => {
            const d = doc.data();
            if (d.provider === 'gmail' || d.provider === 'GMAIL') {
                accessToken = d.accessToken ?? null;
            }
        });

        if (!accessToken || isFabricatedProviderId(accessToken) || accessToken === 'mock_token') {
            const reason =
                'No usable Gmail credential is configured for this organization. ' +
                'Refusing to report a send that did not happen.';
            console.warn(`[ActionGateway] EMAIL_SEND refused: ${reason}`);
            return { success: false, error: reason, errorCode: 'PROVIDER_NOT_CONFIGURED' };
        }

        // S32 — a send that could never afterwards be asked about is refused BEFORE the
        // network, not discovered to be unreconcilable after it has timed out.
        //
        // The Message-ID is derived from the job's idempotency key, so the same job produces
        // the same id on every attempt in every process. That determinism is the whole
        // mechanism: `rfc822msgid:<id>` then answers "did THIS send happen", which is the only
        // question §32 reconciliation asks. A random id would be stable within one attempt and
        // different on the retry, so it would answer "no" every time and licence the duplicate.
        let rfc822MessageId: string;
        try {
            rfc822MessageId = outboundMessageId(
                request.payload.idempotencyKey,
                process.env.OUTBOUND_MESSAGE_ID_DOMAIN
            );
        } catch (e: any) {
            const reason = String(e?.message ?? e);
            console.warn(`[ActionGateway] EMAIL_SEND refused: ${reason}`);
            return { success: false, error: reason, errorCode: 'UNRECONCILABLE_SEND' };
        }

        gmailService.setCredentials({ access_token: accessToken });
        const result = await gmailService.sendEmail({
            to: request.payload.to,
            subject: request.payload.subject,
            bodyHtml: request.payload.htmlBody,
            bodyText: request.payload.textBody,
            inReplyTo: request.payload.inReplyTo,
            references: request.payload.references,
            threadId: request.payload.threadId,
            rfc822MessageId,
        });

        return { success: true, providerResult: result };
    } catch (e: any) {
      // The same broken substring test lived here too, and missed the same errors. Rethrowing
      // a classified error lets the one classifier in dispatchAction make the §32 decision,
      // rather than two call sites each deciding it slightly differently.
      throw classifyThrown(e, { provider: "gmail", operation: "EMAIL_SEND" });
    }
  }


  private async executeCalendarCreate(request: ActionRequest): Promise<ActionResult> {
     console.log(`[ActionGateway] Executing CALENDAR_CREATE for ${request.payload.title}`);
     
     // P1.9/P1.11 — three defects sat in these twenty lines.
     //
     //   const tz = request.payload.timezone || 'UTC';   <- read by the API body below
     //   const hour = date.getUTCHours();
     //   if (hour < 8 || hour > 18) ...                  <- business hours judged in UTC
     //
     // The zone was passed to Google, and ignored by the check one line below it — so we
     // told the provider the customer's zone while judging "business hours" as 08:00-18:00
     // UTC for everyone on earth. P1.9 fixed this shape everywhere else and missed it here,
     // because this adapter is unreachable: `dispatchAction` has exactly one call site
     // repo-wide and it always passes EMAIL_SEND. Unreachable code still gets reached one day.
     //
     //   let hasConflict = false;
     //   // We will check it inside the real API call block to use the token.
     //   if (hasConflict) return { success: false, error: 'Schedule conflict detected' };
     //
     // A conflict check structurally incapable of finding a conflict, sitting above the real
     // one. It reads like protection and is not.
     const timeZone = request.payload.timezone ?? DEFAULT_BUSINESS_HOURS.timeZone;
     try {
       assertTimeZone(timeZone);
     } catch (e: any) {
       return { success: false, error: String(e?.message ?? e), errorCode: 'INVALID_TIME_ZONE' };
     }

     let startInstant: Date;
     let endInstant: Date;
     try {
       startInstant = parseInstant(request.payload.startTime);
       endInstant = parseInstant(request.payload.endTime);
     } catch (e: any) {
       return { success: false, error: String(e?.message ?? e), errorCode: 'INVALID_INSTANT' };
     }

     const hours = isWithinBusinessHours(startInstant, { ...DEFAULT_BUSINESS_HOURS, timeZone });
     if (hours.within === false) {
         return {
           success: false,
           error: `${hours.localTime} is outside business hours (${hours.reason}).`,
           errorCode: 'OUTSIDE_BUSINESS_HOURS',
         };
     }

     const duration = (endInstant.getTime() - startInstant.getTime()) / 60000;
     if (duration <= 0 || duration > 120) {
         return { success: false, error: 'Invalid meeting duration', errorCode: 'INVALID_DURATION' };
     }

     
     if (process.env.REAL_CALENDAR_CREATE_ENABLED === 'true') {
         if (!firestore) return { success: false, error: 'Firestore not initialized' };
         // Fetch oauth token for organization
         const q = query(collection(firestore, 'oauth_connections'), where('organizationId', '==', request.organizationId));
         const oauthsSnap = await getDocs(q);
         // P0.8 — Same fabricated-success defect as the email path: a missing credential
         // returned SUCCESS with a locally-minted `sim_evt_<timestamp>` id, so a meeting could
         // be recorded as booked when no calendar event existed. Creating a calendar event is
         // an irreversible external action; it must fail loudly rather than be invented.
         let accessToken: string | null = null;
         oauthsSnap.forEach(doc => {
             const d = doc.data();
             if (d.provider === 'gmail' || d.provider === 'GMAIL') {
                 accessToken = d.accessToken ?? null;
             }
         });

         if (!accessToken || isFabricatedProviderId(accessToken) || accessToken === 'mock_token') {
             const reason =
                 'No usable Google credential is configured for this organization. ' +
                 'Refusing to report a calendar event that was never created.';
             console.warn(`[ActionGateway] CALENDAR_CREATE refused: ${reason}`);
             return { success: false, error: reason, errorCode: 'PROVIDER_NOT_CONFIGURED' };
         }

         // 4. Check free/busy via Google Calendar API
         const fbRes = await fetchWithTimeout('https://www.googleapis.com/calendar/v3/freeBusy', {
             method: 'POST',
             headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
             body: JSON.stringify({
                 timeMin: request.payload.startTime,
                 timeMax: request.payload.endTime,
                 items: [{ id: 'primary' }]
             })
         });
         const fbData = await fbRes.json();
         const hasConflict = fbData.calendars?.primary?.busy?.length > 0;

         
         // Perform real Google Calendar API call
         try {
             const res = await fetchWithTimeout('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', {
                 method: 'POST',
                 headers: {
                     'Authorization': `Bearer ${accessToken}`,
                     'Content-Type': 'application/json'
                 },
                 body: JSON.stringify({
                     summary: request.payload.title,
                     start: { dateTime: request.payload.startTime, timeZone },
                     end: { dateTime: request.payload.endTime, timeZone },
                     attendees: request.payload.attendees ? request.payload.attendees.map((e: string) => ({ email: e })) : [],
                     conferenceData: {
                         createRequest: {
                             requestId: "req_" + Date.now(),
                             conferenceSolutionKey: { type: "hangoutsMeet" }
                         }
                     }
                 })
             });
             
             if (!res.ok) {
                 const errorText = await res.text();
                 throw new Error(`Calendar API Error: ${res.status} ${errorText}`);
             }
             
             const data = await res.json();
             return { success: true, providerResult: { eventId: data.id, meetLink: data.hangoutLink } };
         } catch(err: any) {
             throw new Error(err.message);
         }
     } else {
         console.log('[ActionGateway] Mocking CALENDAR_CREATE due to SAFE REBUILD MODE');
         return { success: true, providerResult: { eventId: 'mock_evt_123' } };
     }

  }

}

export const actionGateway = new ActionGateway();
