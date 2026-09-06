/**
 * P1.8 remainder — adapters between what the ledger tables STORE and what the context bundle
 * REQUIRES.
 *
 * `buildContextBundle` asks for `{id, question}`, `{id, objection}` and `{id, commitment, dueAt}`.
 * The tables hold `questionText`, `statement` and `dueDate`. Nothing reconciled them, because
 * nothing ever called the ledger reads: three of the four methods in `ledgers.service.ts` have
 * zero call sites repo-wide.
 *
 * The reconciliation is an explicit, tested function rather than a cast at the call site. A cast
 * would have compiled — `as any` is how the live drafting path came to be called with four of
 * its six required fields under the wrong names, throwing a TypeError on every inbound email.
 *
 * These adapters also enforce two invariants the queries do not:
 *
 *   TENANCY. Every ledger table declares `organization_id` NOT NULL, and not one of the four
 *   query methods filters on it. A `conversation_id` collision across organisations would put
 *   one customer's objections into another customer's prompt. Filtering belongs in the query and
 *   is fixed there too, but a row that reaches here carrying the wrong organisation is DROPPED
 *   and reported rather than rendered — the prompt is the last place to catch it.
 *
 *   SUPERSESSION. `question_ledger` carries `valid_until`/`superseded_by`, and
 *   `getOpenQuestions` filtered only on `status = 'OPEN'`. A superseded question would re-enter
 *   a prompt as current — the same §20 defect P1.6 fixed for facts, in a table nobody had
 *   looked at yet.
 */

import type { Quote, QuoteLineItem } from '../../shared/domain/quote';
import { isCurrencyCode, type CurrencyCode } from '../../shared/domain/pricing';

export interface AdaptedLedgers {
  openQuestions: { id: string; question: string }[];
  unresolvedObjections: { id: string; objection: string }[];
  outstandingCommitments: { id: string; commitment: string; dueAt: string | null }[];
  /** Rows refused, with the reason. A row dropped silently is indistinguishable from absence. */
  rejected: { table: string; id: string; reason: string }[];
}

export type LedgerRejectionReason =
  | 'WRONG_ORGANIZATION'
  | 'SUPERSEDED'
  | 'NO_LONGER_VALID'
  | 'MISSING_TEXT'
  | 'MISSING_ID';

interface RowBase {
  id?: unknown;
  organizationId?: unknown;
  supersededBy?: unknown;
  validUntil?: unknown;
}

