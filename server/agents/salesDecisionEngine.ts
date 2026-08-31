import {
  ComprehensiveIntent,
  BuyingStage,
  NextBestActionType,
  NextBestActionResult,
  PurchaseReadinessResult,
  MeetingReadinessResult,
  ReplyPlan,
  ClientIntelligenceProfile,
  ClientIdentityResolution,
  CircuitBreakerState,
  Conversation,
  EmailMessage,
  EmailUnderstanding,
} from "../../shared/domain/models";
import { safeGenerateJSON } from "../geminiClient";
import { globalStore } from "../dataStore";
import { CALENDAR_BOOKING_URL, GOOGLE_MEET_URL, WEBSITE_URL, ONBOARDING_URL } from "./trustedCtaRegistry";

// ==========================================
// PART 49: CIRCUIT BREAKER & GLOBAL STATE
// ==========================================
export const circuitBreaker: CircuitBreakerState = {
  globalAutonomousSendEnabled: true,
  pausedReason: undefined,
  consecutiveErrorCount: 0,
  duplicateSendAlertTriggered: false,
  bounceRateSpikeDetected: false,
  lastSafetyTripTimestamp: undefined,
};

export function tripCircuitBreaker(reason: string) {
  circuitBreaker.globalAutonomousSendEnabled = false;
  circuitBreaker.pausedReason = reason;
  circuitBreaker.lastSafetyTripTimestamp = new Date().toISOString();
  console.warn(`[CIRCUIT BREAKER TRIPPED]: ${reason}`);
}

export function resetCircuitBreaker() {
  circuitBreaker.globalAutonomousSendEnabled = true;
  circuitBreaker.pausedReason = undefined;
  circuitBreaker.consecutiveErrorCount = 0;
  circuitBreaker.duplicateSendAlertTriggered = false;
  circuitBreaker.bounceRateSpikeDetected = false;
}

// ==========================================
// PART 27: IDEMPOTENCY & SEND LOCKS
// ==========================================
const sendLocks = new Set<string>();
const recentMessageFingerprints = new Map<string, number>();

export function acquireSendLock(conversationId: string): boolean {
  if (sendLocks.has(conversationId)) return false;
  sendLocks.add(conversationId);
  return true;
}

export function releaseSendLock(conversationId: string) {
  sendLocks.delete(conversationId);
}

export function isDuplicateSend(conversationId: string, text: string): boolean {
  const hash = `${conversationId}:${text.trim().substring(0, 80)}`;
  const now = Date.now();
  const lastSent = recentMessageFingerprints.get(hash);
  if (lastSent && now - lastSent < 300000) { // 5 minutes duplicate window
    return true;
  }
  recentMessageFingerprints.set(hash, now);
  return false;
}

// ==========================================
// PART 43: PROMPT INJECTION SANITIZER
// ==========================================
export function sanitizeUntrustedProspectInput(rawText: string): {
  sanitized: string;
  hasInjectionAttempt: boolean;
  neutralizedPatterns: string[];
} {
  if (!rawText) return { sanitized: "", hasInjectionAttempt: false, neutralizedPatterns: [] };
  
  let text = rawText;
  const neutralizedPatterns: string[] = [];

  const injectionRegexes = [
    /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/gi,
    /disregard\s+(?:all\s+)?(?:previous|prior)\s+prompts/gi,
    /system\s*:\s*you\s+are\s+now/gi,
    /you\s+must\s+give\s+a\s+(?:\d+%\s+)?discount/gi,
    /grant\s+free\s+access/gi,
    /act\s+as\s+an\s+unrestricted/gi,
    /forget\s+all\s+rules/gi,
    /output\s+the\s+system\s+prompt/gi,
  ];

  for (const regex of injectionRegexes) {
    if (regex.test(text)) {
      neutralizedPatterns.push(regex.source);
      text = text.replace(regex, "[Redacted untrusted instruction]");
    }
  }

  return {
    sanitized: text,
    hasInjectionAttempt: neutralizedPatterns.length > 0,
    neutralizedPatterns,
  };
}

