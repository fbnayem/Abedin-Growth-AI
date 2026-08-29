import { safeGenerateJSON } from "../geminiClient";
import { validateAndEnforceNoPhonePolicy, validateAndEnforceMeetingAndCalendarLinks } from "./multiAgentReplySystem";

export interface QCInspectionResult {
  decision: "PASS" | "REWRITE" | "HUMAN_REVIEW" | "BLOCK";
  score: number; // 0.0 - 1.0
  issues: string[];
  suggestedCorrection?: string;
  phonePolicyFlagged?: boolean;
  detectedPhonePatterns?: string[];
  linkPolicyFlagged?: boolean;
  correctedLinkPatterns?: string[];
  sanitizedBody?: string;
}

export async function inspectEmailDraft(input: {
  recipientEmail: string;
  recipientName: string;
  subject: string;
  body: string;
  campaignContext?: string;
}): Promise<QCInspectionResult> {
  // 1. Strict Regex Phone Policy Verification Step
  const phoneCheckSubject = validateAndEnforceNoPhonePolicy(input.subject);
  const phoneCheckBody = validateAndEnforceNoPhonePolicy(input.body);
  const hasPhoneNumbers = phoneCheckSubject.flagged || phoneCheckBody.flagged;
  const detectedPhonePatterns = [
    ...phoneCheckSubject.detectedPatterns,
    ...phoneCheckBody.detectedPatterns,
  ];

  // 2. Strict Semantic Link Verification Step (Calendar Booking vs. Google Meet Room)
  const linkCheckSubject = validateAndEnforceMeetingAndCalendarLinks(phoneCheckSubject.sanitized);
  const linkCheckBody = validateAndEnforceMeetingAndCalendarLinks(phoneCheckBody.sanitized);
  const hasLinkMismatch = linkCheckSubject.flagged || linkCheckBody.flagged;
  const correctedLinkPatterns = [
    ...linkCheckSubject.correctedPatterns,
    ...linkCheckBody.correctedPatterns,
  ];

  const hasUnresolvedTags =
    /\{\{.*?\}\}|\[.*?\]/.test(input.body) ||
    /\{\{.*?\}\}|\[.*?\]/.test(input.subject);

  const issuesList: string[] = [];
  if (hasUnresolvedTags) {
    issuesList.push("Contains unresolved template merge tags");
  }
  if (hasPhoneNumbers) {
    issuesList.push(`Violates strict Zero-Phone Policy: detected phone sequence (${detectedPhonePatterns.join(", ")})`);
  }
  if (hasLinkMismatch) {
    issuesList.push(`Corrected link semantic mismatch (${correctedLinkPatterns.join("; ")})`);
  }

  const fallbackData: QCInspectionResult = {
    decision: hasUnresolvedTags ? "HUMAN_REVIEW" : hasPhoneNumbers ? "REWRITE" : "PASS",
    score: hasUnresolvedTags ? 0.6 : hasPhoneNumbers ? 0.75 : 0.95,
    issues: issuesList,
    suggestedCorrection: linkCheckBody.sanitized,
    phonePolicyFlagged: hasPhoneNumbers,
    detectedPhonePatterns,
    linkPolicyFlagged: hasLinkMismatch,
    correctedLinkPatterns,
    sanitizedBody: linkCheckBody.sanitized,
  };

  const prompt = `
You are the Executive Email Quality Control and Compliance Guardian for an enterprise AI outbound engine.
Review the following outbound message before it is transmitted:

Recipient: ${input.recipientName} (${input.recipientEmail})
Subject: "${input.subject}"
Body:
${input.body}

Inspect for:
1. STRICT ZERO-PHONE POLICY: No telephone numbers, direct phone lines, or mobile call invitations are allowed. If present, flag as issue and strip them.
2. LINK SEMANTICS:
   - Calendar booking must link to Google Calendar (https://calendar.app.google/abedin-voice-ai-demo)
   - Live video room must link to Google Meet (https://meet.google.com/abn-vce-demo)
   - Never call a Google Meet link a "calendar".
3. Fake personalization or broken merge tags (e.g. {{companyName}}, [FIRSTNAME])
4. Aggressive spam words or deceptive subject lines
5. Unverified claims (e.g. "guaranteed 1000% returns tomorrow")
6. Hallucinated pricing or binding legal commitments
7. Excessive length, awkward tone, or grammatical defects

Return ONLY valid JSON matching this exact structure:
{
  "decision": "PASS",
  "score": 0.96,
  "issues": [],
  "suggestedCorrection": ""
}

Decision must be one of: "PASS", "REWRITE", "HUMAN_REVIEW", or "BLOCK".
`;

  const data = await safeGenerateJSON<{
    decision?: "PASS" | "REWRITE" | "HUMAN_REVIEW" | "BLOCK";
    score?: number;
    issues?: string[];
    suggestedCorrection?: string;
  }>({
    prompt,
    category: "FAST",
    temperature: 0.1,
    fallbackData,
    agentName: "qualityControlAgent",
  });

  const combinedIssues = Array.from(new Set([...(data.issues || []), ...issuesList]));
  const finalSanitized = linkCheckBody.sanitized;

  return {
    decision: hasPhoneNumbers ? (data.decision === "BLOCK" ? "BLOCK" : "PASS") : (data.decision || fallbackData.decision),
    score: hasPhoneNumbers ? Math.min(data.score ?? 0.9, 0.92) : (data.score ?? fallbackData.score),
    issues: combinedIssues,
    suggestedCorrection: finalSanitized,
    phonePolicyFlagged: hasPhoneNumbers,
    detectedPhonePatterns,
    linkPolicyFlagged: hasLinkMismatch,
    correctedLinkPatterns,
    sanitizedBody: finalSanitized,
  };
}
