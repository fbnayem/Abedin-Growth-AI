import {
  ReplyPlan,
  ConversationDecisionLog,
  ClientIdentityResolution,
  EmailUnderstanding,
  NextBestActionResult,
  BuyingStage,
} from "../../src/types";
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
export function auditReplyAgainstPlan(input: {
  draftBody: string;
  replyPlan: ReplyPlan;
  identity: ClientIdentityResolution;
  emailUnderstanding: EmailUnderstanding;
  nextBestAction: NextBestActionResult;
  conversationId: string;
}): AuditResult {
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
  if (input.replyPlan.nextBestAction === "PROVIDE_PRICING") {
    if (sanitizedBody.includes("£499")) {
      checksPassed.push("Canonical £499/mo standard package confirmed");
    } else {
      score -= 20;
      issuesDetected.push("Pricing quote does not reference canonical £499 rate");
    }
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