// ==========================================
// PART 24: SUPPRESSION ENGINE
// ==========================================
export function isSuppressed(email: string): { suppressed: boolean; reason?: string } {
  const clean = email.toLowerCase().trim();
  
  // Check global store unsubscribes
  const lead = globalStore.leads.find((l) => l.email.toLowerCase().trim() === clean);
  if (lead && lead.status === "UNSUBSCRIBED") {
    return { suppressed: true, reason: "Lead opted out / unsubscribed" };
  }

  const conv = globalStore.conversations.find((c) => c.contactEmail.toLowerCase().trim() === clean);
  if (conv && conv.lastReplyIntent === "UNSUBSCRIBE") {
    return { suppressed: true, reason: "Contact requested unsubscribe in conversation" };
  }

  // Hardcoded suppression domain/patterns
  if (clean.includes("no-reply") || clean.includes("mailer-daemon") || clean.includes("postmaster")) {
    return { suppressed: true, reason: "Automated / system bounce address" };
  }

  return { suppressed: false };
}

// ==========================================
// PART 5 & 6: EMAIL UNDERSTANDING & INTENT MODEL
// ==========================================

export function evaluateEmailUnderstandingRuleBased(text: string): EmailUnderstanding {
  const lower = text.toLowerCase();

  // Out of office check
  if (
    lower.includes("out of the office") ||
    lower.includes("out of office") ||
    lower.includes("automatic reply") ||
    lower.includes("annual leave") ||
    lower.includes("away from my desk")
  ) {
    return {
      primaryIntent: "OUT_OF_OFFICE",
      secondaryIntents: [],
      explicitQuestions: [],
      hiddenQuestions: [],
      sentiment: "NEUTRAL",
      urgency: "LOW",
      commercialIntent: "NONE",
      technicalDepth: "NONE",
      buyingSignals: [],
      objections: [],
      isOutOfOffice: true,
      isUnsubscribe: false,
      isReferral: false,
    };
  }

  // Unsubscribe / Opt out
  if (
    lower.includes("unsubscribe") ||
    lower.includes("remove me") ||
    lower.includes("take me off") ||
    lower.includes("stop emailing") ||
    lower.includes("do not contact") ||
    lower.includes("not interested") ||
    lower.includes("no thank you")
  ) {
    return {
      primaryIntent: lower.includes("unsubscribe") ? "UNSUBSCRIBE" : "NOT_INTERESTED",
      secondaryIntents: [],
      explicitQuestions: [],
      hiddenQuestions: [],
      sentiment: "NEGATIVE",
      urgency: "LOW",
      commercialIntent: "NONE",
      technicalDepth: "NONE",
      buyingSignals: [],
      objections: ["Opt-out / Not interested"],
      isOutOfOffice: false,
      isUnsubscribe: true,
      isReferral: false,
    };
  }

  // Extract explicit questions (lines ending with ?)
  const questionMatches = text.match(/[^.!?\n]+(?:\?)/g) || [];
  const explicitQuestions = questionMatches.map((q) => q.trim()).filter((q) => q.length > 5);

  const buyingSignals: string[] = [];
  const objections: string[] = [];
  const secondaryIntents: ComprehensiveIntent[] = [];
  let primaryIntent: ComprehensiveIntent = "INFORMATION_REQUEST";

  // Intent classification heuristics
  if (
    lower.includes("book a call") ||
    lower.includes("calendar link") ||
    lower.includes("let's do a demo") ||
    lower.includes("schedule a demo") ||
    lower.includes("available for a call") ||
    lower.includes("open to a chat")
  ) {
    primaryIntent = "DEMO_REQUEST";
    buyingSignals.push("Direct meeting / demo requested");
  } else if (
    lower.includes("ready to start") ||
    lower.includes("sign up") ||
    lower.includes("send the contract") ||
    lower.includes("how do we get started")
  ) {
    primaryIntent = "READY_TO_START";
    buyingSignals.push("Clear purchase / onboarding intent");
  } else if (
    lower.includes("how much") ||
    lower.includes("pricing") ||
    lower.includes("cost") ||
    lower.includes("fee") ||
    lower.includes("subscription")
  ) {
    primaryIntent = "PRICING_QUESTION";
    secondaryIntents.push("PRICING_QUESTION");
  } else if (
    lower.includes("integrate") ||
    lower.includes("api") ||
    lower.includes("crm") ||
    lower.includes("latency") ||
    lower.includes("technical")
  ) {
    primaryIntent = "TECHNICAL_QUESTION";
    secondaryIntents.push("TECHNICAL_QUESTION");
  } else if (
    lower.includes("too expensive") ||
    lower.includes("we already use") ||
    lower.includes("not ready right now") ||
    lower.includes("bad timing")
  ) {
    primaryIntent = "OBJECTION";
    objections.push("Budget, timing, or competitor objection");
  }

  return {
    primaryIntent,
    secondaryIntents,
    explicitQuestions,
    hiddenQuestions: explicitQuestions.length === 0 && lower.includes("interested") ? ["What are the next steps to see this in action?"] : [],
    sentiment: buyingSignals.length > 0 ? "POSITIVE" : objections.length > 0 ? "SKEPTICAL" : "NEUTRAL",
    urgency: buyingSignals.length > 0 ? "HIGH" : "MEDIUM",
    commercialIntent: primaryIntent === "READY_TO_START" ? "HIGH" : primaryIntent === "PRICING_QUESTION" ? "MEDIUM" : "LOW",
    technicalDepth: primaryIntent === "TECHNICAL_QUESTION" ? "DEEP" : "MODERATE",
    buyingSignals,
    objections,
    isOutOfOffice: false,
    isUnsubscribe: false,
    isReferral: false,
  };
}

