import { getGeminiAI, getModelForCategory } from '../geminiClient';
import { CANONICAL_KNOWLEDGE } from './salesDecisionEngine'; // reuse existing for now

export class TechnicalAgent {
  async getAnswer(question: string): Promise<string> {
    const ai = getGeminiAI();
    const prompt = `
You are the Technical Knowledge Agent.
Answer the following technical question strictly using the approved knowledge base below.
If the answer is not in the knowledge base, output "INSUFFICIENT_VERIFIED_INFORMATION".

Question: ${question}

Knowledge Base:
${JSON.stringify(CANONICAL_KNOWLEDGE.technical, null, 2)}
`;
    try {
      const result = await ai.models.generateContent({
        model: getModelForCategory('FAST'),
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      });
      return result.text || "INSUFFICIENT_VERIFIED_INFORMATION";
    } catch {
      return "INSUFFICIENT_VERIFIED_INFORMATION";
    }
  }
}

export const technicalAgent = new TechnicalAgent();
