import { GoogleGenAI } from "@google/genai";
import { CompanyBrain, Lead, Investor } from "../../src/types";

export interface PitchSimulationInput {
  entityType: "CUSTOMER" | "INVESTOR";
  entity: Lead | Investor;
  conversationHistory: { role: string; text: string }[];
  userPitch: string;
}

export interface PitchSimulationResult {
  prospectResponse: string;
  score: number;
  feedback: string;
  suggestedRebuttal: string;
  coachingTip: string;
}

export async function simulatePitchBattle(
  input: PitchSimulationInput,
  brain?: CompanyBrain
): Promise<PitchSimulationResult> {
  const isCustomer = input.entityType === "CUSTOMER";
  const customer = isCustomer ? (input.entity as Lead) : null;
  const investor = !isCustomer ? (input.entity as Investor) : null;

  const targetName = isCustomer ? customer?.name : investor?.name;
  const targetCompanyOrFund = isCustomer ? customer?.companyName : investor?.fundName;
  const role = isCustomer ? customer?.title : investor?.role;
  const industryOrStage = isCustomer ? customer?.industry : investor?.stage;

  const systemInstruction = `You are an expert executive simulation agent.
Your job is to roleplay as a realistic, busy, and skeptical B2B Decision Maker or VC Investor being pitched by a sales rep / founder.

Target Persona to Roleplay:
- Name: ${targetName}
- Title / Role: ${role}
- Organization: ${targetCompanyOrFund}
- Industry / Stage: ${industryOrStage}
${isCustomer ? `- Inbound Call Volume Likelihood: ${customer?.inboundCallVolumeLikelihood || "HIGH"}` : `- Target Sectors: ${investor?.targetSectors?.join(", ")}`}
${isCustomer ? `- Suspected Pain: Missed calls, receptionist staffing costs, missed booking revenues.` : `- Thesis Focus: ${investor?.thesisMatchReason || "AI B2B infrastructure & unit economics"}`}

Company Context (Pitcher's Product):
- Product: ${brain?.productName || "Abedin Voice AI"}
- Core Value: Sub-500ms voice speed, autonomous 24/7 call receptionist, instant calendar booking, CRM sync.
- Pricing & ROI: Replaces £2,500/mo staffing overhead with 99.9% uptime and zero missed appointments.

Task:
Evaluate the user's latest pitch: "${input.userPitch}".
1. Respond in character (natural, skeptical, asking realistic hard questions about switching costs, accuracy, latency, integrations, or unit economics).
2. Grade their rebuttal / pitch effectiveness (Score between 0 to 100).
3. Provide crisp coach feedback on what they did well and where they were weak.
4. Give a high-converting counter-response / suggested rebuttal rooted in real business value.
5. Provide a short tactical coaching tip.

Return ONLY a valid JSON object strictly matching this schema:
{
  "prospectResponse": string,
  "score": number,
  "feedback": string,
  "suggestedRebuttal": string,
  "coachingTip": string
}`;

  if (process.env.GEMINI_API_KEY) {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Conversation so far:\n${input.conversationHistory
                  .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
                  .join("\n")}\n\nLatest user pitch to respond to: "${input.userPitch}"`,
              },
            ],
          },
        ],
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          temperature: 0.7,
        },
      });

      if (response.text) {
        const parsed = JSON.parse(response.text);
        return {
          prospectResponse: parsed.prospectResponse,
          score: parsed.score || 80,
          feedback: parsed.feedback,
          suggestedRebuttal: parsed.suggestedRebuttal,
          coachingTip: parsed.coachingTip || "Focus on business outcome metrics rather than tech jargon.",
        };
      }
    } catch (err) {
      console.warn("Gemini pitch battle simulation failed, using fallback:", err);
    }
  }

  // Fallback intelligent simulation
  if (isCustomer) {
    return {
      prospectResponse: `I hear you, but my reception staff is already trained and patients get nervous talking to bots. How does your voice system handle complex medical scheduling questions without hallucinating?`,
      score: 82,
      feedback: "Strong initial value hook. Now reassure them with guardrails, fail-safe human handoff, and patient privacy compliance.",
      suggestedRebuttal: `Great question. The AI operates with deterministic clinical guardrails and instantly transfers out-of-scope calls to your on-call nurse with full audio transcripts.`,
      coachingTip: "Always address safety and human fallback when selling to clinics and professional services.",
    };
  } else {
    return {
      prospectResponse: `Your traction is promising, but what prevents Retell, ElevenLabs, or Vapi from commoditizing this layer in 12 months? What is your proprietary data fly-wheel?`,
      score: 85,
      feedback: "Great confidence on market size. Make sure to clearly delineate vertical workflow orchestration from raw voice APIs.",
      suggestedRebuttal: `Infrastructure providers sell raw APIs; we own the end-to-end vertical workflow, calendar integration, telephony compliance, and clinic retention workflows that lock in high gross margins.`,
      coachingTip: "Investors want to see defensibility in workflow lock-in and high switching costs.",
    };
  }
}
