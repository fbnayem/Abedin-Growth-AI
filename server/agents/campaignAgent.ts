import { safeGenerateJSON } from "../geminiClient";
import { Campaign, EngineCategory, CompanyBrain } from "../../shared/domain/models";

export async function generateCampaignStrategy(input: {
  name: string;
  engineType: EngineCategory;
  targetAudience: string;
  targetIndustries: string[];
  targetLocations: string[];
  companyBrain?: CompanyBrain;
}): Promise<Partial<Campaign>> {
  const fallbackData = {
    aiStrategySummary: `Targeted 4-step sequence crafted for ${input.targetAudience} in ${input.targetIndustries.join(", ")} focusing on high-conversion operational leverage.`,
    steps: [
      {
        id: "step_1",
        dayOffset: 1,
        stepType: "EMAIL" as const,
        subjectTemplate: "Quick question regarding {{companyName}}'s call handling",
        bodyTemplate: "Hi {{firstName}},\n\n{{personalizationSnippet}}\n\nWe built Abedin Voice AI to ensure appointment-focused businesses never miss high-value client calls after hours or during front-desk rushes. It operates with sub-500ms voice latency, answers 24/7, and books directly into your calendar.\n\nWould you be open to a brief 5-minute interactive audio demo this week?\n\nBest regards,\nNayem",
        objective: "Introduction & initial interest hook",
      },
      {
        id: "step_2",
        dayOffset: 4,
        stepType: "EMAIL" as const,
        subjectTemplate: "Re: Quick question regarding {{companyName}}'s call handling",
        bodyTemplate: "Hi {{firstName}},\n\nFollowing up briefly—most clinics and service teams we speak with find that 30%+ of new consultation inquiries arrive outside normal office hours.\n\nAbedin Voice AI captures these automatically and syncs confirmations straight to your team's schedule.\n\nAre you available for a quick look on Thursday at 2:00 PM?",
        objective: "Operational use case follow-up",
      },
      {
        id: "step_3",
        dayOffset: 8,
        stepType: "EMAIL" as const,
        subjectTemplate: "How similar clinics recover £15k+/mo in missed appointments",
        bodyTemplate: "Hi {{firstName}},\n\nThought you might find this relevant: we recently helped a multi-location practice reduce front-desk phone wait times to zero while booking 42 additional appointments in their first 3 weeks.\n\nHappy to show you the live voice agent preview tailored for {{companyName}} if helpful.",
        objective: "Tangible ROI proof",
      },
      {
        id: "step_4",
        dayOffset: 14,
        stepType: "EMAIL" as const,
        subjectTemplate: "Permission to close the loop on {{companyName}}",
        bodyTemplate: "Hi {{firstName}},\n\nI realize you are busy running operations at {{companyName}}. I will pause our outreach for now so as not to clutter your inbox.\n\nIf you ever want to test a live 24/7 Voice AI receptionist for your phones, feel free to reach back out anytime.\n\nBest,\nNayem",
        objective: "Respectful final breakaway",
      },
    ],
  };

  const prompt = `
You are the Senior Growth Campaign Strategist for ${input.companyBrain?.productName || "Abedin Voice AI"}.
Campaign Details:
- Campaign Name: "${input.name}"
- Engine Type: "${input.engineType}" (CUSTOMER, INVESTOR, or PARTNER)
- Target Audience: "${input.targetAudience}"
- Target Industries: ${input.targetIndustries.join(", ")}
- Target Locations: ${input.targetLocations.join(", ")}

Company Brain Context:
Product: ${input.companyBrain?.productName || "Abedin Voice AI"}
Description: ${input.companyBrain?.description || "Conversational voice AI receptionist"}
Key Value Props: ${input.companyBrain?.primaryBenefits?.join("; ") || "Zero missed calls, instant calendar booking"}
Sales Angles: ${input.companyBrain?.salesAngles?.join("; ") || "Overhead reduction, missed call recovery"}
Investor Narrative: ${input.companyBrain?.investorNarrative?.vision || "Voice AI transition"}
Partner Model: ${input.companyBrain?.partnerNarrative?.partnerValueProposition || "Agency reseller program"}

CRITICAL RULES:
- STRICT PROHIBITION ON PHONE NUMBERS: NEVER include any telephone numbers, direct phone digits, or mobile test call invitations in any email template or reply. All meetings must use live Google Meet links (https://meet.google.com/abn-vce-demo) or web scheduling.
- For CUSTOMER: Never use investor language. Focus on phone load, missed appointment recovery, 24/7 calendar booking.
- For INVESTOR: Never use sales pitch language. Focus on market opportunity, traction, unit economics, voice AI infrastructure moat.
- For PARTNER: Focus on reseller margins, client retention, turnkey recurring SaaS revenue.

Generate a 4-step sequence:
- Step 1 (Day 1): Personalized Introduction
- Step 2 (Day 4): Quick Follow-Up & Specific Use Case
- Step 3 (Day 8): ROI / Proof / Case Demonstration
- Step 4 (Day 14): Graceful Final Follow-Up / Breakaway

Return ONLY valid JSON matching this exact structure:
{
  "aiStrategySummary": "string describing target persona, pain points addressed, and CTA",
  "steps": [
    {
      "id": "step_1",
      "dayOffset": 1,
      "stepType": "EMAIL",
      "subjectTemplate": "string with {{firstName}} and {{companyName}}",
      "bodyTemplate": "string with concise, high-conversion email body using {{firstName}}, {{companyName}}, {{industry}}, {{personalizationSnippet}}",
      "objective": "Establish direct relevance and hook interest"
    },
    {
      "id": "step_2",
      "dayOffset": 4,
      "stepType": "EMAIL",
      "subjectTemplate": "string",
      "bodyTemplate": "string",
      "objective": "Follow up with concrete operational use case"
    },
    {
      "id": "step_3",
      "dayOffset": 8,
      "stepType": "EMAIL",
      "subjectTemplate": "string",
      "bodyTemplate": "string",
      "objective": "Share tangible ROI / demo example"
    },
    {
      "id": "step_4",
      "dayOffset": 14,
      "stepType": "EMAIL",
      "subjectTemplate": "string",
      "bodyTemplate": "string",
      "objective": "Permission to close loop politely"
    }
  ]
}
`;

  const data = await safeGenerateJSON<{
    aiStrategySummary?: string;
    steps?: any[];
  }>({
    prompt,
    category: "SMART",
    temperature: 0.3,
    fallbackData,
    agentName: "campaignAgent",
  });

  return {
    name: input.name,
    engineType: input.engineType,
    targetAudience: input.targetAudience,
    targetIndustries: input.targetIndustries,
    targetLocations: input.targetLocations,
    aiStrategySummary: data.aiStrategySummary || fallbackData.aiStrategySummary,
    steps: data.steps && data.steps.length > 0 ? data.steps : fallbackData.steps,
    status: "DRAFT",
    enrolledCount: 0,
    sentCount: 0,
    openedCount: 0,
    repliedCount: 0,
    convertedCount: 0,
    autonomyMode: "SEMI_AUTONOMOUS",
    createdAt: new Date().toISOString(),
  };
}
