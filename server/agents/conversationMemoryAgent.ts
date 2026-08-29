import { safeGenerateJSON } from "../geminiClient";
import { Conversation, ConversationMemory, CompanyBrain, EmailMessage } from "../../src/types";
import { validateAndEnforceNoPhonePolicy, validateAndEnforceMeetingAndCalendarLinks } from "./multiAgentReplySystem";

/**
 * Intelligent Conversation Memory Engine.
 * Extracts, maintains, and updates persistent memory for each conversation.
 * Synthesizes the FULL conversation thread so all replies and follow-ups
 * maintain context, remember commitments, avoid repeating answers, and reference earlier topics.
 */
export async function extractAndSynthesizeMemory(
  conversation: Conversation,
  companyBrain?: CompanyBrain
): Promise<ConversationMemory> {
  const thread = conversation.thread || [];
  const firstName = conversation.contactName.replace(/^Dr\.\s+/i, "").split(" ")[0] || conversation.contactName;

  // Build complete chronological transcript
  const transcript = thread
    .map(
      (m, idx) =>
        `[Message #${idx + 1}] FROM: ${
          m.sender === "PROSPECT" ? `${conversation.contactName} (PROSPECT)` : "Nayem Abedin (FOUNDER/AGENT)"
        } (${m.sentAt}):\nSubject: ${m.subject}\nBody:\n${m.bodyText}`
    )
    .join("\n\n--------------------\n\n");

  const prompt = `
You are the Chief Intelligence & Memory Synthesis Agent for ${companyBrain?.companyName || "Abedin Tech"}.
Your job is to analyze the COMPLETE conversation history between Nayem Abedin (Founder) and the prospect, and extract/synthesize a comprehensive, persistent Conversation Memory.

PROSPECT DETAILS:
- Name: ${conversation.contactName} (${firstName})
- Email: ${conversation.contactEmail}
- Company: ${conversation.companyName}
- Title: ${conversation.contactTitle || "Decision Maker"}
- Category: ${conversation.category}

FULL CONVERSATION TRANSCRIPT (${thread.length} messages total):
${transcript}

TASK:
Deeply parse all messages in the transcript and extract:
1. "keyPainPoints": List of specific operational/clinical pains, lost revenue, missed phone calls, staffing bottlenecks, or challenges mentioned by the prospect or addressed in the thread.
2. "mentionedPreferences": List of specific software, schedule preferences (e.g. "prefers Thursday afternoons", "uses Dentally/Cliniko", "wants test call on mobile").
3. "objectionsResolved": Specific questions or concerns that have been answered in this thread (e.g. "2-way Google Calendar sync confirmed", "sub-500ms voice latency guaranteed", "pricing structure explained").
4. "commitmentsMade": Specific links, proposals, or promises made by Nayem/the agent in previous emails (e.g. "Shared Google Meet demo link https://meet.google.com/abn-vce-demo", "Offered 14-day zero-risk trial", "Offered mobile live test call").
5. "agreedTimeSlots": Any specific dates or time slots proposed or agreed upon (e.g. "Thursday 2:30 PM BST").
6. "prospectSentiment": One of "HIGHLY_INTERESTED", "EVALUATING", "PRICE_CONSCIOUS", "TECHNICAL_DEEP_DIVE", "SKEPTICAL", "READY_TO_BOOK".
7. "keyFactsExtracted": Key-value dictionary of extracted facts (e.g., { "phoneSystem": "VoIP", "missedCallsPerWeek": "15-20", "locationCount": "2" }).
8. "threadSummaryChronological": 2 to 4 bullet points summarizing the chronological progression of this conversation from outreach to latest response.

Return strictly JSON matching this structure:
{
  "keyPainPoints": ["..."],
  "mentionedPreferences": ["..."],
  "objectionsResolved": ["..."],
  "commitmentsMade": ["..."],
  "agreedTimeSlots": ["..."],
  "prospectSentiment": "HIGHLY_INTERESTED",
  "keyFactsExtracted": {
    "key": "value"
  },
  "threadSummaryChronological": [
    "Step 1: Initial outreach sent introducing Abedin Voice AI for clinic after-hours calls.",
    "Step 2: Prospect replied asking about Google Calendar integration and emergency triage."
  ]
}
`;

  // Compute deterministic baseline fallback memory
  const prospectMsgs = thread.filter((m) => m.sender === "PROSPECT");
  const agentMsgs = thread.filter((m) => m.sender === "AGENT");
  
  const fallbackPains: string[] = [];
  const fallbackPreferences: string[] = [];
  const fallbackObjections: string[] = [];
  const fallbackCommitments: string[] = [];
  const fallbackTimeSlots: string[] = [];
  const fallbackFacts: Record<string, string> = {};

  const fullText = thread.map((m) => m.bodyText).join(" ").toLowerCase();

  if (fullText.includes("weekend") || fullText.includes("after-hours") || fullText.includes("missed")) {
    fallbackPains.push("Missed patient inquiries after hours and on weekends");
  }
  if (fullText.includes("lunch") || fullText.includes("peak") || fullText.includes("overload") || fullText.includes("queue")) {
    fallbackPains.push("Reception phone overload during peak morning check-in hours");
  }
  if (fullText.includes("calendar") || fullText.includes("google")) {
    fallbackPreferences.push("Requires seamless 2-way calendar sync without manual double-entry");
    fallbackObjections.push("Confirmed native 2-way Google Calendar real-time reservation sync");
  }
  if (fullText.includes("meet.google.com") || fullText.includes("zoom") || fullText.includes("demo")) {
    fallbackCommitments.push("Dispatched Google Meet walkthrough room link: https://meet.google.com/abn-vce-demo");
  }
  if (fullText.includes("thursday")) {
    fallbackTimeSlots.push("Thursday 2:30 PM BST");
  }
  if (fullText.includes("friday")) {
    fallbackTimeSlots.push("Friday 11:00 AM BST");
  }

  const fallbackMemory: ConversationMemory = {
    keyPainPoints: fallbackPains.length > 0 ? fallbackPains : ["Dropped phone calls during busy clinic hours"],
    mentionedPreferences: fallbackPreferences.length > 0 ? fallbackPreferences : ["Prefers live Google Meet demo walkthrough and direct calendar booking"],
    objectionsResolved: fallbackObjections.length > 0 ? fallbackObjections : ["Sub-500ms voice response speed and zero double-booking architecture"],
    commitmentsMade: fallbackCommitments.length > 0 ? fallbackCommitments : ["14-day zero-risk trial and Google Meet walkthrough reservation link"],
    agreedTimeSlots: fallbackTimeSlots.length > 0 ? fallbackTimeSlots : ["Thursday 2:30 PM BST"],
    prospectSentiment: prospectMsgs.length > 0 ? "HIGHLY_INTERESTED" : "EVALUATING",
    keyFactsExtracted: {
      practiceName: conversation.companyName,
      contactPerson: conversation.contactName,
      channel: "EMAIL",
      totalExchanges: `${thread.length} messages (${agentMsgs.length} sent, ${prospectMsgs.length} inbound)`,
      ...fallbackFacts,
    },
    threadSummaryChronological: [
      `1. Initial tailored outreach dispatched to ${conversation.contactName} at ${conversation.companyName}.`,
      prospectMsgs.length > 0
        ? `2. Prospect engaged regarding clinic phone answering and appointment booking.`
        : `2. Outreach active, monitoring for inbound response or automated follow-up window.`,
    ],
    followUpCount: Math.max(0, agentMsgs.length - 1),
    lastUpdated: new Date().toISOString(),
  };

  try {
    const aiMemory = await safeGenerateJSON<Partial<ConversationMemory>>({
      prompt,
      category: "SMART",
      temperature: 0.2,
      fallbackData: fallbackMemory,
      agentName: "conversationMemoryAgent",
    });

    return {
      keyPainPoints: aiMemory.keyPainPoints && aiMemory.keyPainPoints.length > 0 ? aiMemory.keyPainPoints : fallbackMemory.keyPainPoints,
      mentionedPreferences: aiMemory.mentionedPreferences && aiMemory.mentionedPreferences.length > 0 ? aiMemory.mentionedPreferences : fallbackMemory.mentionedPreferences,
      objectionsResolved: aiMemory.objectionsResolved && aiMemory.objectionsResolved.length > 0 ? aiMemory.objectionsResolved : fallbackMemory.objectionsResolved,
      commitmentsMade: aiMemory.commitmentsMade && aiMemory.commitmentsMade.length > 0 ? aiMemory.commitmentsMade : fallbackMemory.commitmentsMade,
      agreedTimeSlots: aiMemory.agreedTimeSlots && aiMemory.agreedTimeSlots.length > 0 ? aiMemory.agreedTimeSlots : fallbackMemory.agreedTimeSlots,
      prospectSentiment: (aiMemory.prospectSentiment as any) || fallbackMemory.prospectSentiment,
      keyFactsExtracted: {
        ...fallbackMemory.keyFactsExtracted,
        ...(aiMemory.keyFactsExtracted || {}),
      },
      threadSummaryChronological:
        aiMemory.threadSummaryChronological && aiMemory.threadSummaryChronological.length > 0
          ? aiMemory.threadSummaryChronological
          : fallbackMemory.threadSummaryChronological,
      followUpCount: Math.max(0, agentMsgs.length - 1),
      lastUpdated: new Date().toISOString(),
    };
  } catch (error) {
    console.error("Memory extraction error, using fallback:", error);
    return fallbackMemory;
  }
}