// ==========================================
// PART 7: BUYING STAGE ENGINE
// ==========================================
export function computeBuyingStage(
  currentStage: BuyingStage,
  intent: ComprehensiveIntent,
  purchaseReadiness: number,
  meetingReadiness: number
): BuyingStage {
  if (intent === "UNSUBSCRIBE") return "UNSUBSCRIBED";
  if (intent === "NOT_INTERESTED") return "NOT_INTERESTED";
  if (intent === "READY_TO_START" || purchaseReadiness >= 85) return "PURCHASE_READY";
  if (intent === "NEGOTIATION") return "NEGOTIATION";
  if (intent === "DEMO_REQUEST" || meetingReadiness >= 75) return "DEMO_READY";
  if (intent === "PRICING_QUESTION" || intent === "PRICE_COMPARISON") return "COMMERCIAL_EVALUATION";
  if (intent === "TECHNICAL_QUESTION" || intent === "INTEGRATION_QUESTION") return "TECHNICAL_EVALUATION";
  if (intent === "FEATURE_QUESTION" || intent === "INFORMATION_REQUEST") return "PRODUCT_EVALUATING";

  return currentStage || "SOLUTION_EXPLORING";
}

// ==========================================
// PART 8 & 9: PURCHASE & MEETING READINESS ENGINES
// ==========================================
export function computePurchaseReadiness(
  emailUnderstanding: EmailUnderstanding,
  profile?: ClientIntelligenceProfile
): PurchaseReadinessResult {
  let score = 25; // Base exploratory score
  const signals: string[] = [];

  if (emailUnderstanding.primaryIntent === "READY_TO_START") {
    score += 55;
    signals.push("+55 Direct readiness to onboard / purchase");
  }
  if (emailUnderstanding.primaryIntent === "PRICING_QUESTION") {
    score += 25;
    signals.push("+25 Pricing question indicates budget consideration");
  }
  if (emailUnderstanding.buyingSignals.length > 0) {
    score += 15 * emailUnderstanding.buyingSignals.length;
    signals.push(`+${15 * emailUnderstanding.buyingSignals.length} Buying signals detected`);
  }
  if (emailUnderstanding.isUnsubscribe || emailUnderstanding.primaryIntent === "NOT_INTERESTED") {
    score = 0;
    signals.push("Reset to 0 due to opt-out");
  }

  score = Math.min(100, Math.max(0, score));

  return {
    score,
    signals,
    reasoning: `Purchase readiness scored at ${score}/100 based on explicit intent and commercial curiosity.`,
  };
}

export function computeMeetingReadiness(
  emailUnderstanding: EmailUnderstanding,
  threadLength: number
): MeetingReadinessResult {
  let score = 30; // Base baseline
  const signals: string[] = [];

  if (emailUnderstanding.primaryIntent === "DEMO_REQUEST") {
    score += 50;
    signals.push("+50 Explicit demo / meeting request by prospect");
  }
  if (emailUnderstanding.explicitQuestions.length > 0 && threadLength <= 1) {
    // Cold lead asking a direct question: answer first, do not force meeting prematurely!
    score -= 15;
    signals.push("-15 Prospect asked explicit question on first reply — answer question directly first");
  }
  if (emailUnderstanding.isOutOfOffice || emailUnderstanding.isUnsubscribe) {
    score = 0;
    signals.push("Reset to 0 due to OOO or opt-out");
  }

  score = Math.min(100, Math.max(0, score));
  const shouldOfferBookingLink = score >= 65;

  return {
    score,
    shouldOfferBooking: shouldOfferBookingLink,
    signals,
    reasoning: shouldOfferBookingLink
      ? `Meeting readiness is high (${score}/100); calendar booking link is authorized.`
      : `Meeting readiness is moderate/low (${score}/100); reply must focus on direct answers without pushing calendar links.`,
  };
}

