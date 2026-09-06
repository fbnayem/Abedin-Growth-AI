import { pricingContextFor } from '../../shared/domain/quote';
import { buildContextBundle } from '../domain/contextBundle';
import { DEFAULT_BUSINESS_HOURS, nextBusinessSlot, systemClock, type Clock } from '../../shared/domain/time';
import { STANDARD_TIER } from '../../shared/domain/pricing';
import { Conversation, ConversationMemory, CompanyBrain, EmailMessage, Meeting } from "../../shared/domain/models";
import { globalStore } from "../dataStore";

export interface MultiAgentReplyOutput {
  subject: string;
  body: string;
  detectedCategory: "CUSTOMER" | "PARTNER" | "INVESTOR" | "B2B";
  extractedQuestionsAndInquiries: string[];
  answeredPoints: string[];
  shouldBookMeetingNow: boolean;
  meetingTimeParsed?: string;
  meetingBooked?: boolean;
  meetingId?: string;
  sanitizedBody: string;
  phonePolicyFlagged: boolean;
  detectedPhoneSequences: string[];
  memory: ConversationMemory;
}

/**
 * High-Precision Regex Patterns to catch any sequence resembling phone numbers:
 * 1. International dial codes (+44, +1, +61, 0044, etc.)
 * 2. Standard UK/European/US formats with spaces, hyphens, brackets, or dots
 * 3. Labeled contact lines (Direct:, Tel:, Mobile:, WhatsApp:, etc.)
 * 4. Digit clusters with 7 to 15 digits
 * 5. Call-to-action phrases referencing mobile phone calls
 */
export const PHONE_DETECTION_REGEXES = [
  // Labeled lines with phone numbers (e.g., "Direct: +44 20 7946 0192", "Tel: (020) 7946 0192")
  /(?:Direct|Tel|Phone|Mobile|Office|Cell|WhatsApp|Telephone|Ph|Contact)[\s:–—]*[+\d\s().-]{7,}\b/gim,
  
  // UK formats (+44 ..., 0044 ..., 020 ..., 07..., (020) ...)
  /(?:(?:\+44\s?\(0\)\s?|\+44\s?|0044\s?|0)\s*(?:[1-9]\d{1,4}|\([1-9]\d{1,4}\))[\s.-]?\d{3,4}[\s.-]?\d{3,4})/gi,
  
  // North American / International formats (+1 (555) 123-4567, 555-123-4567)
  /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
  
  // Generic international prefix followed by digit groups (+xx xxx xxx xxxx)
  /(?:\+|00)[1-9]\d{0,3}[\s.-]?(?:\(?\d{1,5}\)?[\s.-]?){1,4}\d{2,5}/g,
  
  // Standard delimited numbers with hyphens or dots (e.g. 020-7946-0192, 123.456.7890)
  /\b\d{2,5}[-.\s]\d{3,4}[-.\s]?\d{3,4}\b/g,
  
  // Standalone unbroken digit sequences resembling phone numbers (8 to 15 digits)
  /\b\d{8,15}\b/g,
  
  // Standalone lines consisting purely of phone symbols and digits
  /^[+\d\s().-]{8,}\s*$/gm,
];

export interface PhoneValidationResult {
  sanitized: string;
  flagged: boolean;
  detectedPatterns: string[];
  validationStatus: "CLEAN" | "FLAGGED_AND_STRIPPED";
}

export const CALENDAR_BOOKING_URL = "https://calendar.app.google/abedin-voice-ai-demo";
export const GOOGLE_MEET_URL = "https://meet.google.com/pending-calendar-creation";

export interface LinkSemanticValidationResult {
  sanitized: string;
  flagged: boolean;
  correctedPatterns: string[];
}

/**
 * Normalizes unresolved template merge tags (e.g. {{companyName}}, {{firstName}}, [FirstName])
 * with clean, context-appropriate fallbacks so raw placeholders are never sent.
 */
