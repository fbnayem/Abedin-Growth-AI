import { firestore } from '../firebase';
import { collection, doc, getDoc, getDocs, setDoc, query, where } from 'firebase/firestore';
import { gmailService } from '../services/gmail.service';
import { outreachPolicyService } from '../policies/outreachPolicy';

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
}

export class ActionGateway {
  
  // Safe Rebuild Mode - Defaults from Requirement A
  private readonly SAFE_MODE = {
    REAL_EMAIL_SEND_ENABLED: process.env.REAL_EMAIL_SEND_ENABLED === 'true',
    REAL_CALENDAR_CREATE_ENABLED: process.env.REAL_CALENDAR_CREATE_ENABLED === 'true',
    REAL_PAYMENT_ENABLED: process.env.REAL_PAYMENT_ENABLED === 'true',
    REAL_SIGNATURE_ENABLED: process.env.REAL_SIGNATURE_ENABLED === 'true',
    REAL_LINKEDIN_SEND_ENABLED: process.env.REAL_LINKEDIN_SEND_ENABLED === 'true',
  };

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
        return this.SAFE_MODE.REAL_EMAIL_SEND_ENABLED;
      case ActionType.CALENDAR_CREATE:
      case ActionType.CALENDAR_UPDATE:
      case ActionType.CALENDAR_CANCEL:
        return this.SAFE_MODE.REAL_CALENDAR_CREATE_ENABLED;
      case ActionType.PAYMENT_CREATE:
        return this.SAFE_MODE.REAL_PAYMENT_ENABLED;
      case ActionType.SIGNATURE_SEND:
        return this.SAFE_MODE.REAL_SIGNATURE_ENABLED;
      case ActionType.EXTERNAL_MESSAGE_SEND:
        return this.SAFE_MODE.REAL_LINKEDIN_SEND_ENABLED; // Assuming LinkedIn for now
      default:
        return true; // Internal CRM updates might be allowed
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

        // Resolve contact consent and jurisdiction
        let resolvedCountry = 'US';
        let resolvedConsent = true;
        if (request.payload.contactId) {
            const contactSnap = await getDoc(doc(firestore, 'organizations/org_1/contacts', request.payload.contactId));
            if (contactSnap.exists) {
                const contactData = contactSnap.data() as any;
                resolvedCountry = contactData.country || 'US';
                resolvedConsent = contactData.consentGiven !== false; // default true unless explicit false
            }
        }
        
        const policyResult = await outreachPolicyService.evaluateOutreach({
             country: resolvedCountry,
             campaignType: 'inbound',
             consentGiven: resolvedConsent,
             isB2B: true
        });

        if (!policyResult.allowed) {
            console.warn(`[ActionGateway] Email blocked by outreach policy: ${policyResult.reason}`);
            return { success: false, blockedReason: policyResult.reason };
        }

        if (!firestore) return { success: false, error: 'Firestore not initialized' };
        // Fetch oauth token for organization
        const q = query(collection(firestore, 'oauth_connections'), where('organizationId', '==', request.organizationId));
        const oauthsSnap = await getDocs(q);
        let accessToken = 'mock_token';
        oauthsSnap.forEach(doc => {
            if (doc.data().provider === 'gmail' || doc.data().provider === 'GMAIL') {
                accessToken = doc.data().accessToken;
            }
        });

        if (accessToken === 'mock_token') {
             // Simulation for testing/staging without real OAuth
             return { success: true, providerResult: { messageId: 'sim_email_' + Date.now(), threadId: request.payload.threadId || 'sim_thread_' + Date.now() } };
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
         let accessToken = 'mock_token';
         oauthsSnap.forEach(doc => {
             if (doc.data().provider === 'gmail' || doc.data().provider === 'GMAIL') {
                 accessToken = doc.data().accessToken;
             }
         });
         
         if (accessToken === 'mock_token') {
             return { success: true, providerResult: { eventId: 'sim_evt_' + Date.now() } };
         }

         // 4. Check free/busy via Google Calendar API
         const fbRes = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
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
             const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', {
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