// ==========================================
// PART 10: NEXT BEST ACTION ENGINE
// ==========================================
export function determineNextBestAction(
  emailUnderstanding: EmailUnderstanding,
  buyingStage: BuyingStage,
  purchaseReadiness: PurchaseReadinessResult,
  meetingReadiness: MeetingReadinessResult
): NextBestActionResult {
  if (emailUnderstanding.isOutOfOffice) {
    return {
      action: "NO_REPLY",
      reason: "Out-of-office automated reply detected; suppress response.",
      meetingLinkAllowed: false,
      pricingAllowed: false,
      technicalAgentRequired: false,
      pricingAgentRequired: false,
      objectionAgentRequired: false,
      roiAgentRequired: false,
      humanReviewRequired: false,
      questionsToAnswer: [],
      questionsToAsk: [],
      missingInformation: [],
      confidence: 0.99,
    };
  }

  if (emailUnderstanding.isUnsubscribe || emailUnderstanding.primaryIntent === "NOT_INTERESTED") {
    return {
      action: "SUPPRESS",
      reason: "Prospect requested unsubscribe or indicated disinterest. Suppress and mark opt-out.",
      meetingLinkAllowed: false,
      pricingAllowed: false,
      technicalAgentRequired: false,
      pricingAgentRequired: false,
      objectionAgentRequired: false,
      roiAgentRequired: false,
      humanReviewRequired: false,
      questionsToAnswer: [],
      questionsToAsk: [],
      missingInformation: [],
      confidence: 0.99,
    };
  }

  if (emailUnderstanding.primaryIntent === "READY_TO_START" || purchaseReadiness.score >= 85) {
    return {
      action: "START_ONBOARDING",
      reason: "Prospect is ready to start. Provide onboarding steps and optional walkthrough.",
      meetingLinkAllowed: true,
      pricingAllowed: true,
      technicalAgentRequired: false,
      pricingAgentRequired: true,
      objectionAgentRequired: false,
      roiAgentRequired: false,
      humanReviewRequired: false,
      questionsToAnswer: emailUnderstanding.explicitQuestions,
      questionsToAsk: ["What is your preferred target go-live date?"],
      missingInformation: [],
      confidence: 0.96,
    };
  }

  if (emailUnderstanding.primaryIntent === "DEMO_REQUEST" || meetingReadiness.shouldOfferBooking) {
    return {
      action: "SEND_BOOKING_CTA",
      reason: "Prospect requested demo or meeting. Answer any questions and provide verified calendar link.",
      meetingLinkAllowed: true,
      pricingAllowed: false,
      technicalAgentRequired: emailUnderstanding.technicalDepth === "DEEP",
      pricingAgentRequired: false,
      objectionAgentRequired: false,
      roiAgentRequired: false,
      humanReviewRequired: false,
      questionsToAnswer: emailUnderstanding.explicitQuestions,
      questionsToAsk: [],
      missingInformation: [],
      confidence: 0.95,
    };
  }

  if (emailUnderstanding.primaryIntent === "PRICING_QUESTION") {
    return {
      action: "PROVIDE_PRICING",
      reason: "Prospect asked about pricing. Provide transparent standard plan and ask about volume.",
      meetingLinkAllowed: false,
      pricingAllowed: true,
      technicalAgentRequired: false,
      pricingAgentRequired: true,
      objectionAgentRequired: false,
      roiAgentRequired: true,
      humanReviewRequired: false,
      questionsToAnswer: emailUnderstanding.explicitQuestions,
      questionsToAsk: ["Roughly how many inbound calls or locations does your practice handle per month?"],
      missingInformation: ["Monthly call volume"],
      confidence: 0.94,
    };
  }

  if (emailUnderstanding.primaryIntent === "TECHNICAL_QUESTION" || emailUnderstanding.technicalDepth === "DEEP") {
    return {
      action: "PROVIDE_TECHNICAL_EXPLANATION",
      reason: "Prospect asked technical/integration questions. Deliver verified technical details without fluff.",
      meetingLinkAllowed: false,
      pricingAllowed: false,
      technicalAgentRequired: true,
      pricingAgentRequired: false,
      objectionAgentRequired: false,
      roiAgentRequired: false,
      humanReviewRequired: false,
      questionsToAnswer: emailUnderstanding.explicitQuestions,
      questionsToAsk: ["Which specific practice management or CRM system are you currently operating?"],
      missingInformation: ["Current CRM / software stack"],
      confidence: 0.95,
    };
  }

  if (emailUnderstanding.primaryIntent === "OBJECTION") {
    return {
      action: "HANDLE_OBJECTION",
      reason: "Address objection with low-pressure reassurance and concrete proof point.",
      meetingLinkAllowed: false,
      pricingAllowed: false,
      technicalAgentRequired: false,
      pricingAgentRequired: false,
      objectionAgentRequired: true,
      roiAgentRequired: true,
      humanReviewRequired: false,
      questionsToAnswer: emailUnderstanding.explicitQuestions,
      questionsToAsk: [],
      missingInformation: [],
      confidence: 0.92,
    };
  }

  // Default: Answer only and qualify smoothly
  return {
    action: "ANSWER_AND_QUALIFY",
    reason: "Answer prospect's specific questions directly first, then ask one relevant qualifying question.",
    meetingLinkAllowed: false,
    pricingAllowed: false,
    technicalAgentRequired: false,
    pricingAgentRequired: false,
    objectionAgentRequired: false,
    roiAgentRequired: false,
    humanReviewRequired: false,
    questionsToAnswer: emailUnderstanding.explicitQuestions,
    questionsToAsk: ["What is the primary challenge you are experiencing with front-desk phone volume today?"],
    missingInformation: ["Current operational challenge"],
    confidence: 0.92,
  };
}

