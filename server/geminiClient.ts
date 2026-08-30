import { GoogleGenAI } from "@google/genai";

let aiInstance: GoogleGenAI | null = null;

export function getGeminiAI(): GoogleGenAI {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY || "";
    aiInstance = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiInstance;
}

export type ModelCategory = "FAST" | "SMART" | "DEEP";

export function getModelForCategory(category: ModelCategory = "FAST"): string {
  switch (category) {
    case "FAST":
      return "gemini-3.1-pro-preview";
    case "SMART":
      return "gemini-3.1-pro-preview";
    case "DEEP":
      return "gemini-3.1-pro-preview";
    default:
      return "gemini-3.1-pro-preview";
  }
}

/**
 * Extracts and parses JSON from text that might include markdown fences, comments, or extra wrapping.
 */
export function extractCleanJSON<T = any>(text: string): T {
  let cleaned = text.trim();
  // Remove markdown code fences ```json ... ``` or ``` ... ```
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }

  // Find first { or [ and last } or ]
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  let startIdx = -1;
  let endIdx = -1;

  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    startIdx = firstBracket;
    endIdx = cleaned.lastIndexOf("]") + 1;
  } else if (firstBrace !== -1) {
    startIdx = firstBrace;
    endIdx = cleaned.lastIndexOf("}") + 1;
  }

  if (startIdx >= 0 && endIdx > startIdx) {
    cleaned = cleaned.substring(startIdx, endIdx);
  }

  return JSON.parse(cleaned) as T;
}

/**
 * Normalizes responses that might be a raw array or wrapped in an object like { leads: [...] }, { data: [...] }
 */
export function extractArray<T = any>(data: any): T[] | null {
  if (!data) return null;
  if (Array.isArray(data)) return data;
  if (typeof data === "object") {
    const candidateKeys = [
      "leads",
      "prospects",
      "investors",
      "funds",
      "partners",
      "agencies",
      "data",
      "results",
      "items",
      "list",
      "records",
      "candidates",
    ];
    for (const key of candidateKeys) {
      if (Array.isArray(data[key]) && data[key].length > 0) {
        return data[key];
      }
    }
    for (const key of Object.keys(data)) {
      if (Array.isArray(data[key]) && data[key].length > 0) {
        return data[key];
      }
    }
  }
  return null;
}

/**
 * Safe generation wrapper that handles transient 503s, 429s, and model failovers gracefully.
 */
export async function safeGenerateJSON<T = any>(options: {
  prompt: string;
  category?: ModelCategory;
  temperature?: number;
  fallbackData: T;
  agentName?: string;
}): Promise<T> {
  const ai = getGeminiAI();
  const primaryModel = getModelForCategory(options.category || "SMART");
  const candidateModels = Array.from(
    new Set([
      primaryModel,
      "gemini-3.1-pro-preview",
      "gemini-3.7-flash",
      "gemini-3.1-flash-lite",
      "gemini-flash-latest",
    ])
  );

  for (const model of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: options.prompt,
        config: {
          responseMimeType: "application/json",
          temperature: options.temperature ?? 0.2,
        },
      });

      const rawText = response.text || "";
      if (rawText.trim()) {
        const parsed = extractCleanJSON<T>(rawText);
        return parsed;
      }
    } catch (err: any) {
      // Model failed or unavailable (e.g. 503, 429, timeout), seamlessly shift to next candidate model
      continue;
    }
  }

  return options.fallbackData;
}
