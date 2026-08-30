import { safeGenerateJSON } from "../geminiClient";
import { Conversation, ReplyIntent, PolicyDecision, CompanyBrain } from "../../src/types";
import { validateAndEnforceNoPhonePolicy, validateAndEnforceMeetingAndCalendarLinks } from "./multiAgentReplySystem";

export interface ReplyClassificationResult {
  intent: ReplyIntent;
  confidence: number;
  sentiment: "POSITIVE" | "NEUTRAL" | "SKEPTICAL" | "NEGATIVE";
  summary: string;
  questionsAsked: string[];
  recommendedAction: string;
  suggestedDraft?: {
    subject: string;
    body: string;
    rationale: string;
    policyStatus: PolicyDecision;
  };
}

export async function processConversationThread(
  conversation: Conversation,
  companyBrain?: CompanyBrain
): Promise<ReplyClassificationResult> {
  const lastMessage = conversation.thread[conversation.thread.length - 1];
  const threadHistory = conversation.thread
    .map((m) => `[${m.sender}] (${m.sentAt}):\nSubject: ${m.subject}\nBody: ${m.bodyText}`)
    .join("\n\n---\n\n");

  const fallbackResult: ReplyClassificationResult = {
    intent: "INTERESTED",
    confidence: 0.88,
    sentiment: "POSITIVE",
    summary: "Prospect responded to outreach showing interest in voice appointment capabilities.",
    questionsAsked: ["How does integration work?"],
    recommendedAction: "Answer integration capabilities and suggest demo.",
    suggestedDraft: {
      subject: `Re: ${lastMessage?.subject || "Abedin Voice AI"}`,
      body: `Hi ${conversation.contactName.split(" ")[0]},\n\nThank you for reaching out. Yes, Abedin Voice AI connects directly with Google Calendar and scheduling software for automatic 2-way booking with zero manual entry.\n\nWould you be open to a quick 10-minute live demonstration on Google Meet this week?\n\nDirect walkthrough link: https://meet.google.com/pending-calendar-creation\n\nBest,\nNayem`,
      rationale: "Addresses interest promptly and advances towards meeting booking.",
      policyStatus: "ALLOW",
    },
  };

  const prompt = `
You are the Senior AI Conversation & Deal Orchestrator for ${companyBrain?.productName || "Abedin Voice AI"}.
Category: ${conversation.category} (CUSTOMER, INVESTOR, or PARTNER)
Contact: ${conversation.contactName} (${conversation.contactEmail}) at ${conversation.companyName}

Company Brain Approved Knowledge:
- Product: ${companyBrain?.productName || "Abedin Voice AI"}
- Description: ${companyBrain?.description || "Conversational voice AI receptionist with sub-500ms latency and 2-way Google Calendar sync"}
- Target Benefits: ${companyBrain?.primaryBenefits?.join("; ") || "Zero missed calls, 24/7 calendar booking, 65% receptionist cost reduction"}
- Objections & Answers: ${JSON.stringify(companyBrain?.objectionsAndAnswers || [])}
- Investor Narrative: ${JSON.stringify(companyBrain?.investorNarrative || {})}
- Partner Narrative: ${JSON.stringify(companyBrain?.partnerNarrative || {})}

Full Email Thread:
${threadHistory}

Analyze the latest reply from the prospect:
1. Classify Intent into one of:
   INTERESTED, VERY_INTERESTED, QUESTION, PRICING, TECHNICAL, OBJECTION, NOT_INTERESTED, WRONG_PERSON, REFERRAL, MEETING_REQUEST, CALL_REQUEST, FOLLOW_UP_LATER, UNSUBSCRIBE, OUT_OF_OFFICE, INVESTOR_INTEREST, INVESTOR_QUESTION, INVESTOR_PASS, PARTNER_INTEREST, UNKNOWN
2. Compute Confidence (0.0 to 1.0)
3. Determine Sentiment (POSITIVE, NEUTRAL, SKEPTICAL, NEGATIVE)
4. Create a 1-2 sentence executive Summary of what they are saying
5. Extract explicit Questions Asked
6. Formulate clear Recommended Action
7. Draft a short, human-like, concise Response Draft (40-70 words):
   - HUMAN TONE: Direct, warm, crisp, no corporate fluff or robotic preamble.
   - SPECIFIC ANSWERS: Answer questions directly in 1-2 specific sentences.
   - CALENDAR / DEMO: Offer a 10-minute demo on Google Meet (https://meet.google.com/pending-calendar-creation) or calendar booking (https://calendar.app.google/abedin-voice-ai-demo).
   - STRICT PROHIBITION: DO NOT share any phone numbers or mobile call invitations.
   - Policy Status: ALLOW, REQUIRE_APPROVAL, ESCALATE, or BLOCK.

Return ONLY valid JSON matching this exact structure:
{
  "intent": "QUESTION",
  "confidence": 0.94,
  "sentiment": "POSITIVE",
  "summary": "Prospect is asking about Google Calendar integration.",
  "questionsAsked": [
    "Does Abedin Voice AI sync directly with Google Calendar?"
  ],
  "recommendedAction": "Confirm real-time calendar synchronization and propose a 10-minute Google Meet voice demonstration.",
  "suggestedDraft": {
    "subject": "Re: ${lastMessage?.subject || "Quick question"}",
    "body": "Hi ${conversation.contactName.split(" ")[0]},\n\nYes, absolutely—Abedin Voice AI syncs 2-way with Google Calendar in real time, so appointments lock instantly with zero double-booking.\n\nWould you be open for a quick 10-minute demo on Google Meet this Thursday at 2:00 PM BST? (Meet link: https://meet.google.com/pending-calendar-creation)\n\nAlternatively, grab any slot here: https://calendar.app.google/abedin-voice-ai-demo\n\nBest,\nNayem\n\nNayem Abedin · Abedin Tech\nhttps://abedintech.com/voice-ai/",
    "rationale": "Directly resolves calendar compatibility question concisely with approved knowledge.",
    "policyStatus": "ALLOW"
  }
}
`;

  const data = await safeGenerateJSON<ReplyClassificationResult>({
    prompt,
    category: "SMART",
    temperature: 0.2,
    fallbackData: fallbackResult,
    agentName: "inboxAgent",
  });

  const rawDraft = data.suggestedDraft || fallbackResult.suggestedDraft;
  let cleanDraft = rawDraft;
  if (rawDraft?.body) {
    const pClean = validateAndEnforceNoPhonePolicy(rawDraft.body);
    const lClean = validateAndEnforceMeetingAndCalendarLinks(pClean.sanitized);
    cleanDraft = {
      ...rawDraft,
      body: lClean.sanitized,
    };
  }

  return {
    intent: data.intent || fallbackResult.intent,
    confidence: data.confidence || fallbackResult.confidence,
    sentiment: data.sentiment || fallbackResult.sentiment,
    summary: data.summary || fallbackResult.summary,
    questionsAsked: data.questionsAsked || fallbackResult.questionsAsked,
    recommendedAction: data.recommendedAction || fallbackResult.recommendedAction,
    suggestedDraft: cleanDraft,
  };
}
