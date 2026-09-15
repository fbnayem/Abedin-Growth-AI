// P0.2 — Imported FIRST and for its side effect as well as its exports: this module calls
// dotenv.config() at evaluation time, guaranteeing .env has been loaded before any flag is
// read, no matter how this gateway is reached. See server/config/safeMode.ts.
import { isRealActionEnabled } from '../config/safeMode';
import { store } from '../store';
import { addDoc, collection, doc, getDoc, getDocs, setDoc, query, where } from '../store';
import { auditEvent, mustCommitBefore } from '../domain/actionAudit';
import { gmailService } from '../services/gmail.service';
import { outreachPolicyService } from '../policies/outreachPolicy';
import { fetchWithTimeout } from '../lib/httpClient';
import { orgPath, isValidOrgId } from '../tenancy/orgScope';
import { classifyThrown, requiresReconciliation, type ProviderErrorKind } from '../lib/providerError';
import { FABRICATED_PROVIDER_ID, isFabricatedProviderId } from '../lib/providerId';
import { assertCapability, CapabilityError, normalizeScopes, type Capability } from '../lib/capabilities';
import { senderPostureFor } from '../services/deliverability.service';
import { domainOfAddress, posturePermitsSending } from '../domain/senderIdentity';
import { assertTimeZone, isWithinBusinessHours, parseInstant, DEFAULT_BUSINESS_HOURS, systemClock, type Clock } from '../../shared/domain/time';
import { outboundMessageId } from '../lib/messageIdentity';
import { calendarService } from '../services/calendar.service';
import {
  evaluateCampaignSafety,
  maySend,
  refusalReason,
} from '../domain/campaignSafety';
import { evaluateLawfulBasis } from '../domain/lawfulBasis';
import { resolveAssessmentForContact } from '../services/lia.service';
import { lockStateOf, mayProceed, refusalFor } from '../domain/autonomyLock';
import { unsubscribeUrlFor } from '../domain/unsubscribe';
import { replyLoopVerdict } from '../domain/replyLoop';
import { outboxService } from '../services/outbox.service';
import {
  schemaCompatibility,
  schemaPermitsIrreversibleActions,
} from '../build/schemaCompatibility';
import type { Availability } from '../providers/types';
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
  EXTERNAL_MESSAGE_SEND = 'EXTERNAL_MESSAGE_SEND',
  /**
   * The Article 14 data-subject notice.
   *
   * A SEPARATE TYPE FROM EMAIL_SEND, AND NOT A CONVENIENCE. `executeEmailSend` refuses any
   * contact whose notice has not been sent, so routing the notice through it would require the
   * lawful basis that the notice itself creates — a circular dependency with a legal shape.
   *
   * Being its own type is also what makes the difference in checks visible. This one refuses on
   * suppression and does NOT consult the lawful basis or the campaign safety guards, because it
   * is not marketing: see server/domain/article14Notice.ts for the argument on each.
   */
  PRIVACY_NOTICE_SEND = 'PRIVACY_NOTICE_SEND'
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
    | 'UNRECONCILABLE_SEND'
    /**
     * S31 — free/busy reported a definite conflict. The addendum's invariant is that this
     * produces ZERO create requests, so this code is returned instead of an event id.
     */
    | 'CALENDAR_CONFLICT'
    // S27 — the connection's domain has no SPF/DMARC, or they could not be looked up.
    | 'SENDER_IDENTITY_UNVERIFIED'
    /**
     * S31/§14 — free/busy was asked and the answer could not be read (a calendar the
     * credential cannot see returns per-calendar `errors` inside a 200). Unknown availability
     * is not availability, so no event is created.
     */
    | 'AVAILABILITY_UNKNOWN'
    /**
     * S10 — the action was refused because the audit record that must precede it could not be
     * written. Carries NO `blockedReason`: the outbox worker treats a policy block as terminal
     * ("retrying cannot change a policy decision"), and a datastore outage is transient — the send
     * has not happened, so the job must come back through backoff rather than be dead-lettered.
     */
    | 'AUDIT_UNAVAILABLE';
  /**
   * S10 — false when the action HAPPENED but the record of its outcome could not be written.
   *
   * Only ever false AFTER the side effect: a failed write before it refuses the dispatch instead.
   * Reporting failure here would retry an irreversible action (§32); reporting plain success would
   * claim a record that does not exist.
   */
  auditRecorded?: boolean;
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
    case ActionType.PRIVACY_NOTICE_SEND:
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
    case ActionType.PRIVACY_NOTICE_SEND:
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
    case ActionType.PRIVACY_NOTICE_SEND:
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
  /**
   * The next sequence number for each action's trail.
   *
   * Bounded below, because this object outlives every request in the worker: one small entry per
   * dispatch, trimmed oldest-first past a cap. A trail's ordering is the property being recorded,
   * so the number has to come from somewhere that cannot be rewritten by a concurrent dispatch.
   */
  private readonly auditSeq = new Map<string, number>();

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

    // 1. Audit logging — PROPOSED, and the dispatch does not continue without it.
    //
    // S10: this write could not fail and nothing inspected it, so a datastore outage printed one
    // line and the action proceeded. Refusing costs a retry. Proceeding costs a send nobody can
    // afterwards prove happened, to someone who can prove that it did.
    const actionId = `action_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    if (!(await this.logAction(actionId, 'PROPOSED', request))) {
      return {
        success: false,
        errorCode: 'AUDIT_UNAVAILABLE',
        error:
          'The audit record that must precede this action could not be written, so the action was ' +
          'not attempted. This is transient: retry when the datastore is reachable.',
      };
    }

    // 2. Pre-execution checks

    // S48 — THE SCHEMA MUST BE THE ONE THIS BUILD WAS WRITTEN AGAINST.
    //
    // Checked here, before anything irreversible, and only for irreversible actions. A rolling
    // deploy that puts this code on a node before the migration finishes leaves every query
    // for a new column failing at runtime; a rollback leaves this build unable to see columns
    // it does not know about, so a write silently drops fields. Reading under either is
    // recoverable. SENDING under either is not.
    //
    // UNKNOWN refuses: "we could not ask the database which migrations it has" is not "it has
    // the right ones" (§14).
    if (isIrreversible(request.actionType)) {
      const schema = await schemaCompatibility();
      if (!schemaPermitsIrreversibleActions(schema)) {
        const reason =
          `Action blocked: the database schema does not match this build (${schema.state}). ` +
          schema.detail;
        console.error(`[ActionGateway] ${reason}`);
        await this.logAction(actionId, 'BLOCKED', request, { reason, schema });
        return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
      }
    }

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
      // The last record before the side effect. Same rule as PROPOSED: no record, no dispatch.
      if (!(await this.logAction(actionId, 'DISPATCHING', request))) {
        return {
          success: false,
          errorCode: 'AUDIT_UNAVAILABLE',
          error:
            'The audit record immediately preceding dispatch could not be written, so nothing was ' +
            'dispatched. This is transient: retry when the datastore is reachable.',
        };
      }
      
      switch (request.actionType) {
        case ActionType.EMAIL_SEND:
          result = await this.executeEmailSend(request);
          break;
        case ActionType.CALENDAR_CREATE:
          result = await this.executeCalendarCreate(request);
          break;

        case ActionType.PRIVACY_NOTICE_SEND:
          result = await this.executePrivacyNoticeSend(request);
          break;

        // THE SIX THAT ARE DECLARED AND NOT IMPLEMENTED.
        //
        // They were one `default: { success: false, error: 'Unsupported action type' }`, which is
        // three separate problems. The refusal carried no `errorCode`, so the outbox worker fell to
        // its `else` branch, threw, and RETRIED — backoff after backoff, for an action type that
        // will never succeed by being attempted again. It named nothing, so an operator reading the
        // queue could not tell which type was unsupported. And `isIrreversible`, `providerFor` and
        // `capabilityFor` all carry full branches for these six, so the gateway reads as though it
        // supports them; only this switch says otherwise, and it said it in five words.
        //
        // Nothing dispatches them today — `EMAIL_SEND` from the outbox worker and `CALENDAR_CREATE`
        // from POST /api/meetings are the only two dispatch sites in the repository — so this
        // changes no live path. It changes what happens the day somebody adds a third.
        case ActionType.CALENDAR_UPDATE:
        case ActionType.CALENDAR_CANCEL:
        case ActionType.PAYMENT_CREATE:
        case ActionType.SIGNATURE_SEND:
        case ActionType.CRM_UPDATE:
        case ActionType.EXTERNAL_MESSAGE_SEND:
          result = {
            success: false,
            errorCode: 'UNSUPPORTED_ACTION',
            error:
              `${request.actionType} is declared on the gateway and has no implementation, so ` +
              'nothing was attempted. Retrying cannot change that: it needs an executor, not ' +
              'another attempt.',
          };
          break;

        default: {
          // A NEW ActionType reaches here only if nobody classified it. `never` makes that a
          // COMPILE error rather than a runtime message — which is the difference between finding
          // out while adding the type and finding out from a queue full of retries.
          const unclassified: never = request.actionType;
          result = {
            success: false,
            errorCode: 'UNSUPPORTED_ACTION',
            error: `Unclassified action type: ${String(unclassified)}.`,
          };
        }
      }

      // AFTER the side effect, so this may not change the verdict: reporting failure because the
      // LOG failed would send the message a second time (§32). The result carries the gap instead.
      const recorded = await this.logAction(
        actionId,
        result.success ? 'SUCCESS' : 'FAILED',
        request,
        result
      );
      return recorded ? result : { ...result, auditRecorded: false };
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
    if (!store) {
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
          collection(store, 'oauth_connections'),
          where('organizationId', '==', request.organizationId)
        )
      );
      // Collected rather than assigned inside the closure: control flow cannot see an assignment
      // made in a callback, so a `let` here narrowed to `never` after the null check below.
      const found: { provider: string; organizationId: string; scopes: string[] | null; status: string | null; expiresAt: any; accountEmail: string | null }[] = [];
      snap.forEach((d) => {
        const data: any = d.data();
        const isGoogle = String(data.provider ?? '').toLowerCase() === 'gmail';
        if (!isGoogle) return;
        found.push({
          provider,
          organizationId: request.organizationId,
          scopes: normalizeScopes(data.scopes ?? data.scope),
          status: data.status ?? null,
          expiresAt: data.expiresAt?.toDate?.() ?? data.expiresAt ?? null,
          accountEmail: typeof data.accountEmail === 'string' ? data.accountEmail : null,
        });
      });
      // The last Gmail connection wins, as it always did.
      const connection = found.length > 0 ? found[found.length - 1] : null;

      if (connection === null) {
        return {
          success: false,
          errorCode: 'PROVIDER_NOT_CONFIGURED',
          error: `No ${provider} connection is configured for this organization.`,
        };
      }

      assertCapability(connection, capability, new Date());

      // S27 — SENDER IDENTITY, AFTER THE SCOPES AND BEFORE THE NETWORK.
      //
      // A connection may hold the send scope and still send from a domain no receiver can
      // authenticate. The domain judged is this connection's account — the settings address
      // reaches only prompts. MISSING is refused; UNKNOWN (the records could not be looked
      // up) is refused too, because unknown is not permission (§14); WEAK proceeds with a
      // warning. GET /api/deliverability shows the same verdict with its reasons.
      if (request.actionType === ActionType.EMAIL_SEND) {
        const refusal = await this.checkSenderIdentity(connection.accountEmail);
        if (refusal !== null) return refusal;
      }
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

  /** Null when the sending domain may be believed, or the refusal to return. */
  private async checkSenderIdentity(accountEmail: string | null): Promise<ActionResult | null> {
    const domain = domainOfAddress(accountEmail);
    if (domain === null) {
      const reason =
        'The connected Gmail account has no usable domain, so its sender identity cannot be checked. Refusing to send.';
      console.warn(`[ActionGateway] EMAIL_SEND refused: ${reason}`);
      return { success: false, errorCode: 'SENDER_IDENTITY_UNVERIFIED', error: reason };
    }
    let identity: Awaited<ReturnType<typeof senderPostureFor>>;
    try {
      identity = await senderPostureFor(domain);
    } catch (e: any) {
      const reason = `Sender identity for ${domain} could not be checked (${String(e?.message ?? e)}). Refusing to send.`;
      console.warn(`[ActionGateway] EMAIL_SEND refused: ${reason}`);
      return { success: false, errorCode: 'SENDER_IDENTITY_UNVERIFIED', error: reason };
    }
    if (!posturePermitsSending(identity.posture)) {
      const reason =
        `Sender identity for ${domain} is ${identity.posture.verdict}: ${identity.posture.reasons.join('; ')}. ` +
        'See GET /api/deliverability.';
      console.warn(`[ActionGateway] EMAIL_SEND refused: ${reason}`);
      return { success: false, errorCode: 'SENDER_IDENTITY_UNVERIFIED', error: reason };
    }
    if (identity.posture.verdict === 'WEAK') {
      console.warn(`[ActionGateway] Sender identity for ${domain} is WEAK: ${identity.posture.reasons.join('; ')}`);
    }
    return null;
  }

  private checkFeatureFlag(actionType: ActionType): boolean {
    switch (actionType) {
      case ActionType.EMAIL_SEND:
      // The notice is a real email to a real person and is gated by the same flag. It is NOT
      // given a flag of its own: a second switch that could be on while sending was off would
      // mean "this system cannot email anyone" had two answers, and the seven-flag readiness
      // report exists so that question has one.
      case ActionType.PRIVACY_NOTICE_SEND:
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

  /**
   * True when autonomy is LOCKED for this conversation and the send must not proceed.
   *
   * Every branch that used to answer "not locked" on an unknown state now answers locked.
   * `if (!store) return false` said a missing datastore meant no human had taken the
   * conversation; a missing document said the same. Neither was a reading — both were the
   * absence of one, and §14 forbids resolving that to permission. `lockStateOf` is the single
   * place that decides, so this and the worker can no longer disagree: the worker honoured
   * `status === 'AUTONOMY_PAUSED_BY_HUMAN'` and this did not, so a conversation paused by
   * status was stopped there and permitted here.
   */
  private async checkHumanOwnershipLock(orgId: string, conversationId: string): Promise<boolean> {
    try {
      // No datastore and no document are THE SAME FACT — we could not read — so they take the
      // same path rather than an early `return false` that says "nobody has paused this".
      // Written this way deliberately: a literal `return true` here would be correct and
      // untested, and a mutation of it survived the whole gate once. There is no branch left
      // to mutate; `lockStateOf` decides, and it is covered.
      const docSnap = store
        ? await getDoc(doc(store, orgPath(orgId, 'conversations'), conversationId))
        : null;
      const state = lockStateOf(docSnap?.exists() ?? false, docSnap?.data());
      if (mayProceed(state)) return false;
      console.warn(`[ActionGateway] ${refusalFor(state, conversationId)}`);
      return true;
    } catch (e) {
      console.error('Error checking human ownership lock:', e);
      return true; // Fail closed
    }
  }

  /**
   * Append one immutable event to this action's trail. Returns whether it committed.
   *
   * S10 — this returned `void`, so `await this.logAction(...)` was a statement whose outcome no
   * caller could inspect:
   *
   *     if (!store) return;
   *     try { await setDoc(doc(store, orgPath(org, 'actionLogs'), actionId), {...}, { merge: true }); }
   *     catch (e) { console.error("[ActionGateway] Failed to audit log action:", e); }
   *
   * Two defects in six lines. A datastore that was briefly unavailable printed one line and the
   * irreversible action proceeded — the inversion §10 exists to prevent. And every status merged
   * onto ONE document id, so DISPATCHING overwrote PROPOSED and SUCCESS overwrote both: what
   * survived was the last status, never the sequence, and the sequence is what a trail is.
   *
   * `addDoc` mints a fresh id per event, so a write can only add. The decisions — what is
   * fingerprinted, which statuses must commit before proceeding, how a result is made storable —
   * live in server/domain/actionAudit.ts, where a test reaches them without a datastore.
   */
  private async logAction(
    actionId: string,
    status: string,
    request: ActionRequest,
    resultDetails?: any
  ): Promise<boolean> {
    const seq = (this.auditSeq.get(actionId) ?? -1) + 1;
    this.auditSeq.set(actionId, seq);
    if (this.auditSeq.size > 5_000) {
      for (const key of this.auditSeq.keys()) {
        this.auditSeq.delete(key);
        if (this.auditSeq.size <= 4_000) break;
      }
    }

    try {
      // No `if (!store) return`. An unconfigured datastore is exactly the condition under which
      // the old code let an irreversible action through, so it takes the same path as a failure.
      if (!store) throw new Error('the datastore is not configured');
      await addDoc(
        collection(store, orgPath(request.organizationId, 'actionLogs')),
        auditEvent({
          actionId,
          seq,
          status,
          actionType: request.actionType,
          organizationId: request.organizationId,
          targetId: request.targetId,
          conversationId: request.conversationId ?? null,
          proposedBy: request.proposedBy,
          provider: providerFor(request.actionType),
          idempotencyKey: request.payload?.idempotencyKey,
          payload: request.payload,
          resultDetails,
          at: this.clock.now().getTime(),
        })
      );
      return true;
    } catch (e) {
      console.error(
        `[ActionGateway] Audit write FAILED for ${actionId} (${status}). ` +
          (mustCommitBefore(status)
            ? 'It precedes the side effect, so the action is refused.'
            : 'The action has already happened; recording that its trail is incomplete.'),
        e
      );
      return false;
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
          doc(store, orgPath(request.organizationId, 'contacts'), request.payload.contactId)
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

        // LAWFUL BASIS (§14). These two checks were `contactData.consentGiven !== true` and an
        // inline ISO-code test. Both are still enforced and both still fail closed; they have
        // moved into `server/domain/lawfulBasis.ts` so the decision can be exercised
        // exhaustively without a datastore, which an inline check in a provider method cannot
        // be.
        //
        // What changed is not the strictness but the vocabulary. The old gate asked only
        // "is consentGiven exactly true", and NOTHING IN THIS SYSTEM COULD EVER SET IT: the
        // create schema refuses the field as mass assignment, the document builder never
        // writes it, and the only other writer copies an existing true between records during
        // a merge. Every lead was therefore permanently unmailable. The gate now recognises a
        // second basis — legitimate interest for business recipients — which carries four
        // conditions of its own, and still refuses everything it cannot prove.
        // `requireReviewedRegime` is the country table's own sign-off, and it is tied to the
        // send flag rather than to the environment. Every row in that table is unreviewed today,
        // so passing `true` unconditionally would make the whole system unmailable in
        // development and the pressure would be to forge a sign-off to get moving. Tied here,
        // the check costs nothing until somebody turns real sending on — and at that moment an
        // unchecked jurisdiction stops, which is the failure worth catching.
        //
        // The assessment is RESOLVED, not trusted. `liaId` used to satisfy the gate by being a
        // non-empty string, so `x` was a balancing assessment. When real sending is on it must
        // now name a stored document that is signed, unwithdrawn, in date, and covering both
        // this contact's country AND the route by which this contact was obtained. The lookup
        // happens here because `evaluateLawfulBasis` is pure and stays pure; passing the verdict
        // in keeps the decision exercisable without a database.
        //
        // `source` is passed for the second half of that. Country coverage alone treated two
        // assessments covering `GB` as interchangeable, so a contact identified on LinkedIn
        // could cite the assessment written about addresses published on company websites — two
        // materially different balancing arguments, and the gate could not tell them apart.
        const strict = isRealActionEnabled('REAL_EMAIL_SEND_ENABLED');
        const assessment = strict
            ? await resolveAssessmentForContact(request.organizationId, contactData.liaId, {
                  country:
                      typeof contactData.country === 'string' ? contactData.country.trim().toUpperCase() : '',
                  source: contactData.source,
              })
            : undefined;

        const basis = evaluateLawfulBasis(contactData, {
            requireReviewedRegime: strict,
            requireSignedAssessment: strict,
            assessment,
        });
        if (basis.ok === false) {
            const reason =
                `No lawful basis to email contact ${request.payload.contactId} ` +
                `(${basis.code}). ${basis.message}`;
            console.warn(`[ActionGateway] ${reason}`);
            return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
        }
        const rawCountry = basis.country;

        const policyResult = await outreachPolicyService.evaluateOutreach({
             country: rawCountry,
             campaignType: request.payload.campaignType || 'inbound',
             // Was the literal `true`, which was honest while consent was the only basis that
             // could reach this line. It no longer is: a legitimate-interest recipient has a
             // lawful basis and has NOT consented, and telling the policy otherwise would
             // hide exactly the distinction it exists to judge.
             consentGiven: basis.basis === 'CONSENT',
             // Was hardcoded `true`. B2B status materially changes the legal basis under
             // PECR/GDPR, so it must come from the record and default to the stricter B2C.
             isB2B: contactData.isB2B === true,
        });

        if (!policyResult.allowed) {
            console.warn(`[ActionGateway] Email blocked by outreach policy: ${policyResult.reason}`);
            return { success: false, blockedReason: policyResult.reason, errorCode: 'POLICY_BLOCKED' };
        }

        // S26 — THE FOURTEEN CAMPAIGN GUARDS.
        //
        // This gateway implemented a feature flag, an ownership lock, a jurisdiction call and —
        // since P0.10 — suppression and consent. It implemented none of: frequency cap,
        // cooldown, quiet hours, daily recipient limit, per-domain limit, duplicate or
        // conflicting campaign membership, active conversation, pending human reply, wrong
        // person, or existing customer.
        //
        // S26 calls those "moot for want of a send loop", which is true of the campaign
        // scheduler and not of this function: every autonomous send already passes through
        // here.
        //
        // A guard whose input is missing is NOT_RUN, and NOT_RUN REFUSES. There is nothing
        // downstream of this to defer to, so an unknown condition cannot resolve to permission
        // (§14): "we could not tell whether it is 3am for this recipient" is not "it is not
        // 3am".
        //
        // The consequence is deliberate. With the data this system currently holds — no
        // campaign membership, no per-organisation daily counters, no recipient timezone —
        // several guards cannot run and autonomous sending is REFUSED. Nothing that works today
        // stops working: REAL_EMAIL_SEND_ENABLED is false and this system has never sent an
        // autonomous email. What changes is that it will not silently begin sending unguarded
        // when that flag is flipped.
        const safety = evaluateCampaignSafety({
            suppressed: contactData.suppressed === true,
            hardBounced: contactData.hardBounced === true,
            complained: contactData.complained === true,
            wrongPerson: contactData.wrongPerson === true,
            // Read as a tri-state: a record that does not say is not a record that says no.
            isExistingCustomer:
                typeof contactData.isExistingCustomer === 'boolean'
                    ? contactData.isExistingCustomer
                    : undefined,
            hasActiveConversation:
                typeof contactData.hasActiveConversation === 'boolean'
                    ? contactData.hasActiveConversation
                    : undefined,
            hasPendingHumanReply:
                typeof contactData.hasPendingHumanReply === 'boolean'
                    ? contactData.hasPendingHumanReply
                    : undefined,
            // Not loaded: there is no per-contact send history query on this path yet, and
            // claiming it was loaded to make the guard pass is the defect this replaces.
            contactHistoryLoaded: false,
            campaignMembershipLoaded: false,
            recipientsToday: undefined,
            sendsToThisDomainToday: undefined,
            recipientLocalHour: undefined,
        });

        if (maySend(safety) === false) {
            const reason =
                `Campaign safety refused this send. ${refusalReason(safety)}` +
                (safety.notRun.length > 0
                    ? ` | ${safety.notRun.length} guard(s) could not run: ${safety.notRun.join(', ')}`
                    : '');
            console.warn(`[ActionGateway] ${reason}`);
            return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
        }

        if (!store) return { success: false, error: 'Datastore not initialized' };
        // Fetch oauth token for organization
        const q = query(collection(store, 'oauth_connections'), where('organizationId', '==', request.organizationId));
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
                // Narrowed rather than cast. Under the Firestore SDK this was `any`, so a
                // token stored as a number or an object was assigned here and then compared
                // against the string 'mock_token' — a comparison that could never match, on a
                // value that could never work. A non-string credential is no credential.
                accessToken = typeof d.accessToken === 'string' ? d.accessToken : null;
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

        // S28 — THE REPLY LOOP THAT NO HEADER WOULD HAVE REVEALED.
        //
        // `automatedMail.classifyAutomation` refuses to reply to anything carrying an
        // automation marker, and deliberately never reads subject prose — matching "Out of
        // Office" is the substring classification this repository has a guardrail against, and
        // it does not survive an autoresponder writing in another language.
        //
        // Which leaves the case the status document names: an out-of-office that sets no
        // `Auto-Submitted`, no `X-Autoreply` and no `Precedence`, sent from a personal address,
        // is indistinguishable from a person. There is no header to add; the evidence is not in
        // the message.
        //
        // RFC 3834 §2.1 answers this with a rate limit rather than a better classifier, for
        // the same reason. Two machines answering each other is the harm, and a counter stops
        // it whatever either message looked like.
        //
        // The history is NULL when it could not be read, and null refuses. `listByStatus`
        // returns `[]` on failure — correct for drawing a console, an inversion here.
        //
        // A send with no conversation cannot be loop-checked at all, so it is refused rather
        // than exempted. Every EMAIL_SEND this system produces carries one — `outbox.worker`
        // sets it from `job.conversationId` — so this refuses a caller that does not, rather
        // than a path that exists.
        if (!request.conversationId) {
            const reason =
                'EMAIL_SEND requires a conversationId so the reply-loop budget can be checked. ' +
                'Refusing rather than sending a reply that could not be counted.';
            console.warn(`[ActionGateway] ${reason}`);
            return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
        }
        const replyHistory = await outboxService.replyTimesForConversation(
            request.organizationId,
            request.conversationId
        );
        const loop = replyLoopVerdict({ history: replyHistory, now: Date.now() });
        if (loop.allowed === false) {
            console.warn(`[ActionGateway] EMAIL_SEND refused (${loop.code}): ${loop.reason}`);
            return { success: false, blockedReason: loop.reason, errorCode: 'POLICY_BLOCKED' };
        }

        // S26 — NO UNSUBSCRIBE URL, NO SEND.
        //
        // `checkOutreachPolicy` already refuses when `contactData.unsubscribed === true`. Until
        // now there was no way for a recipient to make that true: `List-Unsubscribe` appeared
        // in this repository only on the INBOUND side, where `automatedMail.ts` reads it to
        // decide that somebody ELSE'S mail is bulk. The suppression check was real and the
        // control feeding it did not exist.
        //
        // Refusing here rather than sending without the header is the same shape as every
        // other §14 decision in this file: the permissive reading of "we could not build an
        // opt-out" is to mail somebody who then has no way to stop us, and that is the reading
        // that fails silently — the send succeeds and nothing reports the absence.
        const unsubscribe = unsubscribeUrlFor({
            orgId: request.organizationId,
            contactId: request.payload.contactId,
        });
        if (unsubscribe.ok === false) {
            console.warn(`[ActionGateway] EMAIL_SEND refused: ${unsubscribe.reason}`);
            return { success: false, blockedReason: unsubscribe.reason, errorCode: 'POLICY_BLOCKED' };
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
            unsubscribeUrl: unsubscribe.url,
        });

        return { success: true, providerResult: result };
    } catch (e: any) {
      // The same broken substring test lived here too, and missed the same errors. Rethrowing
      // a classified error lets the one classifier in dispatchAction make the §32 decision,
      // rather than two call sites each deciding it slightly differently.
      throw classifyThrown(e, { provider: "gmail", operation: "EMAIL_SEND" });
    }
  }


  /**
   * THE ARTICLE 14 NOTICE.
   *
   * The message that tells somebody we hold their data and where we got it. It is the thing
   * `recordArticle14Notice` used to record without anything ever having sent it.
   *
   * WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT
   * ---------------------------------------------------
   * It does NOT call `evaluateLawfulBasis`. That is not an oversight and it is the whole reason
   * this is a separate action type: the marketing gate refuses a contact whose notice has not
   * been sent, so a notice that required a lawful basis could never be the message that
   * establishes one.
   *
   * It does NOT run `evaluateCampaignSafety`. Frequency caps, quiet hours and daily recipient
   * limits govern marketing volume. This is a legal notice, sent at most once per person for
   * the life of the record, and the obligation it discharges has a deadline measured in weeks.
   * Deferring it to business hours would trade a real duty against a courtesy.
   *
   * It DOES check suppression, first and before anything else. Somebody who has unsubscribed,
   * complained, or whose address hard-bounced has either told us to stop or cannot receive it.
   * A duty to inform does not override a person having said go away; that duty is then met by
   * deleting the record, which for a lead nobody may contact is usually the honest answer.
   *
   * It DOES require the notice to have been built already. The body is assembled by
   * `buildArticle14Notice` from the controller settings, the signed assessment and the
   * contact's own provenance, and it refuses when any of those is missing. Composing it here
   * would put a compliance document inside a dispatch method, where the next person to edit it
   * will not know which lines are load-bearing.
   */
  private async executePrivacyNoticeSend(request: ActionRequest): Promise<ActionResult> {
    console.log(`[ActionGateway] Executing PRIVACY_NOTICE_SEND to ${request.payload.to}`);
    try {
      if (!store) return { success: false, error: 'Datastore not initialized' };

      if (!request.payload.contactId) {
        const reason =
          'PRIVACY_NOTICE_SEND requires an explicit contactId so suppression can be checked and ' +
          'so the notice can be recorded against the record it concerns.';
        console.warn(`[ActionGateway] ${reason}`);
        return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
      }

      const contactSnap = await getDoc(
        doc(store, orgPath(request.organizationId, 'contacts'), request.payload.contactId)
      );
      if (!contactSnap.exists()) {
        const reason =
          `Contact ${request.payload.contactId} not found. Refusing to send a notice about a ` +
          `record that does not exist in this organisation.`;
        console.warn(`[ActionGateway] ${reason}`);
        return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
      }
      // `Record<string, unknown>`, not `as any`. Every field below is compared against a
      // literal or read through a `typeof` narrow, so nothing here needs the compiler switched
      // off — and the one field that is interpolated into a message is length-checked first.
      // The ordinary send path above still carries an `as any` from before this rule existed;
      // this path does not need to inherit it.
      const contactData = (contactSnap.data() ?? {}) as Record<string, unknown>;

      const suppressionFlags = [
        contactData.suppressed === true ? 'SUPPRESSED' : null,
        contactData.unsubscribed === true ? 'UNSUBSCRIBED' : null,
        contactData.hardBounced === true ? 'HARD_BOUNCE' : null,
        contactData.complained === true ? 'SPAM_COMPLAINT' : null,
        contactData.emailStatus === 'BOUNCED' ? 'BOUNCED' : null,
      ].filter(Boolean);
      if (suppressionFlags.length > 0) {
        const reason =
          `Recipient is suppressed (${suppressionFlags.join(', ')}), so the notice is refused ` +
          `too. A duty to inform does not override somebody having told us to stop; discharge ` +
          `it by deleting the record instead.`;
        console.warn(`[ActionGateway] ${reason}`);
        return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
      }

      // Already sent. Checked here as well as in the calling service, because this is the point
      // past which the message actually leaves: a race between two batches that both read the
      // contact as un-noticed must not become two notices.
      if (typeof contactData.article14NoticeSentAt === 'string' && contactData.article14NoticeSentAt.trim() !== '') {
        const reason =
          `A notice was already sent to this contact at ${contactData.article14NoticeSentAt}. ` +
          `The obligation is to tell someone once; sending again would be noise, and moving the ` +
          `date forward would erase the evidence of when it was actually discharged.`;
        console.warn(`[ActionGateway] ${reason}`);
        return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
      }

      const to = typeof request.payload.to === 'string' ? request.payload.to.trim() : '';
      const subject = typeof request.payload.subject === 'string' ? request.payload.subject.trim() : '';
      const textBody = typeof request.payload.textBody === 'string' ? request.payload.textBody : '';
      const htmlBody = typeof request.payload.htmlBody === 'string' ? request.payload.htmlBody : '';
      // TRIMMED for the emptiness test, not for sending. An earlier version compared against
      // `''` without trimming, so a body of three spaces was a notice — found by the test
      // below, which is the point of exercising this rather than reading it.
      if (to === '' || subject === '' || textBody.trim() === '' || htmlBody.trim() === '') {
        const reason =
          'The notice body was not supplied. It is assembled by buildArticle14Notice from the ' +
          'controller settings, the signed assessment and the contact provenance, and an empty ' +
          'one means one of those was missing — which is a refusal, not a blank line in a legal ' +
          'notice.';
        console.warn(`[ActionGateway] ${reason}`);
        return { success: false, blockedReason: reason, errorCode: 'POLICY_BLOCKED' };
      }

      const q = query(
        collection(store, 'oauth_connections'),
        where('organizationId', '==', request.organizationId)
      );
      const oauthsSnap = await getDocs(q);
      let accessToken: string | null = null;
      oauthsSnap.forEach((d) => {
        const data = d.data();
        if (data.provider === 'gmail' || data.provider === 'GMAIL') {
          accessToken = typeof data.accessToken === 'string' ? data.accessToken : null;
        }
      });
      if (!accessToken || isFabricatedProviderId(accessToken) || accessToken === 'mock_token') {
        const reason =
          'No usable Gmail credential is configured for this organization. Refusing to report a ' +
          'notice that did not go out — that record is the precondition for mailing this person.';
        console.warn(`[ActionGateway] PRIVACY_NOTICE_SEND refused: ${reason}`);
        return { success: false, error: reason, errorCode: 'PROVIDER_NOT_CONFIGURED' };
      }

      // S32 — the same determinism requirement as EMAIL_SEND, for the same reason. The notice
      // is irreversible, so the ambiguous case has to be answerable afterwards, and it can only
      // be answered if the message carries an id derived from the job rather than from a clock.
      let rfc822MessageId: string;
      try {
        rfc822MessageId = outboundMessageId(
          request.payload.idempotencyKey,
          process.env.OUTBOUND_MESSAGE_ID_DOMAIN
        );
      } catch (e: any) {
        const reason = String(e?.message ?? e);
        console.warn(`[ActionGateway] PRIVACY_NOTICE_SEND refused: ${reason}`);
        return { success: false, error: reason, errorCode: 'UNRECONCILABLE_SEND' };
      }

      // An unsubscribe route on a privacy notice, deliberately. The notice tells people they
      // can object, and a message that says so while offering no mechanical way to do it is the
      // shape of compliance theatre this repository keeps deleting. It is also what makes the
      // suppression check above reachable for somebody who had never been contacted before.
      const unsubscribe = unsubscribeUrlFor({
        orgId: request.organizationId,
        contactId: request.payload.contactId,
      });
      if (unsubscribe.ok === false) {
        console.warn(`[ActionGateway] PRIVACY_NOTICE_SEND refused: ${unsubscribe.reason}`);
        return { success: false, blockedReason: unsubscribe.reason, errorCode: 'POLICY_BLOCKED' };
      }

      gmailService.setCredentials({ access_token: accessToken });
      const result = await gmailService.sendEmail({
        to,
        subject,
        bodyHtml: htmlBody,
        bodyText: textBody,
        rfc822MessageId,
        unsubscribeUrl: unsubscribe.url,
      });

      return { success: true, providerResult: result };
    } catch (e: any) {
      throw classifyThrown(e, { provider: 'gmail', operation: 'PRIVACY_NOTICE_SEND' });
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

     
     // S41/S31 — this whole block used to be inline HTTP against Google with a second
     // reading of the same feature flag, and it contained the defect §31 exists to name:
     //
     //     const fbData = await fbRes.json();                         // no res.ok check
     //     const hasConflict = fbData.calendars?.primary?.busy?.length > 0;
     //     ... // hasConflict is never read again; the event is created regardless
     //
     // The free/busy call was made, parsed, and the answer discarded. And because there was
     // no `res.ok` check, a 401 body parses to `{}`, so even had the answer been read it
     // would have said `false` — free — for every failed lookup.
     //
     // The flag is not re-read here either. `checkFeatureFlag` already gated this dispatch
     // through `isRealActionEnabled`; a second gate reading `process.env` directly is exactly
     // the P0.2 defect (two readers of one flag, disagreeing about when it was loaded), and
     // its `else` branch returned `{ success: true, providerResult: { eventId: 'mock_evt_123' } }`
     // — a fabricated success for an irreversible external action.
     const accessToken = await this.findGoogleAccessToken(request.organizationId);
     if (accessToken === null) {
         const reason =
             'No usable Google credential is configured for this organization. ' +
             'Refusing to report a calendar event that was never created.';
         console.warn(`[ActionGateway] CALENDAR_CREATE refused: ${reason}`);
         return { success: false, error: reason, errorCode: 'PROVIDER_NOT_CONFIGURED' };
     }

     calendarService.setCredentials({ access_token: accessToken });

     // §31 — the invariant. Availability is established BEFORE any create request, and the
     // answer is read. Anything other than a definite FREE returns here, so the number of
     // create requests issued against a busy or unreadable slot is zero.
     let availability: { availability: Availability; reason: string };
     try {
       availability = await calendarService.checkAvailability({
         startAtUtc: startInstant.toISOString(),
         endAtUtc: endInstant.toISOString(),
         timeZone,
         attendees: Array.isArray(request.payload.attendees) ? request.payload.attendees : [],
       });
     } catch (e) {
       // A failed free/busy READ is not an ambiguous WRITE. Nothing was created, so this must
       // not reach the §32 reconciliation path and be recorded as 'this may have happened'.
       const classified = classifyThrown(e, {
         provider: 'google-calendar',
         operation: 'checkAvailability',
       });
       const reason =
         `Availability could not be checked (${classified.kind}: ${classified.signal}). ` +
         'No event was created: an unchecked slot is not a free slot.';
       console.warn(`[ActionGateway] CALENDAR_CREATE refused: ${reason}`);
       return { success: false, error: reason, errorCode: 'AVAILABILITY_UNKNOWN', errorKind: classified.kind };
     }

     if (availability.availability === 'BUSY') {
       const reason = `Schedule conflict. ${availability.reason} No create request was issued.`;
       console.warn(`[ActionGateway] CALENDAR_CREATE refused: ${reason}`);
       return { success: false, blockedReason: reason, error: reason, errorCode: 'CALENDAR_CONFLICT' };
     }
     if (availability.availability !== 'FREE') {
       // §14 — UNKNOWN is not permission. Written as a check for the one permitting value
       // rather than as `=== 'UNKNOWN'`, so a fourth availability value cannot slip through.
       const reason = `Availability is not established. ${availability.reason} No create request was issued.`;
       console.warn(`[ActionGateway] CALENDAR_CREATE refused: ${reason}`);
       return { success: false, blockedReason: reason, error: reason, errorCode: 'AVAILABILITY_UNKNOWN' };
     }

     const created = await calendarService.createEvent({
       title: request.payload.title,
       description: request.payload.description,
       startAtUtc: startInstant.toISOString(),
       endAtUtc: endInstant.toISOString(),
       timeZone,
       attendees: Array.isArray(request.payload.attendees) ? request.payload.attendees : [],
       // P0.13 — Google treats this as an idempotency key. It was `"req_" + Date.now()`, so a
       // retried booking minted a SECOND Meet conference for one meeting.
       idempotencyKey: request.payload.idempotencyKey,
     });

     // The calendar path had no equivalent of the outbox worker's fabricated-id guard, which
     // is how `eventId: 'mock_evt_123'` could have become a booked meeting.
     if (isFabricatedProviderId(created.eventId)) {
       const reason =
         `Refusing to record a calendar event with a locally-minted id (${created.eventId}). ` +
         'A provider id must come from a provider.';
       console.error(`[ActionGateway] ${reason}`);
       return { success: false, error: reason, errorCode: 'FABRICATED_PROVIDER_ID' };
     }

     return {
       success: true,
       providerResult: {
         eventId: created.eventId,
         conferenceUrl: created.conferenceUrl,
         availabilityReason: availability.reason,
       },
     };
  }

  /**
   * The Google credential for an organisation.
   *
   * Both action paths need it and both used to inline the same loop, filtering on
   * `d.provider === 'gmail' || d.provider === 'GMAIL'` — including the CALENDAR path, which
   * reports its provider as 'google-calendar' everywhere else. One Google connection carries
   * both scopes, so matching the row is a question about the connection, not about the action,
   * and it belongs in one place where the accepted spellings are written down once.
   */
  private async findGoogleAccessToken(organizationId: string): Promise<string | null> {
    if (!store) return null;
    const q = query(
      collection(store, 'oauth_connections'),
      where('organizationId', '==', organizationId)
    );
    const snap = await getDocs(q);
    let accessToken: string | null = null;
    snap.forEach((d) => {
      const row = d.data();
      const provider = typeof row.provider === 'string' ? row.provider.toLowerCase() : '';
      if (provider === 'gmail' || provider === 'google' || provider === 'google-calendar') {
        accessToken = typeof row.accessToken === 'string' ? row.accessToken : null;
      }
    });
    // P0.8 — a fabricated token is not a token. `'mock_token'` is named explicitly because
    // server.ts wrote that exact literal on every 'connect' and it does not match the
    // fabricated-id pattern.
    if (!accessToken || isFabricatedProviderId(accessToken) || accessToken === 'mock_token') {
      return null;
    }
    return accessToken;
  }

}

export const actionGateway = new ActionGateway();
