import { readUsage, reportModelCall } from './lib/modelCallLog';
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
 *
 * P1.10 — TWO SHAPES, AND THE DIFFERENCE MATTERS (addendum §18).
 *
 *   - `{ prompt }` puts everything in one string with one level of authority. This is the
 *     legacy form. It is safe ONLY when every part of the string was written by us.
 *   - `{ systemInstruction, contents }` sends the instructions and the untrusted material as
 *     different fields of the API request. Anything containing externally retrieved material —
 *     a customer's email, a scraped page, an attachment — must use this form, built by
 *     server/lib/promptAssembly.ts, which fences the untrusted part and refuses to build a
 *     request whose instructions contain it.
 *
 * Passing both is refused rather than resolved by precedence: a caller that supplies both has
 * a mistaken idea of which one is being sent, and guessing on their behalf is how untrusted
 * text quietly ends up in the instruction field.
 */
export async function safeGenerateJSON<T = any>(options: {
  /** Legacy single-string form. Trusted content only. */
  prompt?: string;
  /** Trusted instructions. Use with `contents`. */
  systemInstruction?: string;
  /** Untrusted material, already fenced by promptAssembly. Use with `systemInstruction`. */
  contents?: string;
  category?: ModelCategory;
  temperature?: number;
  fallbackData: T;
  agentName?: string;
}): Promise<T> {
  const hasLegacy = typeof options.prompt === 'string';
  const hasSeparated = typeof options.systemInstruction === 'string';

  if (hasLegacy && hasSeparated) {
    throw new Error(
      '[geminiClient] Pass either `prompt` or `systemInstruction`+`contents`, not both. ' +
        'Which one carries the untrusted material must be unambiguous.'
    );
  }
  if (!hasLegacy && !hasSeparated) {
    throw new Error('[geminiClient] Nothing to send: supply `prompt` or `systemInstruction`.');
  }
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

  const agent = options.agentName ?? 'unnamed-agent';
  const failures: string[] = [];
  // §21 — which model answered is the difference between a reproducible reply and an anecdote.
  // Failover across five ids with different prices and capabilities was previously invisible:
  // the caller got an identical `T` whichever one responded, and nothing wrote the id down.
  const category = options.category || 'SMART';
  const startedAt = Date.now();
  let attempts = 0;

  for (const model of candidateModels) {
    attempts++;
    try {
      const response = await ai.models.generateContent({
        model,
        // The untrusted material travels here, as user content, never in systemInstruction.
        contents: hasSeparated ? options.contents ?? '' : (options.prompt as string),
        config: {
          responseMimeType: "application/json",
          temperature: options.temperature ?? 0.2,
          ...(hasSeparated ? { systemInstruction: options.systemInstruction } : {}),
        },
      });

      const rawText = response.text || "";
      if (rawText.trim()) {
        const parsed = extractCleanJSON<T>(rawText);
        reportModelCall({
          agentName: agent,
          category,
          model,
          outcome: 'ANSWERED',
          attempts,
          // Not defaulted to zero: a provider that reports no usage has told us nothing, and
          // "this call cost nothing" is a stronger claim than we can make (§14).
          ...readUsage((response as any)?.usageMetadata),
          durationMs: Date.now() - startedAt,
          failures: [...failures],
        });
        return parsed;
      }
      failures.push(`${model}: empty response`);
    } catch (err: any) {
      // P1.10 — This was a bare `continue`: no log, no error class, no attempt count. A model
      // outage, a bad API key and a malformed request were indistinguishable from success,
      // because the fallback that followed had the same type and shape as a real answer.
      failures.push(`${model}: ${err?.message ?? err}`);
      continue;
    }
  }

  // Returning the fallback is a FAILURE that happens to type-check. It must be visible: the
  // caller receives a well-formed object and cannot tell it apart from a real answer, so the
  // only place that can say so is here.
  console.error(
    `[geminiClient] All ${candidateModels.length} candidate models failed for ${agent}; ` +
      `returning fallbackData. This is NOT a generated answer. Attempts: ${failures.join(' | ')}`
  );

  // Recorded as well as logged. A run log that contains only successes reports a system that
  // never fails, and `model: null` is the honest value here — no model produced this answer.
  reportModelCall({
    agentName: agent,
    category,
    model: null,
    outcome: 'FALLBACK',
    attempts,
    promptTokens: null,
    outputTokens: null,
    totalTokens: null,
    durationMs: Date.now() - startedAt,
    failures: [...failures],
  });

  return options.fallbackData;
}
