import { safeGenerateJSON } from "../geminiClient";
import { Meeting, EngineCategory, CompanyBrain } from "../../src/types";

export async function generateMeetingBrief(input: {
  prospectName: string;
  prospectEmail: string;
  companyName: string;
  category: EngineCategory;
  notesOrConversation?: string;
  companyBrain?: CompanyBrain;
}): Promise<Meeting["aiBrief"]> {
  const fallbackBrief = {
    keyGoals: ["Qualify inbound call volume", "Run live voice interactive demo", "Secure pilot commitment"],
    potentialPains: ["High front-desk receptionist turnover", "Lost appointment revenue on weekends"],
    recommendedDemoFlow: ["1. Context & pain discovery", "2. 2-minute live AI voice demo", "3. Calendar integration demonstration", "4. Next steps & pilot setup"],
    objectionsToAnticipate: ["Integration difficulty", "Call transfer accuracy"],
    questionsToAsk: ["What is your current monthly cost per reception desk?", "What is your main scheduling software?"],
    topicsToAvoid: ["Do not quote custom enterprise discounts without founder approval"],
  };

  const prompt = `
You are the Executive Meeting Strategist preparing the founder/sales lead for an upcoming ${input.category} meeting.
Prospect: ${input.prospectName} at ${input.companyName} (${input.prospectEmail})
Category: ${input.category} (CUSTOMER, INVESTOR, or PARTNER)
Company Brain Context:
${input.companyBrain?.description || "Abedin Voice AI receptionist"}
Conversation Notes: ${input.notesOrConversation || "Booked 20-minute product demonstration"}

Generate a high-impact, tactical Pre-Meeting Briefing.
Return ONLY valid JSON matching this exact structure:
{
  "keyGoals": [
    "string"
  ],
  "potentialPains": [
    "string"
  ],
  "recommendedDemoFlow": [
    "string"
  ],
  "objectionsToAnticipate": [
    "string"
  ],
  "questionsToAsk": [
    "string"
  ],
  "topicsToAvoid": [
    "string"
  ]
}
`;

  const data = await safeGenerateJSON<{
    keyGoals?: string[];
    potentialPains?: string[];
    recommendedDemoFlow?: string[];
    objectionsToAnticipate?: string[];
    questionsToAsk?: string[];
    topicsToAvoid?: string[];
  }>({
    prompt,
    category: "SMART",
    temperature: 0.2,
    fallbackData: fallbackBrief,
    agentName: "meetingAgent",
  });

  return {
    keyGoals: data.keyGoals && data.keyGoals.length > 0 ? data.keyGoals : fallbackBrief.keyGoals,
    potentialPains: data.potentialPains && data.potentialPains.length > 0 ? data.potentialPains : fallbackBrief.potentialPains,
    recommendedDemoFlow: data.recommendedDemoFlow && data.recommendedDemoFlow.length > 0 ? data.recommendedDemoFlow : fallbackBrief.recommendedDemoFlow,
    objectionsToAnticipate: data.objectionsToAnticipate && data.objectionsToAnticipate.length > 0 ? data.objectionsToAnticipate : fallbackBrief.objectionsToAnticipate,
    questionsToAsk: data.questionsToAsk && data.questionsToAsk.length > 0 ? data.questionsToAsk : fallbackBrief.questionsToAsk,
    topicsToAvoid: data.topicsToAvoid && data.topicsToAvoid.length > 0 ? data.topicsToAvoid : fallbackBrief.topicsToAvoid,
  };
}