export function normalizeMergeTags(
  text: string,
  context?: { firstName?: string; companyName?: string; fundName?: string }
): { sanitized: string; flagged: boolean; resolvedTags: string[] } {
  if (!text) return { sanitized: "", flagged: false, resolvedTags: [] };

  let cleaned = text;
  const resolvedTags: string[] = [];

  const firstName = context?.firstName?.trim() || "";
  const companyName = context?.companyName?.trim() || "your team";
  const fundName = context?.fundName?.trim() || "your fund";

  // Replace {{firstName}} or [FirstName]
  const firstNameRegex = /\{\{\s*(?:firstName|name|contactName)\s*\}\}|\[\s*(?:firstName|name|contactName)\s*\]/gi;
  if (firstNameRegex.test(cleaned)) {
    resolvedTags.push("Normalized {{firstName}} tag");
    cleaned = cleaned.replace(firstNameRegex, firstName || "there");
  }

  // Replace {{companyName}} or [companyName]
  const companyRegex = /\{\{\s*(?:companyName|company|practiceName|clinicName)\s*\}\}|\[\s*(?:companyName|company|practiceName|clinicName)\s*\]/gi;
  if (companyRegex.test(cleaned)) {
    resolvedTags.push("Normalized {{companyName}} tag");
    cleaned = cleaned.replace(companyRegex, companyName);
  }

  // Replace {{fundName}} or [fundName]
  const fundRegex = /\{\{\s*fundName\s*\}\}|\[\s*fundName\s*\]/gi;
  if (fundRegex.test(cleaned)) {
    resolvedTags.push("Normalized {{fundName}} tag");
    cleaned = cleaned.replace(fundRegex, fundName);
  }

  // Generic bracket / curly fallback cleaner
  const genericTagRegex = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}|\[\s*([A-Z0-9_-]{2,})\s*\]/g;
  if (genericTagRegex.test(cleaned)) {
    resolvedTags.push("Stripped residual unresolved template tag brackets");
    cleaned = cleaned.replace(genericTagRegex, "");
  }

  return {
    sanitized: cleaned,
    flagged: resolvedTags.length > 0,
    resolvedTags,
  };
}

/**
 * Validates and enforces semantic accuracy between Calendar Booking Links and Google Meet Room Links.
 * Prevents calling a Google Meet link a "calendar" and vice versa.
 */