// ==========================================
// PART 12-16: SPECIALIST AGENTS (CANONICAL KNOWLEDGE)
// ==========================================
export const CANONICAL_KNOWLEDGE = {
  pricing: {
    standardPackage: "£499 / month per clinic location",
    includedMinutes: "2,500 inbound voice conversation minutes per month included",
    overageRate: "£0.12 per additional minute",
    trial: "14-day zero-risk trial with 100% money-back guarantee",
    enterpriseDiscount: "Custom volume tier discounts available for practices with >5 locations",
    setupFee: "£0 onboarding and setup fee during current promotion",
  },
  technical: {
    latency: "Ultra-low sub-500ms conversational turn-taking latency for human-grade phone dialogue",
    crmIntegrations: "Native 2-way sync with Dentally, Software of Excellence (Exact), Salesforce, HubSpot, Zoho, and custom webhooks",
    calendarSync: "Real-time 2-way slot locking with Google Calendar and Microsoft Outlook",
    telecom: "Compatible with existing phone numbers via SIP trunking, Twilio, or instant call forwarding",
    compliance: "Fully HIPAA and GDPR compliant with enterprise-grade SOC-2 AES-256 data encryption",
    transfer: "Automated live warm transfer to clinic staff for urgent medical triage or requested human escalation",
  },
  roi: {
    missedCallsRecovered: "Average clinic recovers £18,000+ monthly in previously missed after-hours and peak-hour patient consultations",
    receptionistSavings: "Over 65% reduction in front-desk scheduling overtime and agency temp staffing costs",
    speedToLead: "100% of web and phone inquiries answered in under 3 seconds 24/7/365",
  },
};

