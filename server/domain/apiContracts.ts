import { z } from 'zod';
import { CAMPAIGN, OPPORTUNITY, legalStates } from './stateMachines';
import { timeZoneRejection } from '../../shared/domain/time';
import { PRICE_BOOK } from '../../shared/domain/pricing';

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
 * The inputs to company-brain GENERATION.
 *
 * `POST /api/company-brain/generate` passed `req.body` straight to the agent, which interpolates
 * every field into the prompt and calls `targetMarkets.join(", ")`. A non-array was a TypeError
 * and a 500; an unbounded string was an unbounded prompt, paid for by the caller's organisation.
 */
export const companyBrainGenerateSchema = z
  .object({
    companyName: z.string().max(200),
    companyUrl: z.string().max(500),
    productName: z.string().max(200),
    productUrl: z.string().max(500),
    targetMarkets: z.array(z.string().max(200)).max(50),
    primaryObjectives: z.array(z.string().max(500)).max(50),
    additionalNotes: z.string().max(5000).optional(),
  })
  .strict();

/**
 * The registry. One place that answers "what does this route accept".
 *
 * A map rather than a decorator on each handler, so the set can be enumerated — by a test, by a
 * document generator, by anyone asking what the surface is. A contract that can only be
 * discovered by reading every handler is the situation this replaces.
 */
/**
 * S39 — a status or stage change names the state it wants and nothing else.
 *
 * The transition map decides whether the MOVE is legal; this decides whether the REQUEST is
 * well-formed: the state is one the machine knows, the version (when sent in the body rather
 * than If-Match) is a non-negative integer, and there is no other field — a body that also
 * carried `name` or `enrolledCount` was previously ignored silently, which is how a caller
 * comes to believe a field is writable here. Two routes serve each schema: `/status` and its
 * older spelling `/toggle`, and PUT and POST on `/stage`.
 */
const stateChange = (field: string, states: string[]) =>
  z
    .object({
      [field]: z.enum(states as [string, ...string[]]),
      expectedVersion: z.number().int().nonnegative().optional(),
    })
    .strict();

export const campaignStatusSchema = stateChange('status', legalStates(CAMPAIGN));
export const opportunityStageSchema = stateChange('stage', legalStates(OPPORTUNITY));

/**
 * S26 — enrolment names contacts and nothing else. Up to 500 at once: an enrolment is one write
 * per contact, and a batch that large is a decision to make in more than one request.
 */
export const enrolRecipientsSchema = z
  .object({
    contactIds: z.array(z.string().min(1).max(255)).min(1).max(500),
  })
  .strict();

/**
 * S26 — a contact's time zone is stated, never guessed: the QUIET_HOURS guard cannot run without
 * it, and refuses. An IANA identifier only; a fixed offset ("+06:00") is refused because it is
 * not a zone and cannot follow daylight saving.
 */
export const contactTimeZoneSchema = z
  .object({
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .refine((zone) => timeZoneRejection(zone) === null, { message: 'timeZone must be an IANA time zone identifier such as Europe/London' }),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * S25 — a quote names tiers and components; it never carries an amount. The price is read
 * from the book by the service, so a body cannot state a price the book does not hold.
 */
export const createQuoteSchema = z
  .object({
    lineItems: z
      .array(
        z
          .object({
            tierId: z.enum(PRICE_BOOK.map((t) => t.id) as [string, ...string[]]),
            component: z.enum(['monthly', 'setupFee']),
            quantity: z.number().int().min(1).max(1000),
          })
          .strict()
      )
      .min(1)
      .max(20),
    validUntil: z.string().datetime({ offset: true }),
    conversationId: z.string().min(1).max(255).optional(),
  })
  .strict();

export const BODY_SCHEMAS = {
  'POST /api/company-brain': companyBrainSchema,
  'POST /api/company-brain/generate': companyBrainGenerateSchema,
  'POST /api/settings': settingsSchema,
  'POST /api/campaigns/:id/status': campaignStatusSchema,
  'POST /api/campaigns/:id/toggle': campaignStatusSchema,
  'PUT /api/pipeline/:id/stage': opportunityStageSchema,
  'POST /api/pipeline/:id/stage': opportunityStageSchema,
  'POST /api/campaigns/:id/recipients': enrolRecipientsSchema,
  'POST /api/contacts/:id/time-zone': contactTimeZoneSchema,
  'POST /api/contacts/:id/quotes': createQuoteSchema,
} as const;

export type ContractRoute = keyof typeof BODY_SCHEMAS;

/** What a route's body is once it has been validated — the schema's output, not a cast. */
export type ContractBody<R extends ContractRoute> = z.output<(typeof BODY_SCHEMAS)[R]>;

/**
 * Validate a body against a named route's contract, typed as that route's body.
 *
 * The one cast in this module, and it is sound: `BODY_SCHEMAS[route]` IS the schema for `R`, and
 * `validateBody` returns that schema's output. TypeScript cannot evaluate `z.output` of an indexed
 * access on a type parameter and reports `unknown`; the cast states what the lookup already
 * guarantees, rather than widening every handler's body to `Record<string, unknown>`.
 */
export function validateContractBody<R extends ContractRoute>(
  route: R,
  body: unknown
): ValidationOutcome<ContractBody<R>> {
  return validateBody(BODY_SCHEMAS[route], body) as ValidationOutcome<ContractBody<R>>;
}

/** Fields that govern a write and must never be stored as document content. */
export const TRANSPORT_FIELDS = ['version', 'expectedVersion'] as const;

export type ValidationOutcome<T = Record<string, unknown>> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Validate a body against a route's contract, having first removed the transport fields.
 *
 * Returns the PARSED value, not the input. A caller that validates and then persists the
 * original object has validated nothing — the check passes and the unvalidated bytes are what
 * get written, which is the shape of most validation bugs.
 */
export function validateBody<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown
): ValidationOutcome<z.output<S>> {
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
  return { ok: true, value: parsed.data };
}
