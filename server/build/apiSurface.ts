import type { ZodType } from 'zod';
import { BODY_SCHEMAS } from '../domain/apiContracts';
import { createContactSchema, createKnowledgeItemSchema, createOpportunitySchema } from '../lib/validation';

/**
 * S11 — every request body this server validates through a schema, by route.
 *
 * Two registries grew up separately: `BODY_SCHEMAS` in server/domain/apiContracts.ts (strict
 * objects, unknown fields refused, used through `parsedBodyOr400`) and the create schemas in
 * server/lib/validation.ts (used through `parseOrRespond`, directly or via the `createContact`
 * helper the three contact-creating routes share). This is the union, keyed the same way, and
 * it is what the OpenAPI document is generated from.
 *
 * Listing a route here is a CLAIM that its handler parses the body through this schema before
 * using it. `openapi.invariant.test.ts` checks the claim against the handler's text — a route
 * listed here whose handler reads `req.body` around the schema would be documented as validated
 * while being nothing of the kind, which is worse than being undocumented.
 *
 * Routes that read a body and are NOT here are the honest remainder, and the same suite names
 * them one by one so the list can shrink and never quietly grow.
 */
export const REQUEST_CONTRACTS: Readonly<Record<string, ZodType>> = {
  ...BODY_SCHEMAS,
  'POST /api/knowledge': createKnowledgeItemSchema,
  'POST /api/pipeline': createOpportunitySchema,
  'POST /api/leads': createContactSchema,
  'POST /api/investors': createContactSchema,
  'POST /api/partners': createContactSchema,
};

/** How each contract route reaches its schema, for the suite that checks the claim above. */
export const CONTRACT_EVIDENCE: Readonly<Record<string, RegExp>> = {
  'POST /api/company-brain': /parsedBodyOr400\(req, res, 'POST \/api\/company-brain'\)/,
  'POST /api/company-brain/generate': /parsedBodyOr400\(req, res, 'POST \/api\/company-brain\/generate'\)/,
  'POST /api/settings': /parsedBodyOr400\(req, res, 'POST \/api\/settings'\)/,
  // One handler serves both spellings, and one serves both verbs; the evidence is the same text.
  'POST /api/campaigns/:id/status': /parsedBodyOr400\(req, res, 'POST \/api\/campaigns\/:id\/status'\)/,
  'POST /api/campaigns/:id/toggle': /parsedBodyOr400\(req, res, 'POST \/api\/campaigns\/:id\/status'\)/,
  'PUT /api/pipeline/:id/stage': /parsedBodyOr400\(req, res, 'PUT \/api\/pipeline\/:id\/stage'\)/,
  'POST /api/pipeline/:id/stage': /parsedBodyOr400\(req, res, 'PUT \/api\/pipeline\/:id\/stage'\)/,
  'POST /api/campaigns/:id/recipients': /parsedBodyOr400\(req, res, 'POST \/api\/campaigns\/:id\/recipients'\)/,
  'POST /api/contacts/:id/time-zone': /parsedBodyOr400\(req, res, 'POST \/api\/contacts\/:id\/time-zone'\)/,
  'POST /api/contacts/:id/quotes': /parsedBodyOr400\(req, res, 'POST \/api\/contacts\/:id\/quotes'\)/,
  'POST /api/contacts/:id/lawful-basis': /parsedBodyOr400\(req, res, 'POST \/api\/contacts\/:id\/lawful-basis'\)/,
  'POST /api/contacts/:id/revoke-consent': /parsedBodyOr400\(req, res, 'POST \/api\/contacts\/:id\/revoke-consent'\)/,
  'POST /api/leads/import': /parsedBodyOr400\(req, res, 'POST \/api\/leads\/import'\)/,
  'POST /api/leads/notice-sent': /parsedBodyOr400\(req, res, 'POST \/api\/leads\/notice-sent'\)/,
  'POST /api/leads/score': /parsedBodyOr400\(req, res, 'POST \/api\/leads\/score'\)/,
  'POST /api/leads/discover': /parsedBodyOr400\(req, res, 'POST \/api\/leads\/discover'\)/,
  'POST /api/knowledge': /parseOrRespond\(createKnowledgeItemSchema, req, res\)/,
  'POST /api/pipeline': /parseOrRespond\(createOpportunitySchema, req, res\)/,
  'POST /api/leads': /createContact\(req, res, /,
  'POST /api/investors': /createContact\(req, res, /,
  'POST /api/partners': /createContact\(req, res, /,
};
