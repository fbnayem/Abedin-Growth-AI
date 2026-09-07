import { z } from 'zod';

/**
 * S11 — what a request body is allowed to contain, stated once.
 *
 * WHAT WAS THERE
 * --------------
 * `zod` was a dependency with one import in the whole repository — in a file proven unreachable,
 * validating model output rather than an HTTP body. `server.ts` contained zero `z.` occurrences.
 * Handlers took `req.body` and wrote it, so any field a caller sent was persisted.
 *
 * The worst instance is the company brain. Its contents are **stringified into every outbound
 * prompt**, so an unexpected key written there is an unexpected key the model reads as part of
 * its instructions — the reachable prompt-injection channel §18 describes, arriving through the
 * front door as an ordinary API call rather than through a retrieved document.
 *
 * WHY `.strict()` AND NOT `.passthrough()`
 * ----------------------------------------
 * A schema that allows unknown keys through validates nothing that matters here: the fields it
 * knows about were never the problem. `.strict()` REJECTS the request rather than silently
 * dropping the extra key, because a caller that sent a field it believed would be saved should
 * be told it was not — a silent drop is how a client and a server disagree for months.
 *
 * WHY THE SCHEMAS DESCRIBE THE STORED SHAPE AND NOT THE WIRE SHAPE
 * ---------------------------------------------------------------
 * `version` and `expectedVersion` are transport: they arrive in the body, govern the write, and
 * must not be persisted as document fields or the next read hands them back as data. They are
 * stripped before validation rather than being part of it, so the schema stays a description of
 * the document.
 */

/** Every field is optional: these are partial updates to a singleton, not full replacements. */
const persona = z
  .object({
    title: z.string(),
    department: z.string(),
    painPoint: z.string(),
  })
  .strict();

const useCase = z
  .object({
    industry: z.string(),
    useCase: z.string(),
    expectedROI: z.string(),
  })
  .strict();

const objection = z
  .object({
    objection: z.string(),
    recommendedResponse: z.string(),
  })
  .strict();

/**
 * The company brain.
 *
 * Bounded lengths throughout, because this text is interpolated into a prompt: an unbounded
 * string here is an unbounded prompt, which is both a cost problem and the shape §21 is about.
 * The limits are generous enough that no legitimate entry hits them and small enough that a
 * megabyte of instructions cannot be posted into the model's context.
 */
export const companyBrainSchema = z
  .object({
    workspaceId: z.string().max(200).optional(),
    companyName: z.string().max(200).optional(),
    companyUrl: z.string().max(500).optional(),
    productName: z.string().max(200).optional(),
    productUrl: z.string().max(500).optional(),
    tagline: z.string().max(500).optional(),
    description: z.string().max(5000).optional(),
    targetIndustries: z.array(z.string().max(200)).max(50).optional(),
    targetCountries: z.array(z.string().max(200)).max(50).optional(),
    customerProblems: z.array(z.string().max(1000)).max(50).optional(),
    coreFeatures: z.array(z.string().max(1000)).max(50).optional(),
    primaryBenefits: z.array(z.string().max(1000)).max(50).optional(),
    differentiators: z.array(z.string().max(1000)).max(50).optional(),
    targetPersonas: z.array(persona).max(50).optional(),
    customerUseCases: z.array(useCase).max(50).optional(),
    salesAngles: z.array(z.string().max(1000)).max(50).optional(),
    objectionsAndAnswers: z.array(objection).max(50).optional(),
    investorNarrative: z
      .object({
        vision: z.string().max(5000),
        marketOpportunity: z.string().max(5000),
        moat: z.string().max(5000),
        tractionHighlights: z.string().max(5000),
      })
      .strict()
      .optional(),
    partnerNarrative: z
      .object({
        partnerValueProposition: z.string().max(5000),
        revenueSharingModel: z.string().max(5000),
        idealPartnerProfile: z.string().max(5000),
      })
      .strict()
      .optional(),
    updatedAt: z.string().max(100).optional(),
  })
  .strict();

/**
 * Workspace settings.
 *
 * Deliberately NOT a permissive record. `settings` is read by operator surfaces and — more to
 * the point — an unknown key written here is a key nothing validates and everything trusts. The
 * autonomy gate is **not** in this schema and cannot be set through this route: it lives in the
 * environment specifically so that a datastore write can pause the system and can never start
 * it (P0.3).
 */
export const settingsSchema = z
  .object({
    companyName: z.string().max(200).optional(),
    senderName: z.string().max(200).optional(),
    senderEmail: z.string().email().max(320).optional(),
    replyToEmail: z.string().email().max(320).optional(),
    timezone: z.string().max(100).optional(),
    workingHoursStart: z.number().int().min(0).max(23).optional(),
    workingHoursEnd: z.number().int().min(0).max(23).optional(),
    dailySendLimit: z.number().int().min(0).max(10_000).optional(),
    signatureHtml: z.string().max(5000).optional(),
    updatedAt: z.string().max(100).optional(),
  })
  .strict();

/**
 * The registry. One place that answers "what does this route accept".
 *
 * A map rather than a decorator on each handler, so the set can be enumerated — by a test, by a
 * document generator, by anyone asking what the surface is. A contract that can only be
 * discovered by reading every handler is the situation this replaces.
 */
export const BODY_SCHEMAS = {
  'POST /api/company-brain': companyBrainSchema,
  'POST /api/settings': settingsSchema,
} as const;

export type ContractRoute = keyof typeof BODY_SCHEMAS;

/** Fields that govern a write and must never be stored as document content. */
export const TRANSPORT_FIELDS = ['version', 'expectedVersion'] as const;

export type ValidationOutcome =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Validate a body against a route's contract, having first removed the transport fields.
 *
 * Returns the PARSED value, not the input. A caller that validates and then persists the
 * original object has validated nothing — the check passes and the unvalidated bytes are what
 * get written, which is the shape of most validation bugs.
 */
export function validateBody(schema: z.ZodTypeAny, body: unknown): ValidationOutcome {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, problems: ['the request body must be a JSON object'] };
  }

  const withoutTransport: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const field of TRANSPORT_FIELDS) delete withoutTransport[field];

  const parsed = schema.safeParse(withoutTransport);
  if (parsed.success === false) {
    return {
      ok: false,
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
      ),
    };
  }
  return { ok: true, value: parsed.data as Record<string, unknown> };
}