/**
 * Generates a high-conversion, memory-aware reply that deeply checks
 * the complete thread transcript and the persistent memory dossier.
 */
export async function generateMemoryAwareReply(
  conversation: Conversation,
  companyBrain?: CompanyBrain,
  customInstructions?: string
): Promise<{
  subject: string;
  body: string;
  detectedIntent: string;
  shouldBookMeetingNow: boolean;
  meetingTimeParsed?: string;
  memory: ConversationMemory;
}> {
  // 1. Ensure up-to-date memory
  const memory = await extractAndSynthesizeMemory(conversation, companyBrain);

  const thread = conversation.thread || [];
  const lastMsg = thread[thread.length - 1];
  const prospectReplies = thread.filter((m) => m.sender === "PROSPECT");
  const lastProspectMsg = prospectReplies[prospectReplies.length - 1] || lastMsg;
  const firstName = conversation.contactName.replace(/^Dr\.\s+/i, "").split(" ")[0] || conversation.contactName;

  // Build full transcript for the prompt
  const fullTranscript = thread
    .map(
      (m, idx) =>
        `[Message #${idx + 1}] ${
          m.sender === "PROSPECT" ? `${conversation.contactName} (PROSPECT)` : "Nayem Abedin (FOUNDER)"
        } (${m.sentAt}):\nSubject: ${m.subject}\nBody:\n${m.bodyText}`
    )
    .join("\n\n---\n\n");

  const prompt = `
You are Nayem Abedin, Founder & CEO of Abedin Tech (creators of Abedin Voice AI).
You are drafting an email reply to a prospect.

CRITICAL DIRECTIVE:
You MUST check and leverage the FULL conversation history and the allocated Conversation Memory Dossier.
Do NOT reply blindly to only the latest message. Maintain total continuity, remember previous promises, acknowledge specific constraints or pain points previously stated, and never repeat explanations already agreed upon.

PROSPECT PROFILE:
- Name: ${conversation.contactName} (${firstName})
- Email: ${conversation.contactEmail}
- Company/Practice: ${conversation.companyName}
- Title: ${conversation.contactTitle || "Decision Maker"}
- Category: ${conversation.category}

CONVERSATION MEMORY DOSSIER:
- Known Pain Points: ${JSON.stringify(memory.keyPainPoints)}
- Stated Preferences & Requirements: ${JSON.stringify(memory.mentionedPreferences)}
- Objections/Questions Already Resolved: ${JSON.stringify(memory.objectionsResolved)}
- Previous Commitments/Links Made: ${JSON.stringify(memory.commitmentsMade)}
- Agreed/Proposed Time Slots: ${JSON.stringify(memory.agreedTimeSlots)}
- Prospect Sentiment: ${memory.prospectSentiment}
- Key Facts: ${JSON.stringify(memory.keyFactsExtracted)}
- Chronological Thread Progress: ${JSON.stringify(memory.threadSummaryChronological)}

FULL CONVERSATION HISTORY (${thread.length} total messages):
${fullTranscript}

LATEST PROSPECT REPLY:
"${lastProspectMsg?.bodyText || ""}"

${customInstructions ? `CUSTOM OPERATOR INSTRUCTIONS:\n${customInstructions}\n` : ""}

KNOWLEDGE BASE & VALUE PROPOSITIONS:
- Sub-500ms voice response latency (feels 100% natural, eliminating awkward delays).
- 2-Way Live Sync with Google Calendar and clinic practice software (zero double-bookings).
- 24/7 autonomous phone answering for after-hours, emergencies, and overflow triage.
- Zero-risk 14-day live practice pilot setup in 15 minutes.
- Flat £499/month pricing with 99.9% uptime SLA (capturing 2 private appointments pays for entire month).
- Demo Room URL: https://meet.google.com/abn-vce-demo

GUIDELINES:
1. Write in a thoughtful, direct founder voice (Nayem Abedin). No marketing flyers, no robotic clichés.
2. Directly address the prospect's latest questions while referencing context from earlier messages when relevant.
3. If they propose a date/time (or ask to book/meet): enthusiastically confirm, state you've locked in the slot, provide Google Meet live demo room link: https://meet.google.com/abn-vce-demo, and set "shouldBookMeetingNow" to true.
4. STRICT BAN ON PHONE NUMBERS & LINK SEMANTICS:
   - Never include phone numbers or mobile test call phrases.
   - For choosing/booking a calendar slot, use Google Calendar Booking: https://calendar.app.google/abedin-voice-ai-demo
   - For the live video meeting room itself, use Google Meet: https://meet.google.com/abn-vce-demo
   - NEVER call a Google Meet link a "calendar link".
5. Keep length concise (85-140 words).

Sign off:
Best regards,
Nayem Abedin
Founder & CEO, Abedin Tech
https://abedintech.com/voice-ai/

Return JSON strictly matching:
{
  "subject": "Re: ${lastMsg?.subject?.replace(/^Re:\s*/i, "") || "Quick question"}",
  "body": "...",
  "detectedIntent": "MEETING_CONFIRMED | DEMO_REQUEST | PRICING_INQUIRY | QUESTION | INTERESTED",
  "shouldBookMeetingNow": true/false,
  "meetingTimeParsed": "Thursday at 2:30 PM BST"
}
`;

  const fallbackSubject = `Re: ${lastMsg?.subject?.replace(/^Re:\s*/i, "") || "Abedin Voice AI"}`;
  const fallbackBody = `Hi ${firstName},\n\nThanks for getting back to me! Yes, absolutely—Abedin Voice AI operates with native 2-way real-time synchronization with Google Calendar and clinical management systems, so booked appointments push directly into your schedule with zero double-bookings.\n\nI would love to walk you through a quick 10-minute live demonstration on Google Meet so you can experience the sub-500ms voice response firsthand. Are you free this Thursday at 2:30 PM BST or Friday at 11:00 AM BST (Meet link: https://meet.google.com/abn-vce-demo)?\n\nAlternatively, you can choose any time directly on my booking calendar: https://calendar.app.google/abedin-voice-ai-demo\n\nLooking forward to speaking!\n\nBest regards,\nNayem Abedin\nFounder & CEO, Abedin Tech\nhttps://abedintech.com/voice-ai/`;

  try {
    const aiResp = await safeGenerateJSON<{
      subject: string;
      body: string;
      detectedIntent: string;
      shouldBookMeetingNow: boolean;
      meetingTimeParsed?: string;
    }>({
      prompt,
      category: "SMART",
      temperature: 0.25,
      fallbackData: {
        subject: fallbackSubject,
        body: fallbackBody,
        detectedIntent: "QUESTION",
        shouldBookMeetingNow: true,
        meetingTimeParsed: memory.agreedTimeSlots[0] || "Thursday at 2:30 PM BST",
      },
      agentName: "conversationMemoryReplyAgent",
    });

    const rawBody = aiResp.body || fallbackBody;
    const phoneClean = validateAndEnforceNoPhonePolicy(rawBody);
    const linkClean = validateAndEnforceMeetingAndCalendarLinks(phoneClean.sanitized);

    return {
      subject: aiResp.subject || fallbackSubject,
      body: linkClean.sanitized,
      detectedIntent: aiResp.detectedIntent || "INTERESTED",
      shouldBookMeetingNow: Boolean(aiResp.shouldBookMeetingNow),
      meetingTimeParsed: aiResp.meetingTimeParsed || memory.agreedTimeSlots[0] || "",
      memory,
    };
  } catch (err) {
    console.error("Memory aware reply generation error:", err);
    const phoneClean = validateAndEnforceNoPhonePolicy(fallbackBody);
    const linkClean = validateAndEnforceMeetingAndCalendarLinks(phoneClean.sanitized);
    return {
      subject: fallbackSubject,
      body: linkClean.sanitized,
      detectedIntent: "QUESTION",
      shouldBookMeetingNow: true,
      meetingTimeParsed: memory.agreedTimeSlots[0] || "Thursday at 2:30 PM BST",
      memory,
    };
  }
}

