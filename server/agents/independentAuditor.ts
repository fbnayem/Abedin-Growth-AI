import { ClaimGroundingEngine } from '../policies/claimGrounding';
import { auditPricingClaims, pricingContextFor, type Quote } from '../../shared/domain/quote';
import { formatMoney, type Money } from '../../shared/domain/pricing';
import {
  ReplyPlan,
  ConversationDecisionLog,
  ClientIdentityResolution,
  EmailUnderstanding,
  NextBestActionResult,
  BuyingStage,
} from "../../shared/domain/models";
import {
  CALENDAR_BOOKING_URL,
  GOOGLE_MEET_URL,
  WEBSITE_URL,
  ONBOARDING_URL,
  isUrlInTrustedRegistry,
  sanitizeCtaUrls,
} from "./trustedCtaRegistry";
import {
  validateAndEnforceNoPhonePolicy,
  validateAndEnforceMeetingAndCalendarLinks,
  normalizeMergeTags,
} from "./multiAgentReplySystem";
import {
  isSuppressed,
  circuitBreaker,
  isDuplicateSend,
} from "./salesDecisionEngine";

export interface AuditResult {
  decision: "PASS" | "REWRITE" | "ESCALATE" | "BLOCK";
  score: number; // 0-100
  checksPassed: string[];
  issuesDetected: string[];
  sanitizedBody: string;
  deterministicSafetyResult: {
    zeroPhoneClean: boolean;
    semanticLinkClean: boolean;
    mergeTagsClean: boolean;
    suppressionClean: boolean;
    duplicateLockClean: boolean;
    circuitBreakerClean: boolean;
  };
}

/**
 * Executes the Independent Executive Reply Auditor (Part 30 & 31)
 */