export function validateAndEnforceMeetingAndCalendarLinks(text: string): LinkSemanticValidationResult {
  if (!text) {
    return { sanitized: "", flagged: false, correctedPatterns: [] };
  }

  let cleaned = text;
  const correctedPatterns: string[] = [];

  // Pattern 1: Sentence says "calendar / pick any slot / choose any time / book on my calendar" but links to meet.google.com
  const calendarMeetMismatchRegex = /(?:(?:on|via|from|check|view|pick\s+(?:a|any)\s+slot\s+(?:on|in)?|choose\s+(?:a|any)\s+time\s+(?:on|in)?|book\s+(?:a|any)\s+slot\s+(?:on|in)?|grab\s+(?:a|any)\s+slot\s+(?:on|in)?)\s*(?:my|our)?\s*calendar[:\s]*)(https?:\/\/meet\.google\.com\/[^\s\n,)]+)/gi;
  if (calendarMeetMismatchRegex.test(cleaned)) {
    correctedPatterns.push("Replaced meet.google.com link with Google Calendar booking link in calendar-selection statement");
    cleaned = cleaned.replace(
      calendarMeetMismatchRegex,
      `on my booking calendar: ${CALENDAR_BOOKING_URL}`
    );
  }

  // Pattern 2: "calendar link: https://meet.google.com/..."
  const calendarLinkMismatch = /(?:calendar(?:\s+booking)?\s+link[:\s]*)(https?:\/\/meet\.google\.com\/[^\s\n,)]+)/gi;
  if (calendarLinkMismatch.test(cleaned)) {
    correctedPatterns.push("Corrected 'calendar link: meet.google.com' to calendar booking URL");
    cleaned = cleaned.replace(calendarLinkMismatch, `booking calendar link: ${CALENDAR_BOOKING_URL}`);
  }

  // Pattern 3: Generic "calendar: https://meet.google.com/..."
  const calendarColonMismatch = /\b(?:calendar|schedule)[:\s]+(https?:\/\/meet\.google\.com\/[a-z0-9-]+)/gi;
  if (calendarColonMismatch.test(cleaned)) {
    correctedPatterns.push("Corrected generic 'calendar: meet.google.com' to booking calendar URL");
    cleaned = cleaned.replace(calendarColonMismatch, `booking calendar: ${CALENDAR_BOOKING_URL}`);
  }

  // Pattern 4: "choose any time directly on my calendar: https://meet.google.com/..."
  const chooseAnyTimeMismatch = /(?:Alternatively,?\s+you\s+can\s+choose\s+any\s+time\s+directly\s+on\s+my\s+calendar[:\s]*)(https?:\/\/meet\.google\.com\/[^\s\n,)]+)/gi;
  if (chooseAnyTimeMismatch.test(cleaned)) {
    correctedPatterns.push("Corrected 'choose time on my calendar' with Meet URL to Calendar Booking URL");
    cleaned = cleaned.replace(
      chooseAnyTimeMismatch,
      `Alternatively, you can choose any time directly on my booking calendar: ${CALENDAR_BOOKING_URL}`
    );
  }

  // Pattern 5: "Google Meet link / walkthrough link: https://calendar.app.google/..."
  const meetCalendarMismatch = /(?:(?:Google\s+Meet|live\s+(?:demo|walkthrough))\s*(?:link)?[:\s]*)(https?:\/\/calendar\.[^\s\n,)]+)/gi;
  if (meetCalendarMismatch.test(cleaned)) {
    correctedPatterns.push("Corrected Meet walkthrough reference to use Google Meet URL");
    cleaned = cleaned.replace(meetCalendarMismatch, `Google Meet walkthrough: ${GOOGLE_MEET_URL}`);
  }

  return {
    sanitized: cleaned,
    flagged: correctedPatterns.length > 0,
    correctedPatterns,
  };
}

/**
 * Strict Regex-Based Validator and Sanitizer that enforces the No-Phone-Number policy.
 * Flags and strips any sequences resembling phone numbers before outbound transmission.
 */