/** ISO string, or null. Accepts Date, Firestore Timestamp, ISO string, epoch millis. */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const candidate = value as { toMillis?: () => number; toDate?: () => Date };
  if (typeof candidate.toMillis === 'function') {
    const ms = candidate.toMillis();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (typeof candidate.toDate === 'function') {
    const asDate = candidate.toDate();
    return asDate instanceof Date && !Number.isNaN(asDate.getTime()) ? asDate.toISOString() : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/**
 * Shared gate. Returns a rejection reason, or null when the row may be used.
 *
 * `now` is injected (P1.9): a validity check that reads the wall clock cannot be tested at the
 * boundary where it matters.
 */
function rejectionFor(row: RowBase, expectedOrgId: string, now: string): LedgerRejectionReason | null {
  if (typeof row.id !== 'string' || row.id.length === 0) return 'MISSING_ID';

  // Not `!==` against a possibly-absent field: a row with NO organisation is as unusable as one
  // with the wrong organisation. Both are "we cannot show this belongs here" (§14).
  if (typeof row.organizationId !== 'string' || row.organizationId !== expectedOrgId) {
    return 'WRONG_ORGANIZATION';
  }

  if (typeof row.supersededBy === 'string' && row.supersededBy.length > 0) return 'SUPERSEDED';

  const validUntil = toIso(row.validUntil);
  if (validUntil !== null && validUntil <= now) return 'NO_LONGER_VALID';

  return null;
}

function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export interface LedgerRows {
  questions?: readonly Record<string, unknown>[];
  objections?: readonly Record<string, unknown>[];
  commitments?: readonly Record<string, unknown>[];
}

export function adaptLedgers(rows: LedgerRows, expectedOrgId: string, now: string): AdaptedLedgers {
  const out: AdaptedLedgers = {
    openQuestions: [],
    unresolvedObjections: [],
    outstandingCommitments: [],
    rejected: [],
  };

  const run = (
    table: string,
    source: readonly Record<string, unknown>[] | undefined,
    textField: string,
    accept: (id: string, text: string, row: Record<string, unknown>) => void
  ): void => {
    for (const row of source ?? []) {
      const reason = rejectionFor(row as RowBase, expectedOrgId, now);
      const id = typeof row.id === 'string' ? row.id : '(no id)';
      if (reason !== null) {
        out.rejected.push({ table, id, reason });
        continue;
      }
      const text = textOf(row[textField]);
      if (text === null) {
        out.rejected.push({ table, id, reason: 'MISSING_TEXT' });
        continue;
      }
      accept(row.id as string, text, row);
    }
  };

  // question_ledger.question_text -> question
  run('question_ledger', rows.questions, 'questionText', (id, question) => {
    out.openQuestions.push({ id, question });
  });

  // objection_ledger.statement -> objection
  run('objection_ledger', rows.objections, 'statement', (id, objection) => {
    out.unresolvedObjections.push({ id, objection });
  });

  // customer_commitments.due_date -> dueAt, and a Date becomes an ISO string. The bundle
  // renders `dueAt` into a prompt; a Date object would render as "[object Object]".
  run('customer_commitments', rows.commitments, 'commitment', (id, commitment, row) => {
    out.outstandingCommitments.push({ id, commitment, dueAt: toIso(row.dueDate) });
  });

  // Deterministic order. The bundle breaks ties by id and hashes what it selected; a datastore
  // that returned rows in a different order between runs would change the manifest without the
  // data changing.
  out.openQuestions.sort((a, b) => a.id.localeCompare(b.id));
  out.unresolvedObjections.sort((a, b) => a.id.localeCompare(b.id));
  out.outstandingCommitments.sort((a, b) => a.id.localeCompare(b.id));
  out.rejected.sort((a, b) => (a.table + a.id).localeCompare(b.table + b.id));

  return out;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export type QuoteAdaptation =
  | { readonly ok: true; readonly quote: Quote }
  | { readonly ok: false; readonly id: string; readonly reason: string };

const QUOTE_STATUSES = new Set([
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'WITHDRAWN',
  'EXPIRED',
  'SUPERSEDED',
]);

function lineItemsFrom(details: unknown): QuoteLineItem[] | null {
  if (details === null || typeof details !== 'object') return null;
  const raw = (details as { lineItems?: unknown }).lineItems;
  if (!Array.isArray(raw)) return null;
  const items: QuoteLineItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    const price = e.unitPrice as { amountMinor?: unknown; currency?: unknown } | undefined;
    if (
      typeof e.description !== 'string' ||
      typeof e.quantity !== 'number' ||
      !Number.isInteger(e.quantity) ||
      price === undefined ||
      price === null ||
      !Number.isInteger(price.amountMinor) ||
      typeof price.currency !== 'string' ||
      !isCurrencyCode(price.currency)
    ) {
      // A malformed line item is not repaired. Money that cannot be read exactly is money we
      // must not quote (P1.7: minor units, integers, a closed currency set).
      return null;
    }
    items.push({
      tierId: typeof e.tierId === 'string' ? e.tierId : null,
      description: e.description,
      quantity: e.quantity,
      unitPrice: { amountMinor: price.amountMinor as number, currency: price.currency as CurrencyCode },
    });
  }
  return items;
}

/**
 * Build a `Quote` from a `quote_snapshots` row.
 *
 * The table cannot express a Quote on its own: it has no `version`, `approved_by`, `approved_at`,
 * `superseded_by`, `updated_at` or `conversation_id` column, and holds line items inside an
 * untyped `details` jsonb blob. Those columns are added by this tranche; a row written before
 * they existed carries none of them.
 *
 * That matters commercially rather than cosmetically. `quoteBinding()` refuses a quote whose
 * `approvedBy` is absent — "an approval nobody is accountable for is not an approval" (§14) — so
 * an adapter that filled the gap with `null` would hand back a quote that silently never binds,
 * and the customer would be quoted list pricing despite having negotiated a price. This function
 * therefore REFUSES such a row and says which field is missing, rather than producing a Quote
 * that looks valid and behaves as though no quote existed.
 */
export function adaptQuoteSnapshot(row: Record<string, unknown>, expectedOrgId: string): QuoteAdaptation {
  const id = typeof row.id === 'string' ? row.id : '(no id)';
  const refuse = (reason: string): QuoteAdaptation => ({ ok: false, id, reason });

  if (typeof row.id !== 'string' || row.id.length === 0) return refuse('the row has no id');
  if (typeof row.organizationId !== 'string' || row.organizationId !== expectedOrgId) {
    return refuse(`the row belongs to ${String(row.organizationId)}, not ${expectedOrgId}`);
  }
  if (typeof row.contactId !== 'string' || row.contactId.length === 0) {
    return refuse('the row names no contact, so it cannot be attributed to a customer');
  }

  const status = typeof row.status === 'string' ? row.status : '';
  if (!QUOTE_STATUSES.has(status)) {
    return refuse(`status ${JSON.stringify(row.status)} is not a quote state`);
  }

  const validFrom = toIso(row.validFrom ?? row.quotedAt);
  if (validFrom === null) return refuse('the row has no start date, so its offer window is unknown');

  const lineItems = lineItemsFrom(row.details);
  if (lineItems === null) {
    return refuse('the details blob does not hold readable line items in minor units');
  }
  if (lineItems.length === 0) return refuse('the quote has no line items');

  const currencies = new Set(lineItems.map((i) => i.unitPrice.currency));
  if (currencies.size > 1) {
    return refuse(`the line items mix currencies (${[...currencies].join(', ')})`);
  }
  const currency = [...currencies][0];

  const approvedBy = typeof row.approvedBy === 'string' && row.approvedBy.length > 0 ? row.approvedBy : null;
  if (status === 'APPROVED' && approvedBy === null) {
    return refuse(
      'the row is APPROVED but names no approver. Adapting it would produce a quote that ' +
        'quoteBinding() silently refuses, so the customer would be sent list pricing instead of ' +
        'the price they negotiated'
    );
  }

  const version = Number.isInteger(row.version) ? (row.version as number) : null;
  if (version === null) return refuse('the row has no version, so two edits cannot be ordered');

  const createdAt = toIso(row.createdAt ?? row.quotedAt);

  return {
    ok: true,
    quote: {
      id: row.id,
      organizationId: row.organizationId,
      contactId: row.contactId,
      conversationId: typeof row.conversationId === 'string' ? row.conversationId : null,
      currency,
      lineItems,
      status: status as Quote['status'],
      version,
      validFrom,
      validUntil: toIso(row.validUntil ?? row.expiresAt),
      approvedBy,
      approvedAt: toIso(row.approvedAt),
      supersededBy: typeof row.supersededBy === 'string' && row.supersededBy.length > 0 ? row.supersededBy : null,
      createdAt: createdAt ?? validFrom,
      updatedAt: toIso(row.updatedAt) ?? createdAt ?? validFrom,
    },
  };
}

export function adaptQuoteSnapshots(
  rows: readonly Record<string, unknown>[],
  expectedOrgId: string
): { quotes: Quote[]; rejected: { id: string; reason: string }[] } {
  const quotes: Quote[] = [];
  const rejected: { id: string; reason: string }[] = [];
  for (const row of rows) {
    const adapted = adaptQuoteSnapshot(row, expectedOrgId);
    if (adapted.ok === true) quotes.push(adapted.quote);
    else rejected.push({ id: adapted.id, reason: adapted.reason });
  }
  quotes.sort((a, b) => a.id.localeCompare(b.id));
  rejected.sort((a, b) => a.id.localeCompare(b.id));
  return { quotes, rejected };
}