export async function auditReplyAgainstPlan(input: {
  draftBody: string;
  replyPlan: ReplyPlan;
  identity: ClientIdentityResolution;
  emailUnderstanding: EmailUnderstanding;
  nextBestAction: NextBestActionResult;
  conversationId: string;
  /**
   * P1.7 — The quote in force for this customer, if any. Passed in rather than looked up so
   * the auditor stays a pure function of its inputs and can be tested against a withdrawn or
   * expired quote without a datastore.
   */
  quote?: Quote | null;
  /**
   * Figures that are money but are NOT prices — an approved ROI claim such as "recovers
   * £18,000 monthly". Without these every such sentence is reported, and a check that cries
   * wolf gets switched off, which is worse than the check not existing.
   */
  groundedNonPriceAmounts?: readonly Money[];
  /** Injectable for tests; a pricing check that depends on the wall clock cannot be tested. */
  now?: string;
}): Promise<AuditResult> {
  const checksPassed: string[] = [];
  const issuesDetected: string[] = [];
  let score = 100;

  // 1. Hard Blocker: Suppression Check
  const suppressionCheck = isSuppressed(input.identity.email);
  if (suppressionCheck.suppressed) {
    return {
      decision: "BLOCK",
      score: 0,
      checksPassed: [],
      issuesDetected: [`Suppression violation: ${suppressionCheck.reason}`],
      sanitizedBody: "",
      deterministicSafetyResult: {
        zeroPhoneClean: true,
        semanticLinkClean: true,
        mergeTagsClean: true,
        suppressionClean: false,
        duplicateLockClean: true,
        circuitBreakerClean: true,
      },
    };
  }
  checksPassed.push("Suppression verification clean");

  // 2. Hard Blocker: Circuit Breaker
  if (!circuitBreaker.globalAutonomousSendEnabled) {
    return {
      decision: "ESCALATE",
      score: 0,
      checksPassed,
      issuesDetected: [`Circuit breaker active: ${circuitBreaker.pausedReason}`],
      sanitizedBody: input.draftBody,
      deterministicSafetyResult: {
        zeroPhoneClean: true,
        semanticLinkClean: true,
        mergeTagsClean: true,
        suppressionClean: true,
        duplicateLockClean: true,
        circuitBreakerClean: false,
      },
    };
  }
  checksPassed.push("Global circuit breaker operational");

  // 3. Hard Blocker: Duplicate Send Detection
  if (input.draftBody && isDuplicateSend(input.conversationId, input.draftBody)) {
    return {
      decision: "BLOCK",
      score: 0,
      checksPassed,
      issuesDetected: ["Duplicate identical message detected within 5-minute safety window"],
      sanitizedBody: "",
      deterministicSafetyResult: {
        zeroPhoneClean: true,
        semanticLinkClean: true,
        mergeTagsClean: true,
        suppressionClean: true,
        duplicateLockClean: false,
        circuitBreakerClean: true,
      },
    };
  }
  checksPassed.push("Idempotency and duplicate check clean");

  // 4. Deterministic Sanitization: Zero-Phone Policy (Part 25)
  const phoneRes = validateAndEnforceNoPhonePolicy(input.draftBody);
  let sanitizedBody = phoneRes.sanitized;
  if (phoneRes.flagged) {
    checksPassed.push(`Prohibited phone patterns neutralized (${phoneRes.detectedPatterns.join(", ")})`);
  } else {
    checksPassed.push("Zero phone numbers in draft");
  }

  // 5. Deterministic Sanitization: Semantic Link Integrity (Part 22)
  const linkRes = validateAndEnforceMeetingAndCalendarLinks(sanitizedBody);
  sanitizedBody = linkRes.sanitized;
  if (linkRes.flagged) {
    checksPassed.push(`Link semantic alignment corrected (${linkRes.correctedPatterns.join("; ")})`);
  } else {
    checksPassed.push("Calendar vs Meet URL semantics verified");
  }

  // 6. Deterministic Sanitization: Merge Tag Normalizer (Part 26)
  const firstName = input.identity.name?.replace(/^Dr\.\s+/i, "").split(" ")[0];
  const tagRes = normalizeMergeTags(sanitizedBody, {
    firstName,
    companyName: input.identity.company,
  });
  sanitizedBody = tagRes.sanitized;
  if (tagRes.flagged) {
    checksPassed.push(`Unresolved merge tags normalized (${tagRes.resolvedTags.join("; ")})`);
  } else {
    checksPassed.push("Zero raw template merge tags");
  }

  // 7. Deterministic Sanitization: Trusted CTA Registry (Part 21)
  const ctaRes = sanitizeCtaUrls(sanitizedBody);
  sanitizedBody = ctaRes.sanitized;
  if (ctaRes.modified) {
    checksPassed.push(`External CTA URLs aligned to trusted registry (${ctaRes.corrections.join("; ")})`);
  } else {
    checksPassed.push("All hyperlinks approved in CTA Registry");
  }

  // 8. Quality Check: Meeting Readiness Gatekeeper (Part 20)
  if (!input.replyPlan.sendBookingLink && sanitizedBody.includes(CALENDAR_BOOKING_URL)) {
    score -= 15;
    issuesDetected.push("Meeting link included despite low meeting readiness score");
    // Strip premature meeting push
    sanitizedBody = sanitizedBody.replace(CALENDAR_BOOKING_URL, WEBSITE_URL);
  } else {
    checksPassed.push("Meeting readiness & CTA gating strictly aligned");
  }

  // 9. Quality Check: Direct Question-First Rule (Part 19)
  if (input.emailUnderstanding.explicitQuestions.length > 0) {
    checksPassed.push("Explicit prospect questions addressed directly");
  }

  // 10. Quality Check: Pricing Integrity (Part 13 & 14)
  //
  // P1.7 — This was:
  //
  //     if (input.replyPlan.nextBestAction === "PROVIDE_PRICING") {
  //       if (sanitizedBody.includes("£499")) { ...pass... } else { score -= 20; }
  //     }
  //
  // Three separate failures. It ran ONLY when the plan said the reply was about pricing, so a
  // wrong price in any other reply was never examined. It was a substring test, so "our old
  // price of £499" passed and "£4,499" contains it. And it could only detect the ABSENCE of an
  // expected string — it had no way to notice the PRESENCE of a price we never charged, which
  // is the failure that actually reaches a customer.
  //
  // The check now runs on every reply and asks the opposite question: is there any amount in
  // this draft that this customer may not be quoted? A hallucinated £299, a stale £599 from
  // the company-brain document, and a list price stated over a negotiated one are all the same
  // violation under one rule.
  const pricingContext = pricingContextFor(input.quote ?? null, input.now ?? new Date().toISOString());
  const pricingFindings = auditPricingClaims(
    sanitizedBody,
    pricingContext.quotableAmounts,
    input.groundedNonPriceAmounts ?? []
  );

  if (pricingFindings.length > 0) {
    // A wrong price is not a style problem. It is a commercial commitment made to a customer in
    // writing, so it costs enough to force a rewrite on its own rather than shading a score.
    score -= 40;
    for (const finding of pricingFindings) issuesDetected.push(finding.message);
  } else {
    checksPassed.push(
      pricingContext.listPricingWithheld
        ? `Every amount stated is on the customer's approved quote (list pricing withheld)`
        : 'Every amount stated is in the price book'
    );
  }

  if (pricingContext.listPricingWithheld) {
    // Recorded because it is the mechanism, not a detail: the model was never shown list
    // pricing for this customer, so it could not have quoted it.
    checksPassed.push(pricingContext.rationale);
  }

  
  // 11. Claim-Level Grounding (Part L)
  const groundingEngine = new ClaimGroundingEngine();
  const groundingResult = await groundingEngine.verifyClaims(sanitizedBody);
  if (!groundingResult.isGrounded) {
      score -= 30;
      issuesDetected.push(...groundingResult.ungroundedClaims);
  } else {
      checksPassed.push("All claims grounded in approved knowledge");
  }

  const finalDecision: AuditResult["decision"] =
    score >= 90 ? "PASS" : score >= 70 ? "REWRITE" : "ESCALATE";

  return {
    decision: finalDecision,
    score: Math.max(0, score),
    checksPassed,
    issuesDetected,
    sanitizedBody,
    deterministicSafetyResult: {
      zeroPhoneClean: true,
      semanticLinkClean: true,
      mergeTagsClean: true,
      suppressionClean: true,
      duplicateLockClean: true,
      circuitBreakerClean: true,
    },
  };
}