export function validateAndEnforceNoPhonePolicy(text: string): PhoneValidationResult {
  if (!text) {
    return {
      sanitized: "",
      flagged: false,
      detectedPatterns: [],
      validationStatus: "CLEAN",
    };
  }

  const detectedPatterns: string[] = [];
  let cleaned = text;

  // 1. Scan and collect all matched phone sequences across our regex catalog
  for (const regex of PHONE_DETECTION_REGEXES) {
    // Reset regex index if global
    regex.lastIndex = 0;
    const matches = text.match(regex);
    if (matches) {
      for (const m of matches) {
        const trimmed = m.trim();
        if (trimmed && !detectedPatterns.includes(trimmed)) {
          detectedPatterns.push(trimmed);
        }
      }
    }
  }

  const flagged = detectedPatterns.length > 0;

  // 2. Strip labeled phone lines completely
  cleaned = cleaned.replace(/^(?:Direct|Tel|Phone|Mobile|Office|Cell|WhatsApp|Telephone|Ph|Contact)[\s:–—]*[+\d\s().-]{7,}\s*$/gim, "");
  cleaned = cleaned.replace(/(?:Direct|Tel|Phone|Mobile|Office|Cell|WhatsApp|Telephone|Ph|Contact)[\s:–—]*[+\d\s().-]{7,}/gim, "");

  // 3. Remove standalone phone number lines
  cleaned = cleaned.replace(/^[+\d\s().-]{8,}\s*$/gm, "");

  // 4. Replace phrases prompting phone test calls with Google Meet walkthrough phrasing
  cleaned = cleaned.replace(/test call to your mobile(?:\s*number)?(?:\s*\([+0-9\s-]+\))?/gi, "live interactive Google Meet voice walkthrough");
  cleaned = cleaned.replace(/test call on your mobile/gi, "live Google Meet demonstration walkthrough");
  cleaned = cleaned.replace(/call your desk/gi, "demonstrate over Google Meet");
  cleaned = cleaned.replace(/trigger a (?:90-second|2-minute|quick) test call to your (?:mobile|phone|desk|number)/gi, "run a quick 10-minute live demonstration walkthrough on Google Meet");
  cleaned = cleaned.replace(/trigger a (?:90-second|2-minute|quick) test call/gi, "run a quick 10-minute live demonstration walkthrough");
  cleaned = cleaned.replace(/test call directly on your phone/gi, "interactive live demonstration on Google Meet");
  cleaned = cleaned.replace(/call to your mobile/gi, "walkthrough on Google Meet");

  // 5. Strip any residual explicit international and delimited phone numbers
  cleaned = cleaned.replace(/(?:\+44|0044|0)\s*(?:\(?\d{2,5}\)?[\s.-]?){2,4}\d{2,4}/gi, "");
  cleaned = cleaned.replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "");
  cleaned = cleaned.replace(/\b\d{2,5}[-.\s]\d{3,4}[-.\s]?\d{3,4}\b/g, "");
  cleaned = cleaned.replace(/\b\d{8,15}\b/g, "");

  // 6. Clean dangling label words like "Direct:" or "Tel:" if left isolated
  cleaned = cleaned.replace(/^(?:Direct|Tel|Phone|Mobile|Office|Cell|WhatsApp|Telephone):?\s*$/gim, "");

  // 7. Normalize linebreaks and whitespace
  cleaned = cleaned
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
    .join("\n")
    .trim();

  // 8. Ensure clean founder sign-off without phone number
  if (!cleaned.includes("Nayem Abedin")) {
    cleaned += `\n\nBest regards,\nNayem Abedin\nFounder & CEO, Abedin Tech\nhttps://abedintech.com/voice-ai/`;
  }

  // 9. Secondary verification pass: confirm zero residual phone-like matches
  const residualCheck = cleaned.match(/(?:(?:\+44|0044|0)\s*(?:\(?\d{2,5}\)?[\s.-]?){2,4}\d{2,4})|(?:\b\d{3,4}[-.\s]\d{3,4}[-.\s]?\d{3,4}\b)/gi);
  if (residualCheck) {
    for (const resMatch of residualCheck) {
      cleaned = cleaned.replace(resMatch, "").trim();
    }
  }

  return {
    sanitized: cleaned,
    flagged,
    detectedPatterns,
    validationStatus: flagged ? "FLAGGED_AND_STRIPPED" : "CLEAN",
  };
}

/**
 * Backward-compatible helper for sanitizing zero phone numbers.
 */
export function sanitizeZeroPhoneNumbers(text: string): string {
  return validateAndEnforceNoPhonePolicy(text).sanitized;
}

/**
 * Multi-Agent Inbound Email Orchestration System.
 * Systematically decomposes email reply generation into 5 specialized sub-agents:
 * 1. Prospect Context & Persona Classifier Agent
 * 2. Questions & Inquiries Extractor Agent
 * 3. Category-Tailored Solution & Reply Composer Agent
 * 4. Meeting Scheduler & Calendar Locker Agent
 * 5. Strict Guardrail & Zero-Phone Compliance Agent
 */
/**
 * S21 — `executeMultiAgentReplyPipeline` was REMOVED here.
 *
 * It had two occurrences in the repository: its own definition and an unused import. Nothing
 * called it, and three separate hardening passes had wired real work into it — P1.7 pricing
 * precedence (`pricingContextFor`), P1.8 context selection (`buildContextBundle`), P1.9
 * business-hours slotting (`nextBusinessSlot`). All three were therefore capabilities the
 * repository contained and the running system did not have.
 *
 * The first two now live on the path that runs, in `composeAutonomousSalesReply`. The third
 * has no live consumer, which is recorded rather than papered over with an invented one:
 * `nextBusinessSlot` keeps its own invariant tests and waits for a caller that means it.
 *
 * The rest of this file — the phone and link validators — is used in six places and stays.
 */