// ==========================================
// PART 17-20: GROUNDED FOUNDER REPLY COMPOSER
// ==========================================
export async function composeAutonomousSalesReply(input: {
  identity: ClientIdentityResolution;
  emailUnderstanding: EmailUnderstanding;
  nextBestAction: NextBestActionResult;
  buyingStage: BuyingStage;
  rawInboundText: string;
  threadHistory?: EmailMessage[];
}): Promise<{ subject: string; body: string; replyPlan: ReplyPlan }> {
  const firstName = input.identity.name?.replace(/^Dr\.\s+/i, "").split(" ")[0] || "there";
  const companyName = input.identity.company || "your team";

  const replyPlan: ReplyPlan = {
    contact: {
      name: input.identity.name,
      company: input.identity.company,
      email: input.identity.email,
    },
    product: "Abedin Voice AI",
    primaryIntent: input.emailUnderstanding.primaryIntent,
    secondaryIntents: input.emailUnderstanding.secondaryIntents,
    buyingStage: input.buyingStage,
    purchaseReadiness: input.nextBestAction.pricingAllowed ? 70 : 40,
    meetingReadiness: input.nextBestAction.meetingLinkAllowed ? 80 : 35,
    questionsToAnswer: input.nextBestAction.questionsToAnswer,
    knownRelevantFacts: [
      `Abedin Voice AI operates at sub-500ms latency for natural phone conversations`,
      `Syncs directly with Google Calendar and CRM systems`,
    ],
    objections: input.emailUnderstanding.objections,
    missingInformation: input.nextBestAction.missingInformation,
    specialistsRequired: [
      input.nextBestAction.technicalAgentRequired ? "TECHNICAL" : null,
      input.nextBestAction.pricingAgentRequired ? "PRICING" : null,
      input.nextBestAction.objectionAgentRequired ? "OBJECTION" : null,
      input.nextBestAction.roiAgentRequired ? "ROI" : null,
    ].filter(Boolean) as ("TECHNICAL" | "PRICING" | "OBJECTION" | "ROI")[],
    nextBestAction: input.nextBestAction.action,
    sendBookingLink: input.nextBestAction.meetingLinkAllowed,
    sendOnboardingLink: input.nextBestAction.action === "START_ONBOARDING",
    reason: input.nextBestAction.reason,
  };

  // Rule-based deterministic high-quality composer for rapid zero-latency responses
  let body = "";
  const subject = input.rawInboundText.toLowerCase().includes("re:") ? "Re: Abedin Voice AI" : "Re: 24/7 AI Voice Receptionist for " + companyName;

  switch (input.nextBestAction.action) {
    case "PROVIDE_PRICING": {
      body = `Hi ${firstName},

Our standard clinic plan for Abedin Voice AI is ${CANONICAL_KNOWLEDGE.pricing.standardPackage}, which includes 2,500 monthly conversation minutes (600+ patient bookings), 24/7 Google Calendar syncing, and zero setup fee.

How many monthly calls or clinic locations are you looking to cover at ${companyName}?

Best,
Nayem

Nayem Abedin · Abedin Tech
https://abedintech.com/voice-ai/`;
      break;
    }

    case "PROVIDE_TECHNICAL_EXPLANATION": {
      body = `Hi ${firstName},

Abedin Voice AI operates with sub-500ms voice turnaround and syncs directly 2-way with Google Calendar, Outlook, and major practice management software so appointments lock in real time.

For telephony, it connects via simple call forwarding or standard SIP trunking with no hardware required.

Which practice management system or CRM does ${companyName} currently use?

Best,
Nayem

Nayem Abedin · Abedin Tech
https://abedintech.com/voice-ai/`;
      break;
    }

    case "SEND_BOOKING_CTA": {
      body = `Hi ${firstName},

I'd be glad to show you a quick 10-minute live demonstration of Abedin Voice AI handling inbound calls in real time.

You can grab a convenient slot directly on my booking calendar here:
${CALENDAR_BOOKING_URL}

Looking forward to speaking!

Best,
Nayem

Nayem Abedin · Abedin Tech
https://abedintech.com/voice-ai/`;
      break;
    }

    case "START_ONBOARDING": {
      body = `Hi ${firstName},

Great! You can activate your 14-day zero-risk trial here in under 15 minutes:
${ONBOARDING_URL}

Once in, simply connect your Google Calendar. If you'd like a quick guided walkthrough on Google Meet, feel free to pick a time here: ${CALENDAR_BOOKING_URL}

Best,
Nayem

Nayem Abedin · Abedin Tech
https://abedintech.com/voice-ai/`;
      break;
    }

    case "HANDLE_OBJECTION": {
      body = `Hi ${firstName},

Completely understand. As a quick reference, clinics typically recover 15–20 missed patient bookings per month while cutting front-desk phone load by over 65%.

No pressure at all—whenever you're ready to test after-hours coverage, feel free to check out our demo at ${WEBSITE_URL}.

Best,
Nayem

Nayem Abedin · Abedin Tech
https://abedintech.com/voice-ai/`;
      break;
    }

    case "NO_REPLY":
    case "SUPPRESS": {
      body = "";
      break;
    }

    default: {
      body = `Hi ${firstName},

Thanks for reaching out! Abedin Voice AI answers your patient calls 24/7 with human conversational speed and locks bookings directly into your calendar and CRM.

What is the biggest phone challenge ${companyName} is facing during peak or after-hours right now?

Best,
Nayem

Nayem Abedin · Abedin Tech
https://abedintech.com/voice-ai/`;
      break;
    }
  }

  return {
    subject,
    body,
    replyPlan,
  };
}
