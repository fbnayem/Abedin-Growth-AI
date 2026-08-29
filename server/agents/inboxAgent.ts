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
      body: `Hi ${conversation.contactName.split(" ")[0]},\n\nThank you for reaching out. Yes, Abedin Voice AI connects directly with Google Calendar and scheduling software for automatic 2-way booking with zero manual entry.\n\nWould you be open to a quick 10-minute live demonstration on Google Meet this week?\n\nDirect walkthrough link: https://meet.google.com/abn-vce-demo\n\nBest,\nNayem`,
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
7. Draft a high-conversion, polite, concise Response Draft that strictly relies on approved knowledge:
   - If they ask for a demo or meeting: Suggest booking a demo on Google Meet (https://meet.google.com/abn-vce-demo) or offer two concrete time slots.
   - If they ask about custom enterprise pricing or valuation: State the starting model or escalate for founder review (DO NOT fabricate valuation or unverified pricing).
   - STRICT PROHIBITION: DO NOT share any phone numbers, telephone digits, or mobile call invitations in the email.
   - Policy Status: ALLOW, REQUIRE_APPROVAL, ESCALATE, or BLOCK.

Return ONLY valid JSON matching this exact structure:
{
  "intent": "QUESTION",
  "confidence": 0.94,
  "sentiment": "POSITIVE",
  "summary": "Prospect is interested in Voice AI for their appointment bookings and asked whether it integrates with Google Calendar and practice software.",
  "questionsAsked": [
    "Does Abedin Voice AI sync directly with our Google Calendar?",
    "What is the setup timeframe?"
  ],
  "recommendedAction": "Confirm real-time calendar synchronization and propose a 15-minute live Google Meet voice demonstration.",
  "suggestedDraft": {
    "subject": "Re: ${lastMessage?.subject || "Quick question"}",
    "body": "Hi ${conversation.contactName.split(" ")[0]},\n\nThanks for getting back to me! Yes, absolutely—Abedin Voice AI features native 2-way synchronization with Google Calendar and major scheduling systems in real time, so double-bookings are impossible.\n\nSetup typically takes under 15 minutes.\n\nWould you be open to a quick 10-minute live demonstration on Google Meet this Thursday at 2:00 PM or Friday at 10:30 AM?\n\nDirect walkthrough link: https://meet.google.com/abn-vce-demo\n\nBest regards,\nNayem",
    "rationale": "Directly resolves calendar compatibility question with approved knowledge and provides clear call-to-action.",
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