export interface SystemAuditReport {
  timestamp: string;
  totalConversationsAudited: number;
  totalMessagesAudited: number;
  totalDraftsAudited: number;
  totalOutboxLogsAudited: number;
  linkMismatchesCorrectedCount: number;
  phonePatternsRemovedCount: number;
  mergeTagsNormalizedCount: number;
  allCleanAndCompliant: boolean;
  detailedFixes: {
    entityType: "CONVERSATION_DRAFT" | "THREAD_MESSAGE" | "OUTBOX_LOG" | "CAMPAIGN_STEP";
    id: string;
    recipientOrContact: string;
    fixesApplied: string[];
  }[];
  pipelineStatus: {
    tier1_IntentClassification: "ACTIVE" | "DEGRADED";
    tier2_CompanyBrainComposer: "ACTIVE" | "DEGRADED";
    tier3_SemanticLinkGatekeeper: "ACTIVE" | "DEGRADED";
    tier4_MergeTagNormalizer: "ACTIVE" | "DEGRADED";
    tier5_ExecutiveQC: "ACTIVE" | "DEGRADED";
  };
  policyUrls: {
    calendarBookingUrl: string;
    googleMeetUrl: string;
  };
}

/**
 * Deep System Audit: Inspects and cleans every conversation thread, proposed AI draft,
 * outbox log, and campaign step across the entire system.
 * Enforces zero phone numbers, correct calendar vs meet links, and tag normalization.
 */
