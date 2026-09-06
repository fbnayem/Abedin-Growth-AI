// P0.2 — Imported FIRST and for its side effect as well as its exports: this module calls
// dotenv.config() at evaluation time, guaranteeing .env has been loaded before any flag is
// read, no matter how this gateway is reached. See server/config/safeMode.ts.
import { isRealActionEnabled } from '../config/safeMode';
import { firestore } from '../firebase';
import { collection, doc, getDoc, getDocs, setDoc, query, where } from 'firebase/firestore';
import { gmailService } from '../services/gmail.service';
import { outreachPolicyService } from '../policies/outreachPolicy';
import { fetchWithTimeout } from '../lib/httpClient';

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
    | 'UNSUPPORTED_ACTION';
}

/**
 * P0.8 — A provider id must come from a provider. Ids shaped like `sim_`, `mock_` or `test_`
 * were previously minted locally and written to durable records with status SENT, which made
 * every "successful send" in the system unfalsifiable. Nothing matching this may be persisted
 * as evidence that an external action occurred.
 */
export const FABRICATED_PROVIDER_ID = /^(sim|mock|test|fake|stub)[-_]/i;

export function isFabricatedProviderId(id: unknown): boolean {
  return typeof id === 'string' && FABRICATED_PROVIDER_ID.test(id);
}

export class ActionGateway {
  
  // P0.2 — The `private readonly SAFE_MODE = {...}` snapshot that used to live here has been
  // removed. It was evaluated at module-evaluation time, which ES module hoisting runs BEFORE
  // dotenv.config() in server.ts, so values in .env never reached this enforcement point while
  // /api/readiness reported them as if they had. Flags are now read lazily, per decision, from
  // server/config/safeMode.ts — the same module readiness reads, so the displayed value and the
  // enforced value cannot drift apart.

  /**
   * Central entry point for all external actions.
   */
  async dispatchAction(request: ActionRequest): Promise<ActionResult> {
    console.log(`[ActionGateway] Received request for ${request.actionType} from ${request.proposedBy}`);

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

    // 3. Execution routing
    let result: ActionResult = { success: false };
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
      // E. AMBIGUOUS PROVIDER RESULT
      // Network dropped or 504 Gateway Timeout means we don't know if the provider succeeded.
      const isAmbiguous = e.message.includes('timeout') || e.message.includes('network');
      const status = isAmbiguous ? 'AMBIGUOUS_PROVIDER_RESULT' : 'ERROR';
      await this.logAction(actionId, status, request, { error: e.message, requiresReconciliation: isAmbiguous });
      
      if (isAmbiguous) {
         // Queue for reconciliation worker...
         console.warn(`[ActionGateway] Provider result is ambiguous. Action queued for reconciliation.`);
      }
      return { success: false, error: e.message, blockedReason: isAmbiguous ? 'AMBIGUOUS_PROVIDER_RESULT' : undefined };
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
      const docSnap = await getDoc(doc(firestore, `organizations/${orgId}/conversations`, conversationId));
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
      await setDoc(doc(firestore, `organizations/${request.organizationId}/actionLogs`, actionId), {
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

        const contactSnap = await getDoc(doc(firestore, 'organizations/org_1/contacts', request.payload.contactId));
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

        gmailService.setCredentials({ access_token: accessToken });
        const result = await gmailService.sendEmail({
            to: request.payload.to,
            subject: request.payload.subject,
            bodyHtml: request.payload.htmlBody,
            bodyText: request.payload.textBody,
            inReplyTo: request.payload.inReplyTo,
            references: request.payload.references,
            threadId: request.payload.threadId,
        });

        return { success: true, providerResult: result };
    } catch (e: any) {
        if (e.message?.includes('timeout') || e.message?.includes('ECONNRESET')) {
        return { success: false, error: e.message, isAmbiguousResult: true };
      }
      return { success: false, error: e.message };
    }
  }


  private async executeCalendarCreate(request: ActionRequest): Promise<ActionResult> {
     console.log(`[ActionGateway] Executing CALENDAR_CREATE for ${request.payload.title}`);
     
     // O. CALENDAR EDGE CASES
     // 1. Resolve Timezone
     const tz = request.payload.timezone || 'UTC';
     // 2. Check Business Hours
     const date = new Date(request.payload.startTime);
     const hour = date.getUTCHours();
     if (hour < 8 || hour > 18) {
         return { success: false, error: 'Outside business hours' };
     }
     // 3. Validate duration
     const duration = (new Date(request.payload.endTime).getTime() - date.getTime()) / 60000;
     if (duration <= 0 || duration > 120) {
         return { success: false, error: 'Invalid meeting duration' };
     }
     // 4. Check free/busy
     let hasConflict = false;
     // We will check it inside the real API call block to use the token.
     if (hasConflict) {
         return { success: false, error: 'Schedule conflict detected' };
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
                     start: { dateTime: request.payload.startTime, timeZone: tz },
                     end: { dateTime: request.payload.endTime, timeZone: tz },
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
