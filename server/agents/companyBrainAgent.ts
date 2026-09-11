import { generateJsonOrAbstain } from "../geminiClient";
import { CompanyBrain } from "../../shared/domain/models";
import { companyBrainSchema } from "../domain/apiContracts";
import type { ModelOutcome } from "../domain/abstention";

/**
 * THE COMPANY BRAIN, AND WHICH OF ITS FIELDS A MODEL MAY WRITE.
 *
 * WHAT WAS WRONG
 * --------------
 * This returned `{ workspaceId: "default", ...parsed, updatedAt }`. The spread came AFTER the
 * literal, so a `workspaceId` in the model's answer replaced the server's: model output
 * overwriting a field the server owns. TypeScript reports exactly this — TS2783, "specified more
 * than once, so this usage will be overwritten" — and nobody saw it, because the diagnostic only
 * surfaces under `strictNullChecks` and `tsconfig.json` did not enable it.
 *
 * It was not exploitable, and the reason is worth stating so it is not mistaken for safety:
 * `workspaceId` is written in fifteen places and read by none, and the document path is
 * `orgPath(orgScope(req))`, so tenancy never depended on it. The day something reads it, a model
 * would have been choosing its value.
 *
 * Two larger defects lived in the same function.
 *
 *   1. The answer was never validated. The brain is stringified into every outbound prompt, so
 *      whatever keys a model returned became material for every later reply. S11 closed that
 *      channel for `POST /api/company-brain` and left it open for `/generate`, which writes the
 *      same document.
 *   2. It called `safeGenerateJSON` with a hand-written brain as `fallbackData`. When no model
 *      answered, that template — "over 88% of callers complete their booking smoothly",
 *      "recovers 18,000+ per month" — was written into the organisation's brain as though it had
 *      been generated, and fed to every prompt after it. A caller could not tell it from an
 *      answer, which is S23.
 *
 * WHAT IT DOES NOW
 * ----------------
 * No answer is no brain: the abstention is returned and nothing is written. An answer that does
 * not match the contract is refused whole rather than partly kept. The fields the server owns are
 * stamped after validation, from the server, so no model value for them survives.
 */

/** `workspaceId` is vestigial — written everywhere, read by nothing — and server-owned regardless. */
export const DEFAULT_WORKSPACE_ID = "default";

/**
 * What a GENERATED brain must contain: everything the prompt asks for.
 *
 * The stored schema makes every field optional because `POST /api/company-brain` is a partial
 * update. A generated brain REPLACES the document, so an answer of `{}` would pass that schema and
 * erase the organisation's brain. Strictness is inherited, so an unexpected key is still refused.
 */
const generatedBrainSchema = companyBrainSchema.required({
  companyName: true,
  companyUrl: true,
  productName: true,
  productUrl: true,
  tagline: true,
  description: true,
  targetIndustries: true,
  targetCountries: true,
  customerProblems: true,
  coreFeatures: true,
  primaryBenefits: true,
  differentiators: true,
  targetPersonas: true,
  customerUseCases: true,
  salesAngles: true,
  objectionsAndAnswers: true,
  investorNarrative: true,
  partnerNarrative: true,
});

export type CompanyBrainGeneration =
  | { readonly ok: true; readonly brain: CompanyBrain }
  | {
      readonly ok: false;
      readonly code: "MODEL_UNAVAILABLE" | "MODEL_OUTPUT_INVALID";
      readonly reason: string;
    };

/**
 * A model's outcome, as a brain the server may store — or the reason it may not.
 *
 * Separate from the call so the decision is testable without a model, which is the only way to
 * put an attacker's answer in front of it.
 */
export function brainFromModelOutcome(
  outcome: ModelOutcome<unknown>,
  now: Date
): CompanyBrainGeneration {
  if (outcome.abstained === false) {
    const parsed = generatedBrainSchema.safeParse(outcome.value);
    if (parsed.success === false) {
      const problems = parsed.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      return {
        ok: false,
        code: "MODEL_OUTPUT_INVALID",
        reason:
          "The model's answer did not match the company brain contract, so nothing was " +
          `written: ${problems.join("; ")}`,
      };
    }
    // Server-owned fields LAST. The order is the fix: an object literal keeps the last value
    // written for a key, so anything spread after these would replace them.
    return {
      ok: true,
      //
      // `as CompanyBrain` is sound: `generatedBrainSchema` requires every field at runtime, which
      // companyBrain.invariant.test.ts section 2 asserts. It exists only because zod decides
      // optionality with `undefined extends T`, which without strictNullChecks holds for EVERY T —
      // so zod's output types mark every field optional however the schema is written.
      brain: {
        ...parsed.data,
        workspaceId: DEFAULT_WORKSPACE_ID,
        updatedAt: now.toISOString(),
      } as CompanyBrain,
    };
  }
  return {
    ok: false,
    code: "MODEL_UNAVAILABLE",
    reason: `No model produced a company brain, so nothing was written. ${outcome.detail}`,
  };
}

export async function generateCompanyBrain(
  input: {
    companyName: string;
    companyUrl: string;
    productName: string;
    productUrl: string;
    targetMarkets: string[];
    primaryObjectives: string[];
    additionalNotes?: string;
  },
  now: () => Date = () => new Date()
): Promise<CompanyBrainGeneration> {
  const prompt = `
You are the Senior SaaS Growth Architect and Product Strategist for "${input.companyName}" (Product: "${input.productName}").
Website: ${input.companyUrl} | Product URL: ${input.productUrl}
Target Markets: ${input.targetMarkets.join(", ")}
Primary Objectives: ${input.primaryObjectives.join(", ")}
Additional Context: ${input.additionalNotes || "Autonomous conversational Voice AI for appointments, customer qualification, 24/7 inbound calls, and multi-industry outbound workflows."}

Generate an exhaustive, highly strategic "Company Brain" knowledge model in JSON format.
Return ONLY valid JSON matching this exact structure:
{
  "companyName": "${input.companyName}",
  "companyUrl": "${input.companyUrl}",
  "productName": "${input.productName}",
  "productUrl": "${input.productUrl}",
  "tagline": "string",
  "description": "string",
  "targetIndustries": ["string"],
  "targetCountries": ${JSON.stringify(input.targetMarkets)},
  "customerProblems": ["string"],
  "coreFeatures": ["string"],
  "primaryBenefits": ["string"],
  "differentiators": ["string"],
  "targetPersonas": [
    {
      "title": "string",
      "department": "string",
      "painPoint": "string"
    }
  ],
  "customerUseCases": [
    {
      "industry": "string",
      "useCase": "string",
      "expectedROI": "string"
    }
  ],
  "salesAngles": ["string"],
  "objectionsAndAnswers": [
    {
      "objection": "string",
      "recommendedResponse": "string"
    }
  ],
  "investorNarrative": {
    "vision": "string",
    "marketOpportunity": "string",
    "moat": "string",
    "tractionHighlights": "string"
  },
  "partnerNarrative": {
    "partnerValueProposition": "string",
    "revenueSharingModel": "string",
    "idealPartnerProfile": "string"
  }
}
`;

  const outcome = await generateJsonOrAbstain<unknown>({
    prompt,
    category: "SMART",
    temperature: 0.3,
    agentName: "companyBrainAgent",
  });

  return brainFromModelOutcome(outcome, now());
}