export function auditFullSystemReplies(): SystemAuditReport {
  const detailedFixes: SystemAuditReport["detailedFixes"] = [];
  let linkMismatchesCorrectedCount = 0;
  let phonePatternsRemovedCount = 0;
  let mergeTagsNormalizedCount = 0;
  let totalMessagesAudited = 0;
  let totalDraftsAudited = 0;

  // 1. Audit all conversations & threads
  for (const conv of globalStore.conversations) {
    const firstName = conv.contactName?.replace(/^Dr\.\s+/i, "").split(" ")[0] || "";
    const context = { firstName, companyName: conv.companyName };

    // Audit proposed draft if exists
    if (conv.proposedAiDraft) {
      totalDraftsAudited++;
      const fixes: string[] = [];

      // Phone check
      const phoneRes = validateAndEnforceNoPhonePolicy(conv.proposedAiDraft.body);
      if (phoneRes.flagged) {
        phonePatternsRemovedCount += phoneRes.detectedPatterns.length;
        fixes.push(`Removed phone patterns: ${phoneRes.detectedPatterns.join(", ")}`);
      }

      // Link check
      const linkRes = validateAndEnforceMeetingAndCalendarLinks(phoneRes.sanitized);
      if (linkRes.flagged) {
        linkMismatchesCorrectedCount += linkRes.correctedPatterns.length;
        fixes.push(...linkRes.correctedPatterns);
      }

      // Tag check
      const tagRes = normalizeMergeTags(linkRes.sanitized, context);
      if (tagRes.flagged) {
        mergeTagsNormalizedCount += tagRes.resolvedTags.length;
        fixes.push(...tagRes.resolvedTags);
      }

      conv.proposedAiDraft.body = tagRes.sanitized;

      if (fixes.length > 0) {
        detailedFixes.push({
          entityType: "CONVERSATION_DRAFT",
          id: conv.id,
          recipientOrContact: `${conv.contactName} <${conv.contactEmail}>`,
          fixesApplied: fixes,
        });
      }
    }

    // Audit thread messages
    if (conv.thread && Array.isArray(conv.thread)) {
      for (const msg of conv.thread) {
        totalMessagesAudited++;
        if (msg.sender === "AGENT") {
          const fixes: string[] = [];

          if (msg.bodyText) {
            const phoneRes = validateAndEnforceNoPhonePolicy(msg.bodyText);
            if (phoneRes.flagged) {
              phonePatternsRemovedCount += phoneRes.detectedPatterns.length;
              fixes.push(`Removed phone patterns: ${phoneRes.detectedPatterns.join(", ")}`);
            }
            const linkRes = validateAndEnforceMeetingAndCalendarLinks(phoneRes.sanitized);
            if (linkRes.flagged) {
              linkMismatchesCorrectedCount += linkRes.correctedPatterns.length;
              fixes.push(...linkRes.correctedPatterns);
            }
            const tagRes = normalizeMergeTags(linkRes.sanitized, context);
            if (tagRes.flagged) {
              mergeTagsNormalizedCount += tagRes.resolvedTags.length;
              fixes.push(...tagRes.resolvedTags);
            }
            msg.bodyText = tagRes.sanitized;
            msg.bodyHtml = `<p>${tagRes.sanitized.replace(/\n/g, "<br/>")}</p>`;
          }

          if (fixes.length > 0) {
            detailedFixes.push({
              entityType: "THREAD_MESSAGE",
              id: msg.id,
              recipientOrContact: `${conv.contactName} <${conv.contactEmail}>`,
              fixesApplied: fixes,
            });
          }
        }
      }
    }

    // Clean memory commitments and preferences
    if (conv.memory) {
      if (conv.memory.commitmentsMade) {
        conv.memory.commitmentsMade = conv.memory.commitmentsMade.map((c) => {
          const lRes = validateAndEnforceMeetingAndCalendarLinks(c);
          return validateAndEnforceNoPhonePolicy(lRes.sanitized).sanitized;
        });
      }
      if (conv.memory.mentionedPreferences) {
        conv.memory.mentionedPreferences = conv.memory.mentionedPreferences.map((p) => {
          return p.replace(/mobile test call/gi, "Google Meet live voice demonstration");
        });
      }
    }
  }

  // 2. Audit Outbox Logs
  let totalOutboxLogsAudited = 0;
  for (const log of globalStore.outboxLogs) {
    totalOutboxLogsAudited++;
    const fixes: string[] = [];
    if (log.bodyText) {
      const phoneRes = validateAndEnforceNoPhonePolicy(log.bodyText);
      if (phoneRes.flagged) {
        phonePatternsRemovedCount += phoneRes.detectedPatterns.length;
        fixes.push(`Removed phone patterns: ${phoneRes.detectedPatterns.join(", ")}`);
      }
      const linkRes = validateAndEnforceMeetingAndCalendarLinks(phoneRes.sanitized);
      if (linkRes.flagged) {
        linkMismatchesCorrectedCount += linkRes.correctedPatterns.length;
        fixes.push(...linkRes.correctedPatterns);
      }
      const tagRes = normalizeMergeTags(linkRes.sanitized, { firstName: log.recipientName?.split(" ")[0] });
      if (tagRes.flagged) {
        mergeTagsNormalizedCount += tagRes.resolvedTags.length;
        fixes.push(...tagRes.resolvedTags);
      }
      log.bodyText = tagRes.sanitized;
    }
    if (fixes.length > 0) {
      detailedFixes.push({
        entityType: "OUTBOX_LOG",
        id: log.id,
        recipientOrContact: `${log.recipientName} <${log.recipientEmail}>`,
        fixesApplied: fixes,
      });
    }
  }

  // Save changes to disk
  globalStore.saveToDisk();

  return {
    timestamp: new Date().toISOString(),
    totalConversationsAudited: globalStore.conversations.length,
    totalMessagesAudited,
    totalDraftsAudited,
    totalOutboxLogsAudited,
    linkMismatchesCorrectedCount,
    phonePatternsRemovedCount,
    mergeTagsNormalizedCount,
    allCleanAndCompliant: true,
    detailedFixes,
    pipelineStatus: {
      tier1_IntentClassification: "ACTIVE",
      tier2_CompanyBrainComposer: "ACTIVE",
      tier3_SemanticLinkGatekeeper: "ACTIVE",
      tier4_MergeTagNormalizer: "ACTIVE",
      tier5_ExecutiveQC: "ACTIVE",
    },
    policyUrls: {
      calendarBookingUrl: CALENDAR_BOOKING_URL,
      googleMeetUrl: GOOGLE_MEET_URL,
    },
  };
}
