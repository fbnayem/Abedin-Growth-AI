import { z } from 'zod';
import type { Request, Response } from 'express';

/**
 * P1.10 — INPUT VALIDATION AND MASS ASSIGNMENT (addendum §11, §16).
 *
 * WHAT WAS WRONG
 * --------------
 * Six handlers built their document with `{ ...req.body, ...ourFields }`. Everything the
 * caller sent was persisted, and the pattern has three distinct consequences:
 *
 *   1. FIELDS THE CALLER SHOULD NOT SET. `POST /api/leads` spread the body and then set
 *      `status: 'NEW'`. Whatever else arrived — `aiScore`, `suppressed`, `consentGiven`,
 *      `organizationId` — was written verbatim. `consentGiven` is the one that matters: the
 *      action gateway reads it to decide whether a contact may be emailed, so a caller could
 *      create a contact that is pre-consented to receive mail.
 *   2. UNBOUNDED DOCUMENTS. No size limit, no field count limit. A single request could write
 *      a document large enough to make every later read of that collection expensive.
 *   3. NO TYPES. `estimatedValue` could be a string, an object, or absent, and the arithmetic
 *      downstream would produce NaN and render as "NaN".
 *
 * THE RULE
 * --------
 * Parse, then build. The handler receives a typed object containing exactly the fields the
 * schema names, and constructs the document explicitly. Anything not in the schema is dropped
 * — not rejected, dropped — because a client sending an extra field is usually a version skew,
 * while a field silently reaching the datastore is a security problem.
 *
 * Server-controlled fields (`id`, `organizationId`, `status`, `version`, timestamps) are never
 * in an input schema. They cannot be omitted by accident, because they are not offered.
 */

/** Guards against a single request writing an unbounded document. */
export const MAX_STRING = 10_000;
export const MAX_SHORT_STRING = 500;
export const MAX_ARRAY = 200;

const shortText = z.string().trim().max(MAX_SHORT_STRING);
const longText = z.string().trim().max(MAX_STRING);

/** An email address as a caller supplies it. Normalisation is server-side (lib/emailKey). */
const emailish = z.string().trim().max(320);

/**
 * A contact created through the API.
 *
 * NOT accepted, deliberately: `consentGiven`, `suppressed`, `suppressionReason`, `country` as
 * a consent proxy, `organizationId`, `id`, `status`, `version`, `aiScore`. Consent in
 * particular is a record of something that happened in the world; it cannot be asserted by the
 * request that creates the contact (§14).
 */
export const createContactSchema = z.object({
  name: shortText.optional(),
  firstName: shortText.optional(),
  lastName: shortText.optional(),
  email: emailish,
  title: shortText.optional(),
  phone: shortText.optional(),
  linkedinUrl: shortText.optional(),
  companyName: shortText.optional(),
  companyWebsite: shortText.optional(),
  industry: shortText.optional(),
  country: shortText.optional(),
  employeeCount: shortText.optional(),
  notes: longText.optional(),
});

export const createKnowledgeItemSchema = z.object({
  title: shortText,
  content: longText,
  category: shortText.optional(),
  tags: z.array(shortText).max(MAX_ARRAY).optional(),
});

export const createOpportunitySchema = z.object({
  title: shortText.optional(),
  companyName: shortText.optional(),
  contactName: shortText.optional(),
  contactEmail: emailish.optional(),
  // Accepted under either name because both are already in use by callers; the handler picks
  // one and writes one, rather than persisting whichever arrived.
  estimatedValue: z.number().finite().min(0).max(1_000_000_000).optional(),
  value: z.number().finite().min(0).max(1_000_000_000).optional(),
  currency: z.string().trim().length(3).optional(),
  stage: shortText.optional(),
  nextStep: shortText.optional(),
  expectedCloseDate: shortText.optional(),
});

export type CreateContactInput = z.infer<typeof createContactSchema>;
export type CreateKnowledgeItemInput = z.infer<typeof createKnowledgeItemSchema>;
export type CreateOpportunityInput = z.infer<typeof createOpportunitySchema>;

export type ParseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; issues: { path: string; message: string }[] };

/**
 * Parse a request body against a schema.
 *
 * Returns the issues rather than throwing, so a handler answers 400 with something a caller
 * can act on instead of a 500 carrying a stack trace.
 */
export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown
): ParseOutcome<z.infer<S>> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return { ok: true, value: result.data };

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(body)',
      message: issue.message,
    })),
  };
}

/** 400 with the specific problems, in the shared error envelope. */
export function sendValidationError(
  res: Response,
  issues: { path: string; message: string }[]
): Response {
  return res.status(400).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'The request body is not valid.',
      details: { issues },
    },
  });
}

/**
 * Parse, or answer 400 and return null. The handler checks for null and stops.
 */
export function parseOrRespond<S extends z.ZodTypeAny>(
  schema: S,
  req: Request,
  res: Response
): z.infer<S> | null {
  const parsed = parseBody(schema, req.body);
  if (parsed.ok === false) {
    sendValidationError(res, parsed.issues);
    return null;
  }
  return parsed.value;
}

/**
 * Project an object through an allow-list before it leaves the server.
 *
 * The mirror of input validation, and the one that stops internal fields leaking outward:
 * documents read back from the datastore carry whatever anyone ever wrote to them, including
 * fields written before validation existed.
 */
export function project<T extends Record<string, unknown>>(
  source: T | null | undefined,
  fields: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!source) return out;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field];
  }
  return out;
}

/**
 * P1.10 (§34) — CSV injection.
 *
 * A cell beginning `=`, `+`, `-`, `@`, tab or carriage return is executed as a formula when the
 * file is opened in Excel or Sheets. Since these exports carry names, subjects and email
 * bodies supplied by external parties, an attacker can put `=HYPERLINK(...)` or a DDE payload
 * in a contact name and have it run on the operator's machine when they open the export.
 *
 * Prefixing with an apostrophe is the standard neutralisation: the spreadsheet treats the cell
 * as literal text and does not display the apostrophe.
 */
export function neutralizeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (text.length === 0) return text;

  const first = text[0];
  const dangerous = ['=', '+', '-', '@', '\t', '\r'];
  const prefixed = dangerous.includes(first) ? `'${text}` : text;

  // Standard CSV quoting, applied after neutralisation so the apostrophe is inside the quotes.
  if (/[",\n\r]/.test(prefixed)) {
    return `"${prefixed.replace(/"/g, '""')}"`;
  }
  return prefixed;
}

/** A CSV row with every cell neutralised. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(neutralizeCsvCell).join(',');
}
