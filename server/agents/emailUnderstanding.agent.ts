import { getGeminiAI, getModelForCategory } from '../geminiClient';
import { z } from 'zod';

const EmailUnderstandingSchema = z.object({
  primaryIntent: z.string(),
  secondaryIntents: z.array(z.string()),
  sentiment: z.string(),
  urgency: z.string(),
  explicitQuestions: z.array(z.string()),
  implicitQuestions: z.array(z.string()),
  objections: z.array(z.string()),
  statedFacts: z.array(z.object({
    key: z.string(),
    value: z.string()
  })),
  meetingRequest: z.boolean(),
  purchaseIntent: z.boolean(),
  unsubscribeIntent: z.boolean(),
  followUpLaterRequest: z.boolean(),
  humanEscalationNeed: z.boolean(),
  confidence: z.number(),
  summary: z.string()
});

export type EmailUnderstanding = z.infer<typeof EmailUnderstandingSchema>;

export class EmailUnderstandingAgent {
  async analyze(emailBody: string, previousContext: string): Promise<EmailUnderstanding> {
    const ai = getGeminiAI();
    const model = ai.models.generateContent({
      model: getModelForCategory('DEEP'),
      contents: [{
        role: "user",
        parts: [{
          text: `
You are the Email Understanding Agent.
Analyze the following email and extract structured intent, questions, and facts.

Previous Context:
${previousContext}

Latest Email Body:
${emailBody}

Respond strictly in JSON matching this schema:
{
  "primaryIntent": "MEETING_REQUEST | PRICING_QUESTION | TECHNICAL_QUESTION | OBJECTION | NOT_INTERESTED | UNSUBSCRIBE | FOLLOW_UP_LATER | PURCHASE_INTENT | ...",
  "secondaryIntents": [],
  "sentiment": "POSITIVE | NEUTRAL | NEGATIVE",
  "urgency": "HIGH | MEDIUM | LOW",
  "explicitQuestions": ["string"],
  "implicitQuestions": ["string"],
  "objections": ["string"],
  "statedFacts": [{"key": "employeeCount", "value": "10"}],
  "meetingRequest": boolean,
  "purchaseIntent": boolean,
  "unsubscribeIntent": boolean,
  "followUpLaterRequest": boolean,
  "humanEscalationNeed": boolean,
  "confidence": number (0-1),
  "summary": "1-2 sentence executive summary of what the client is saying"
}
`
        }]
      }],
      config: {
        responseMimeType: "application/json"
      }
    });

    try {
      const response = await model;
      const text = response.text;
      const parsed = JSON.parse(text || "{}");
      return EmailUnderstandingSchema.parse(parsed);
    } catch (e: any) {
      console.error("EmailUnderstandingAgent failed:", e);
      // Fail closed
      return {
        primaryIntent: "UNKNOWN",
        secondaryIntents: [],
        sentiment: "NEUTRAL",
        urgency: "LOW",
        explicitQuestions: [],
        implicitQuestions: [],
        objections: [],
        statedFacts: [],
        meetingRequest: false,
        purchaseIntent: false,
        unsubscribeIntent: false,
        followUpLaterRequest: false,
        humanEscalationNeed: true, // Escalate on failure
        confidence: 0,
        summary: "Failed to analyze email."
      };
    }
  }
}

export const emailUnderstandingAgent = new EmailUnderstandingAgent();