/**
 * Generates a memory-aware follow-up email that checks the entire conversation thread,
 * previous pitch points, and memory dossier to write a high-value, natural follow-up.
 */
export async function generateMemoryAwareFollowUp(
  conversation: Conversation,
  companyBrain?: CompanyBrain,
  customInstructions?: string
): Promise<{
  subject: string;
  body: string;
  followUpStep: number;
  memory: ConversationMemory;
}> {
  const memory = await extractAndSynthesizeMemory(conversation, companyBrain);
  const thread = conversation.thread || [];
  const lastMsg = thread[thread.length - 1];
  const firstName = conversation.contactName.replace(/^Dr\.\s+/i, "").split(" ")[0] || conversation.contactName;
  const followUpStep = (memory.followUpCount || 0) + 1;

  const fullTranscript = thread
    .map(
      (m, idx) =>
        `[Message #${idx + 1}] ${
          m.sender === "PROSPECT" ? `${conversation.contactName} (PROSPECT)` : "Nayem Abedin (FOUNDER)"
        } (${m.sentAt}):\nSubject: ${m.subject}\nBody:\n${m.bodyText}`
    )
    .join("\n\n---\n\n");

  const prompt = `
You are Nayem Abedin, Founder & CEO of Abedin Tech.
You are writing a context-aware FOLLOW-UP email to ${conversation.contactName} (${firstName}) at ${conversation.companyName}.

CURRENT FOLLOW-UP STEP: #${followUpStep}

CONVERSATION MEMORY DOSSIER:
- Known Pain Points: ${JSON.stringify(memory.keyPainPoints)}
- Stated Preferences: ${JSON.stringify(memory.mentionedPreferences)}
- Objections/Questions Already Handled: ${JSON.stringify(memory.objectionsResolved)}
- Commitments Made: ${JSON.stringify(memory.commitmentsMade)}
- Chronological Thread Milestones: ${JSON.stringify(memory.threadSummaryChronological)}

FULL CONVERSATION TRANSCRIPT:
${fullTranscript}

${customInstructions ? `OPERATOR INSTRUCTIONS:\n${customInstructions}\n` : ""}

FOLLOW-UP STRATEGY BY STEP:
- Step 1 / Gentle Follow-Up: Check in on the previous note, mention the interactive Google Meet walkthrough or zero-risk 14-day trial, offer two flexible time slots (Thursday 2:30 PM / Friday 11:00 AM) or booking calendar link: https://calendar.app.google/abedin-voice-ai-demo.
- Step 2 / Tangible Value Proof: Share specific benchmark (e.g. recovering 15-20 missed weekend patient appointments, £5,000+ monthly revenue lift, sub-500ms voice speed).
- Step 3 / Permission to close loop: Friendly founder check-in acknowledging their busy schedule, leaving the door open.

CRITICAL RULES:
- Strictly NO phone numbers in body or signature.
- If referencing calendar scheduling/booking: use https://calendar.app.google/abedin-voice-ai-demo
- If referencing live video walkthrough room: use Google Meet https://meet.google.com/abn-vce-demo
- 60 to 110 words maximum.

Return strictly JSON:
{
  "subject": "Re: ${lastMsg?.subject?.replace(/^Re:\s*/i, "") || "Quick question"}",
  "body": "..."
}
`;

  const fallbackBody = `Hi ${firstName},\n\nFollowing up on my previous note. Most practice managers we work with lose an estimated £5,040/month in dropped private patient consultations when phones are busy or closed after hours.\n\nAbedin Voice AI operates alongside your existing front desk—acting as an instant overflow safety net with sub-500ms voice response and direct Google Calendar booking.\n\nWould you be open to a 10-minute live demonstration on Google Meet this Thursday at 2:30 PM or Friday at 11:00 AM BST (Meet link: https://meet.google.com/abn-vce-demo)?\n\nAlternatively, you can book any slot on my booking calendar: https://calendar.app.google/abedin-voice-ai-demo\n\nBest regards,\nNayem Abedin\nFounder & CEO, Abedin Tech\nhttps://abedintech.com/voice-ai/`;

  try {
    const aiResp = await safeGenerateJSON<{ subject: string; body: string }>({
      prompt,
      category: "SMART",
      temperature: 0.25,
      fallbackData: {
        subject: `Re: ${lastMsg?.subject?.replace(/^Re:\s*/i, "") || "Abedin Voice AI"}`,
        body: fallbackBody,
      },
      agentName: "conversationMemoryFollowUpAgent",
    });

    const rawBody = aiResp.body || fallbackBody;
    const phoneClean = validateAndEnforceNoPhonePolicy(rawBody);
    const linkClean = validateAndEnforceMeetingAndCalendarLinks(phoneClean.sanitized);

    return {
      subject: aiResp.subject || `Re: ${lastMsg?.subject?.replace(/^Re:\s*/i, "") || "Abedin Voice AI"}`,
      body: linkClean.sanitized,
      followUpStep,
      memory,
    };
  } catch (err) {
    console.error("Memory aware follow-up generation error:", err);
    const phoneClean = validateAndEnforceNoPhonePolicy(fallbackBody);
    const linkClean = validateAndEnforceMeetingAndCalendarLinks(phoneClean.sanitized);
    return {
      subject: `Re: ${lastMsg?.subject?.replace(/^Re:\s*/i, "") || "Abedin Voice AI"}`,
      body: linkClean.sanitized,
      followUpStep,
      memory,
    };
  }
}
