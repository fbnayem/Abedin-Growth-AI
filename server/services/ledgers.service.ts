/**
 * Ledger reads.
 *
 * THREE DEFECTS WERE MEASURED HERE, and two of them are the same shape as bugs already fixed
 * elsewhere in this codebase.
 *
 *  1. NO TENANCY FILTER. Every one of these four tables declares `organization_id` NOT NULL, and
 *     not one method filtered on it. `getOpenQuestions(conversationId)` returned every row whose
 *     conversation id matched, in any organisation. A conversation-id collision across tenants
 *     would put one customer's objections into another customer's prompt. It is latent today
 *     only because these queries cannot run at all (see 3), which is not a control.
 *
 *  2. NO SUPERSESSION FILTER. `question_ledger` carries `valid_until` and `superseded_by`, and
 *     the query filtered only on `status = 'OPEN'`. A superseded question would re-enter a
 *     prompt as current — the same §20 defect P1.6 fixed for facts, in a table nobody had read.
 *
 *  3. THEY CANNOT RUN. All four query `db`, which is a Drizzle handle over PostgreSQL. With
 *     `DATABASE_URL` unset — as it is in this deployment — `server/db/index.ts` exports a Proxy
 *     that THROWS on any property access. So every call here raises
 *     "Database is not configured", and three of the four methods have zero callers anyway.
 *
 * Point 3 is why the org filter is added rather than merely noted: the moment PostgreSQL is
 * provisioned these become live, and a cross-tenant read that ships with the database is worse
 * than one caught while it was still unreachable.
 *
 * `organizationId` is a REQUIRED first parameter on every method. It is not optional and has no
 * default: an optional tenant scope is one a caller can forget, and forgetting is the failure.
 */

import { db } from '../db/index';
import { customerCommitments, questionLedger, objectionLedger } from '../db/schema';
import { eq, and, or, isNull, gt } from 'drizzle-orm';

export class LedgerService {
  async getUnresolvedCommitments(organizationId: string, contactId: string) {
    if (!organizationId || !contactId) return [];
    return db
      .select()
      .from(customerCommitments)
      .where(
        and(
          eq(customerCommitments.organizationId, organizationId),
          eq(customerCommitments.contactId, contactId),
          eq(customerCommitments.status, 'UNRESOLVED')
        )
      );
  }

  /**
   * `now` is injected (P1.9) so the validity boundary is testable. A query that reads the wall
   * clock cannot be tested at the instant a row expires.
   */
  async getOpenQuestions(organizationId: string, conversationId: string, now: Date = new Date()) {
    if (!organizationId || !conversationId) return [];
    return db
      .select()
      .from(questionLedger)
      .where(
        and(
          eq(questionLedger.organizationId, organizationId),
          eq(questionLedger.conversationId, conversationId),
          eq(questionLedger.status, 'OPEN'),
          // Supersession is not implied by status. A question can be OPEN and superseded at the
          // same time; only the successor should reach a prompt.
          isNull(questionLedger.supersededBy),
          // An absent validUntil means "still valid", not "expired". `isNull` first, because a
          // NULL comparison in SQL is neither true nor false and would drop every open row.
          or(isNull(questionLedger.validUntil), gt(questionLedger.validUntil, now))
        )
      );
  }

  async getUnresolvedObjections(organizationId: string, conversationId: string, now: Date = new Date()) {
    if (!organizationId || !conversationId) return [];
    return db
      .select()
      .from(objectionLedger)
      .where(
        and(
          eq(objectionLedger.organizationId, organizationId),
          eq(objectionLedger.conversationId, conversationId),
          eq(objectionLedger.status, 'UNRESOLVED'),
          isNull(objectionLedger.supersededBy),
          or(isNull(objectionLedger.validUntil), gt(objectionLedger.validUntil, now))
        )
      );
  }

  // S25 — `getQuotes` read the retired `quote_snapshots` table; quotes are documents now, read
  // by server/services/quote.service.ts.
}
