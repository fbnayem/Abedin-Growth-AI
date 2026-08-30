import { getGeminiAI, getModelForCategory } from '../geminiClient';
import { EmailUnderstanding } from './emailUnderstanding.agent';
import { NextBestAction, BuyingStage } from '../domain/models';

export interface ComposerInput {
  conversationContext: string;
  latestEmail: string;
  understanding: EmailUnderstanding;
  nextBestAction: NextBestAction;
  buyingStage: BuyingStage;
  specialistKnowledge: string;
  toneProfile: string;
  senderName: string;
  senderEmail: string;
}

export class ReplyComposerAgent {
  async compose(input: ComposerInput): Promise<{ subject: string; bodyHtml: string; bodyText: string }> {
    const ai = getGeminiAI();
    const prompt = `
You are the Reply Composer. Your job is to strictly write the email response based on the provided plan and knowledge.
DO NOT invent knowledge, prices, or URLs.
DO NOT use phone numbers.
ONLY offer a meeting if the Next Best Action explicitly instructs it.

## Context
Sender: ${input.senderName} (${input.senderEmail})
Buying Stage: ${input.buyingStage}
Next Best Action: ${input.nextBestAction}
Tone: ${input.toneProfile}

## Latest Client Email
${input.latestEmail}

## Understanding (What to answer)
${input.understanding.summary}
Questions to answer:
${input.understanding.explicitQuestions.join('\\n')}

## Approved Specialist Knowledge (Use this to answer)
${input.specialistKnowledge}

## Instructions
Write a concise, human-sounding reply. Keep it under 80 words if possible.
No generic corporate fluff.
Answer the questions directly using the Approved Specialist Knowledge.
Format your output as JSON:
{
  "subject": "Re: ...",
  "bodyHtml": "HTML formatted body using <br/> for breaks",
  "bodyText": "Plain text body"
}
`;

    const model = ai.models.generateContent({
      model: getModelForCategory('SMART'),
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json" }
    });

    try {
      const response = await model;
      const parsed = JSON.parse(response.text || "{}");
      return {
        subject: parsed.subject || "Re: Update",
        bodyHtml: parsed.bodyHtml || "",
        bodyText: parsed.bodyText || ""
      };
    } catch (err) {
      console.error("Composer error:", err);
      throw new Error("Failed to compose reply securely.");
    }
  }
}

export const replyComposerAgent = new ReplyComposerAgent();
