import { z } from 'zod';
import { ADDRESS_TYPES, LAWFUL_BASES } from './lawfulBasis';
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
 * The lawful basis on which a contact may be emailed.
 *
 * `.strict()` matters more here than anywhere else in this file. The fields NOT listed are the
 * point: `suppressed`, `unsubscribed`, `hardBounced`, `complained` and `consentGiven` itself
 * cannot be set through this endpoint. A caller states the basis and its evidence; the service
 * derives the flag. Accepting `consentGiven` from a body is the mass-assignment hole that
 * `createContactSchema` was written to close, and re-opening it on a second endpoint would be
 * the same defect wearing a different URL.
 */
export const lawfulBasisSchema = z
  .object({
    basis: z.enum(LAWFUL_BASES),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'country must be an ISO-3166 alpha-2 code')
      .optional(),
    addressType: z.enum(ADDRESS_TYPES).optional(),
    consentEvidence: z.string().trim().min(1).max(2000).optional(),
    consentSource: z.string().trim().min(1).max(200).optional(),
    liaId: z.string().trim().min(1).max(200).optional(),
    article14NoticeSentAt: z.string().datetime({ offset: true }).optional(),
    acknowledgesRevocation: z.boolean().optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Revoking consent carries only a reason. It never needs to say more than why. */
export const revokeConsentSchema = z
  .object({
    reason: z.string().trim().min(1).max(500).optional(),
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

/**
 * CSV / list import.
 *
 * `text` carries the file contents rather than a multipart upload: one code path, no temporary
 * files on disk, and the same body-validation the rest of the surface uses. The size ceiling is
 * enforced twice over — by the route's own body parser and by `planImport` — because a limit
 * that exists in one place only is a limit that moves when someone remounts a parser.
 *
 * NOT ACCEPTED, and this is the point of the strict object: `consentGiven`, any suppression
 * flag, `organizationId`, `consentRecordedBy`. The importer's identity comes from the
 * credential, never from the body.
 */
export const leadImportSchema = z
  .object({
    text: z.string().min(1).max(4_000_000),
    mode: z.enum(['PREVIEW', 'COMMIT']),
    /** Required for COMMIT: the fingerprint of the plan that was previewed and approved. */
    expectedPlanHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    basis: z.enum(LAWFUL_BASES),
    liaId: z.string().trim().min(1).max(200).optional(),
    consentEvidence: z.string().trim().min(1).max(2000).optional(),
    consentSource: z.string().trim().min(1).max(200).optional(),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'country must be an ISO-3166 alpha-2 code')
      .optional(),
    addressType: z.enum(ADDRESS_TYPES).optional(),
    sourceEvidence: z.string().trim().min(1).max(2000),
    type: z.enum(['LEAD', 'INVESTOR', 'PARTNER']).optional(),
  })
  .strict();

/**
 * Record that the Article 14 notice has been sent, for a batch of contacts.
 *
 * The timestamp is NOT a parameter. It is the moment this endpoint is called, because the
 * endpoint is meant to be called by the thing that sent the notices. A caller-supplied
 * timestamp is an assertion about the past that nothing can check, and the field it writes is
 * a precondition for outreach.
 */
export const noticeSentSchema = z
  .object({
    contactIds: z.array(z.string().trim().min(1).max(255)).min(1).max(500),
    /** What was sent and how, so the record can be explained later. */
    evidence: z.string().trim().min(1).max(2000),
  })
  .strict();

/**
 * Create prospects: people identified on LinkedIn for whom we have no address.
 *
 * DELIBERATELY NO `basis`, `liaId` OR `consentEvidence`. A prospect is not contactable, so a
 * batch-level lawful basis here would record permission for something that cannot happen. The
 * basis is chosen at promotion, when there is an address and the decision means something.
 *
 * `email` is not in the row schema either. A row carrying one is a routing mistake, and
 * `validateProspect` refuses it by name rather than dropping it silently.
 */
export const createProspectsSchema = z
  .object({
    /** Where the batch came from, in a form a person could check. Required. */
    sourceEvidence: z.string().trim().min(1).max(2000),
    // `source` is NOT accepted, and the schema is strict, so sending it is a 400 rather than a
    // value that gets quietly ignored. A prospect in this collection came from LinkedIn — that
    // is what the collection is, and `normaliseProfileUrl` refuses anything else. Letting a
    // caller name the route something else would let them choose which balancing assessment
    // applies to the contacts these become, which is the one thing the source must not be.
    mode: z.enum(['PREVIEW', 'COMMIT']).optional(),
    rows: z
      .array(
        z
          .object({
            ref: z.string().trim().max(255).optional(),
            profileUrl: z.string().trim().min(1).max(2000),
            name: z.string().trim().max(500).optional(),
            firstName: z.string().trim().max(500).optional(),
            lastName: z.string().trim().max(500).optional(),
            headline: z.string().trim().max(2000).optional(),
            title: z.string().trim().max(500).optional(),
            companyName: z.string().trim().max(500).optional(),
            companyWebsite: z.string().trim().max(500).optional(),
            companyProfileUrl: z.string().trim().max(2000).optional(),
            industry: z.string().trim().max(500).optional(),
            country: z.string().trim().max(500).optional(),
            location: z.string().trim().max(500).optional(),
            employeeCount: z.string().trim().max(500).optional(),
            notes: z.string().trim().max(10000).optional(),
          })
          .strict()
      )
      .min(1)
      .max(2000),
  })
  .strict();

/**
 * Promote a prospect: an address has been found, so it becomes a contact.
 *
 * This is where the lawful basis is decided, and it is the same shape the importer uses —
 * because promotion ends at the same `ingestRecords` every other source does.
 */
export const promoteProspectSchema = z
  .object({
    email: z.string().trim().min(3).max(320),
    basis: z.enum(['CONSENT', 'LEGITIMATE_INTEREST']),
    liaId: z.string().trim().min(1).max(255).optional(),
    consentEvidence: z.string().trim().min(1).max(2000).optional(),
    consentSource: z.string().trim().min(1).max(500).optional(),
    country: z.string().trim().min(2).max(2).optional(),
    addressType: z.enum(['PERSONAL', 'ROLE']).optional(),
    /**
     * Where the ADDRESS came from, which is usually not where the person came from.
     *
     * REQUIRED. The LinkedIn balancing assessment covers an address derived from the employer's
     * published naming convention and not one purchased from a provider, so this field is what
     * decides which document applies — and the Article 14 notice tells the person their address
     * was found separately, which is half an answer on its own.
     */
    emailSource: z.string().trim().min(1).max(500),
    mode: z.enum(['PREVIEW', 'COMMIT']).optional(),
  })
  .strict();

/**
 * Write a legitimate interests assessment.
 *
 * The three limbs of the balancing test are separate fields with their own floors, because a
 * single free-text box is how the assessment gets written as a paragraph of marketing copy.
 * `server/domain/lia.ts` holds the substantive rules; this schema is the transport shape and
 * deliberately omits `signedBy`, `signedAt` and `reviewDueAt` — those are set by the act of
 * signing, and a drafter who could set them could write an assessment that never expires.
 */
export const liaDraftSchema = z
  .object({
    title: z.string().trim().min(8).max(300),
    purpose: z.string().trim().min(1).max(20000),
    necessity: z.string().trim().min(1).max(20000),
    balancing: z.string().trim().min(1).max(20000),
    countries: z.array(z.string().trim().min(2).max(2)).min(1).max(50),
    sourceKinds: z.array(z.string().trim().min(1).max(40)).min(1).max(20),
    dataCategories: z.array(z.string().trim().min(1).max(300)).min(1).max(50),
    dataSources: z.array(z.string().trim().min(1).max(300)).min(1).max(50),
    safeguards: z.array(z.string().trim().min(1).max(300)).min(1).max(50),
    objectionRoute: z.string().trim().min(1).max(20000),
  })
  .strict();

/**
 * Sign an assessment.
 *
 * `reviewDueAt` is optional and defaults to twelve months from the signature. It is accepted
 * here and nowhere else: the review date is part of the act of signing.
 */
export const liaSignSchema = z
  .object({
    reviewDueAt: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/** Withdraw an assessment. The reason is required; see the service for why. */
export const liaWithdrawSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

/**
 * Actually send the Article 14 notice to a batch.
 *
 * Distinct from `POST /api/leads/notice-sent`, which RECORDS that a notice was sent by some
 * other route. This one sends it. Both exist because an operator who posted the notice by letter
 * needs to be able to record that, and removing the manual path would push them into lying to
 * the system instead.
 *
 * `acknowledgesPossibleDuplicate` is how a contact whose previous attempt was ambiguous gets
 * retried. It is not a default: a second copy of a privacy notice is a decision somebody makes,
 * not something a backoff loop does on their behalf (§32).
 */
export const noticeSendSchema = z
  .object({
    contactIds: z.array(z.string().trim().min(1).max(255)).min(1).max(200),
    mode: z.enum(['PREVIEW', 'SEND']).optional(),
    acknowledgesPossibleDuplicate: z.boolean().optional(),
  })
  .strict();

/**
 * Score contacts against the declared ideal customer profile.
 *
 * An empty `contactIds` means every contact in the organisation, which is the normal case after
 * an import. The response says how many were beyond the limit rather than appearing to have
 * done all of them.
 */
export const scoreLeadsSchema = z
  .object({
    contactIds: z.array(z.string().trim().min(1).max(255)).max(500).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

/**
 * A paid discovery search.
 *
 * `country` is required rather than optional: the outreach gate refuses an unknown jurisdiction,
 * so a search without one spends money on records that can never be used.
 */
export const discoverLeadsSchema = z
  .object({
    mode: z.enum(['PREVIEW', 'COMMIT']),
    country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'country must be an ISO-3166 alpha-2 code'),
    industry: z.string().trim().min(1).max(200).optional(),
    titles: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    companySizeMin: z.number().int().min(0).max(1_000_000).optional(),
    companySizeMax: z.number().int().min(0).max(1_000_000).optional(),
    limit: z.number().int().min(1).max(200),
    basis: z.enum(LAWFUL_BASES),
    liaId: z.string().trim().min(1).max(200).optional(),
    addressType: z.enum(ADDRESS_TYPES).optional(),
    sourceEvidence: z.string().trim().min(1).max(2000),
    type: z.enum(['LEAD', 'INVESTOR', 'PARTNER']).optional(),
  })
  .strict();

/**
 * A scrape run against one site.
 *
 * `url` is a single seed, not a list: a run that took a list would be a crawler, and the page
 * budget, the rate limit and the robots decision are all per-site properties.
 */
export const scrapeSiteSchema = z
  .object({
    mode: z.enum(['PREVIEW', 'COMMIT']),
    url: z.string().trim().min(4).max(2000),
    pageBudget: z.number().int().min(1).max(20).optional(),
    basis: z.enum(LAWFUL_BASES),
    liaId: z.string().trim().min(1).max(200).optional(),
    country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'country must be an ISO-3166 alpha-2 code'),
    sourceEvidence: z.string().trim().min(1).max(2000),
    /** Off by default: role addresses only is the materially lower-risk half. */
    includePersonalAddresses: z.boolean().optional(),
    type: z.enum(['LEAD', 'INVESTOR', 'PARTNER']).optional(),
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
  'POST /api/contacts/:id/lawful-basis': lawfulBasisSchema,
  'POST /api/contacts/:id/revoke-consent': revokeConsentSchema,
  'POST /api/leads/import': leadImportSchema,
  'POST /api/leads/notice-sent': noticeSentSchema,
  'POST /api/leads/notice-send': noticeSendSchema,
  'POST /api/prospects': createProspectsSchema,
  'POST /api/prospects/:id/promote': promoteProspectSchema,
  'POST /api/lia': liaDraftSchema,
  'POST /api/lia/:id/amend': liaDraftSchema,
  'POST /api/lia/:id/sign': liaSignSchema,
  'POST /api/lia/:id/withdraw': liaWithdrawSchema,
  'POST /api/leads/score': scoreLeadsSchema,
  'POST /api/leads/discover': discoverLeadsSchema,
  'POST /api/leads/scrape': scrapeSiteSchema,
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
