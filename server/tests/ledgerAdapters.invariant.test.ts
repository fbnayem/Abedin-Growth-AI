import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  adaptLedgers,
  adaptQuoteSnapshot,
  adaptQuoteSnapshots,
  toIso,
} from '../domain/ledgerAdapters';
import { quoteBinding } from '../../shared/domain/quote';
import { CURRENCIES, isCurrencyCode } from '../../shared/domain/pricing';

const ORG = 'org_1';
const OTHER = 'org_2';
const NOW = '2026-09-07T12:00:00.000Z';

describe('P1.8 remainder — ledger adapters', () => {
  // -------------------------------------------------------------------------
  describe('the field names the bundle needs, which the tables do not use', () => {
    it('question_text becomes question, statement becomes objection, due_date becomes dueAt', () => {
      const out = adaptLedgers(
        {
          questions: [{ id: 'q1', organizationId: ORG, questionText: 'What is the SLA?' }],
          objections: [{ id: 'o1', organizationId: ORG, statement: 'Too expensive.' }],
          commitments: [
            {
              id: 'c1',
              organizationId: ORG,
              commitment: 'Send the security pack',
              dueDate: new Date('2026-09-10T09:00:00Z'),
            },
          ],
        },
        ORG,
        NOW
      );
      expect(out.openQuestions).toEqual([{ id: 'q1', question: 'What is the SLA?' }]);
      expect(out.unresolvedObjections).toEqual([{ id: 'o1', objection: 'Too expensive.' }]);
      expect(out.outstandingCommitments).toEqual([
        { id: 'c1', commitment: 'Send the security pack', dueAt: '2026-09-10T09:00:00.000Z' },
      ]);
      expect(out.rejected).toEqual([]);
    });

    it('a Date due date becomes an ISO string, not "[object Object]" in a prompt', () => {
      const out = adaptLedgers(
        { commitments: [{ id: 'c1', organizationId: ORG, commitment: 'x', dueDate: new Date('2026-01-02T03:04:05Z') }] },
        ORG,
        NOW
      );
      expect(out.outstandingCommitments[0].dueAt).toBe('2026-01-02T03:04:05.000Z');
      expect(String(out.outstandingCommitments[0].dueAt)).not.toContain('object');
    });

    it('an absent due date is null, not the current time', () => {
      const out = adaptLedgers({ commitments: [{ id: 'c1', organizationId: ORG, commitment: 'x' }] }, ORG, NOW);
      expect(out.outstandingCommitments[0].dueAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('tenancy — the prompt is the last place to catch a cross-tenant row', () => {
    it('a row from another organisation is DROPPED and reported', () => {
      const out = adaptLedgers(
        {
          questions: [
            { id: 'mine', organizationId: ORG, questionText: 'ours' },
            { id: 'theirs', organizationId: OTHER, questionText: 'someone else customer secret' },
          ],
        },
        ORG,
        NOW
      );
      expect(out.openQuestions).toEqual([{ id: 'mine', question: 'ours' }]);
      expect(out.rejected).toContainEqual({ table: 'question_ledger', id: 'theirs', reason: 'WRONG_ORGANIZATION' });
      // The point: the other tenant's text never reaches the caller at all.
      expect(JSON.stringify(out.openQuestions)).not.toContain('secret');
    });

    it('a row with NO organisation is refused too — absent is not "ours"', () => {
      const out = adaptLedgers({ questions: [{ id: 'q1', questionText: 'x' }] }, ORG, NOW);
      expect(out.openQuestions).toEqual([]);
      expect(out.rejected[0].reason).toBe('WRONG_ORGANIZATION');
    });

    it('every table is filtered, not just the first', () => {
      const out = adaptLedgers(
        {
          questions: [{ id: 'q', organizationId: OTHER, questionText: 'x' }],
          objections: [{ id: 'o', organizationId: OTHER, statement: 'x' }],
          commitments: [{ id: 'c', organizationId: OTHER, commitment: 'x' }],
        },
        ORG,
        NOW
      );
      expect(out.openQuestions).toEqual([]);
      expect(out.unresolvedObjections).toEqual([]);
      expect(out.outstandingCommitments).toEqual([]);
      expect(out.rejected).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  describe('supersession — the §20 defect, in a table nobody had read', () => {
    it('a superseded question is excluded and the reason is recorded', () => {
      const out = adaptLedgers(
        {
          questions: [
            { id: 'old', organizationId: ORG, questionText: 'stale', supersededBy: 'new' },
            { id: 'new', organizationId: ORG, questionText: 'current' },
          ],
        },
        ORG,
        NOW
      );
      expect(out.openQuestions).toEqual([{ id: 'new', question: 'current' }]);
      expect(out.rejected).toContainEqual({ table: 'question_ledger', id: 'old', reason: 'SUPERSEDED' });
    });

    it('an expired row is excluded, and the boundary is exact', () => {
      const past = adaptLedgers(
        { questions: [{ id: 'q', organizationId: ORG, questionText: 'x', validUntil: '2026-09-07T11:59:59Z' }] },
        ORG,
        NOW
      );
      const future = adaptLedgers(
        { questions: [{ id: 'q', organizationId: ORG, questionText: 'x', validUntil: '2026-09-07T12:00:01Z' }] },
        ORG,
        NOW
      );
      const exactly = adaptLedgers(
        { questions: [{ id: 'q', organizationId: ORG, questionText: 'x', validUntil: NOW }] },
        ORG,
        NOW
      );
      expect(past.openQuestions).toEqual([]);
      expect(future.openQuestions).toHaveLength(1);
      // At the instant of expiry it has expired.
      expect(exactly.openQuestions).toEqual([]);
    });

    it('an absent validUntil means still valid, not expired', () => {
      const out = adaptLedgers({ questions: [{ id: 'q', organizationId: ORG, questionText: 'x' }] }, ORG, NOW);
      expect(out.openQuestions).toHaveLength(1);
    });

    it('an empty-string supersededBy does not count as superseded', () => {
      const out = adaptLedgers(
        { questions: [{ id: 'q', organizationId: ORG, questionText: 'x', supersededBy: '' }] },
        ORG,
        NOW
      );
      expect(out.openQuestions).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('malformed rows are refused rather than rendered', () => {
    it('a row with no text is refused', () => {
      const out = adaptLedgers(
        { questions: [{ id: 'q', organizationId: ORG, questionText: '   ' }, { id: 'q2', organizationId: ORG }] },
        ORG,
        NOW
      );
      expect(out.openQuestions).toEqual([]);
      expect(out.rejected.every((r) => r.reason === 'MISSING_TEXT')).toBe(true);
    });

    it('a row with no id is refused — it could not be named in the manifest', () => {
      const out = adaptLedgers({ questions: [{ organizationId: ORG, questionText: 'x' }] }, ORG, NOW);
      expect(out.openQuestions).toEqual([]);
      expect(out.rejected[0].reason).toBe('MISSING_ID');
    });

    it('absent inputs are empty, not an error', () => {
      const out = adaptLedgers({}, ORG, NOW);
      expect(out.openQuestions).toEqual([]);
      expect(out.rejected).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('determinism — the manifest must not change when the data has not', () => {
    it('output order is stable regardless of input order', () => {
      const rows = [
        { id: 'c', organizationId: ORG, questionText: 'third' },
        { id: 'a', organizationId: ORG, questionText: 'first' },
        { id: 'b', organizationId: ORG, questionText: 'second' },
      ];
      const forward = adaptLedgers({ questions: rows }, ORG, NOW);
      const reversed = adaptLedgers({ questions: [...rows].reverse() }, ORG, NOW);
      expect(forward.openQuestions).toEqual(reversed.openQuestions);
      expect(forward.openQuestions.map((q) => q.id)).toEqual(['a', 'b', 'c']);
    });

    it('rejections are ordered too', () => {
      const rows = [
        { id: 'z', organizationId: OTHER, questionText: 'x' },
        { id: 'a', organizationId: OTHER, questionText: 'x' },
      ];
      expect(adaptLedgers({ questions: rows }, ORG, NOW).rejected.map((r) => r.id)).toEqual(['a', 'z']);
    });
  });

  // -------------------------------------------------------------------------
  describe('quotes — the table cannot express a Quote, and the adapter says so', () => {
    const goodDetails = {
      lineItems: [
        { tierId: 'standard', description: 'Standard tier', quantity: 1, unitPrice: { amountMinor: 49_900, currency: 'GBP' } },
      ],
    };
    const goodRow = () => ({
      id: 'qs1',
      organizationId: ORG,
      contactId: 'ct_1',
      status: 'APPROVED',
      approvedBy: 'nayem@abedin.example',
      approvedAt: '2026-09-01T10:00:00Z',
      version: 3,
      quotedAt: new Date('2026-09-01T10:00:00Z'),
      expiresAt: new Date('2026-10-01T10:00:00Z'),
      details: goodDetails,
    });

    it('a complete row becomes a Quote that actually binds', () => {
      const adapted = adaptQuoteSnapshot(goodRow(), ORG);
      expect(adapted.ok).toBe(true);
      if (adapted.ok === true) {
        expect(adapted.quote.currency).toBe('GBP');
        expect(adapted.quote.lineItems[0].unitPrice.amountMinor).toBe(49_900);
        expect(quoteBinding(adapted.quote, NOW).binding).toBe(true);
      }
    });

    it('an APPROVED row with no approver is REFUSED, not adapted into a silent non-quote', () => {
      // The commercially dangerous case. quoteBinding() refuses a quote with no approver, so
      // adapting it would hand back something that never binds — and the customer would be sent
      // list pricing despite having negotiated a price. Refusing says why.
      const row: Record<string, unknown> = { ...goodRow(), approvedBy: undefined };
      const adapted = adaptQuoteSnapshot(row, ORG);
      expect(adapted.ok).toBe(false);
      if (adapted.ok === false) {
        expect(adapted.reason).toContain('names no approver');
        expect(adapted.reason).toContain('list pricing');
      }
    });

    it('a row with no version is refused — two edits could not be ordered', () => {
      const row: Record<string, unknown> = { ...goodRow(), version: undefined };
      const adapted = adaptQuoteSnapshot(row, ORG);
      expect(adapted.ok).toBe(false);
      if (adapted.ok === false) expect(adapted.reason).toContain('version');
    });

    it('a row from another organisation is refused', () => {
      const adapted = adaptQuoteSnapshot({ ...goodRow(), organizationId: OTHER }, ORG);
      expect(adapted.ok).toBe(false);
    });

    it('money that cannot be read exactly is refused, never repaired', () => {
      const bad = [
        { lineItems: [{ description: 'x', quantity: 1, unitPrice: { amountMinor: 499.5, currency: 'GBP' } }] },
        { lineItems: [{ description: 'x', quantity: 1, unitPrice: { amountMinor: 499, currency: 'USD' } }] },
        { lineItems: [{ description: 'x', quantity: 1.5, unitPrice: { amountMinor: 499, currency: 'GBP' } }] },
        { lineItems: [{ description: 'x', quantity: 1 }] },
        { lineItems: 'not an array' },
        {},
        null,
      ];
      for (const details of bad) {
        const adapted = adaptQuoteSnapshot({ ...goodRow(), details }, ORG);
        expect(adapted.ok).toBe(false);
      }
    });

    it('mixed currencies in one quote are refused', () => {
      const adapted = adaptQuoteSnapshot(
        {
          ...goodRow(),
          details: {
            lineItems: [
              { description: 'a', quantity: 1, unitPrice: { amountMinor: 1, currency: 'GBP' } },
              { description: 'b', quantity: 1, unitPrice: { amountMinor: 1, currency: 'ZZZ' } },
            ],
          },
        },
        ORG
      );
      expect(adapted.ok).toBe(false);
    });

    it('a status outside the quote lifecycle is refused', () => {
      for (const status of ['ACTIVE', 'SENT', '', undefined, 'approved']) {
        expect(adaptQuoteSnapshot({ ...goodRow(), status }, ORG).ok).toBe(false);
      }
    });

    it('a DRAFT row needs no approver, and does not bind', () => {
      const row: Record<string, unknown> = { ...goodRow(), status: 'DRAFT', approvedBy: undefined };
      const adapted = adaptQuoteSnapshot(row, ORG);
      expect(adapted.ok).toBe(true);
      if (adapted.ok === true) expect(quoteBinding(adapted.quote, NOW).binding).toBe(false);
    });

    it('the batch form separates what it took from what it refused', () => {
      const { quotes, rejected } = adaptQuoteSnapshots(
        [goodRow(), { ...goodRow(), id: 'bad', approvedBy: undefined }],
        ORG
      );
      expect(quotes.map((q) => q.id)).toEqual(['qs1']);
      expect(rejected.map((r) => r.id)).toEqual(['bad']);
    });
  });

  // -------------------------------------------------------------------------
  describe('currency is checkable at run time', () => {
    it('CURRENCIES exists as a value and the type derives from it', () => {
      expect(Array.isArray(CURRENCIES)).toBe(true);
      expect(CURRENCIES).toContain('GBP');
    });

    it('the guard rejects anything outside the closed set', () => {
      expect(isCurrencyCode('GBP')).toBe(true);
      for (const bad of ['USD', 'gbp', '', null, undefined, 0, {}]) {
        expect(isCurrencyCode(bad)).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('toIso', () => {
    it('handles a Date, a Firestore Timestamp, an ISO string and epoch millis', () => {
      const iso = '2026-09-07T12:00:00.000Z';
      expect(toIso(new Date(iso))).toBe(iso);
      expect(toIso({ toMillis: () => Date.parse(iso) })).toBe(iso);
      expect(toIso({ toDate: () => new Date(iso) })).toBe(iso);
      expect(toIso(iso)).toBe(iso);
      expect(toIso(Date.parse(iso))).toBe(iso);
    });

    it('unusable values are null, never a fabricated instant', () => {
      for (const bad of [null, undefined, '', 'tomorrow', {}, NaN, new Date('nope')]) {
        expect(toIso(bad)).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('the ledger queries themselves', () => {
    const source = readFileSync('server/services/ledgers.service.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    it('every method takes organizationId FIRST and filters on it', () => {
      for (const method of [
        'getUnresolvedCommitments',
        'getOpenQuestions',
        'getUnresolvedObjections',
        // `getQuotes` left with the retired quote_snapshots table (S25); quotes are documents,
        // read by server/services/quote.service.ts and keyed by the customer's email.
      ]) {
        expect(source).toMatch(new RegExp(`${method}\\(\\s*organizationId: string`));
      }
      // Three tables, three filters (four, until the quote reader moved to the document store).
      expect((source.match(/\.organizationId, organizationId\)/g) || []).length).toBe(3);
    });

    it('question and objection reads exclude superseded rows', () => {
      expect(source).toContain('isNull(questionLedger.supersededBy)');
      expect(source).toContain('isNull(objectionLedger.supersededBy)');
    });

    it('an absent validUntil is treated as still valid, not as expired', () => {
      // `gt(validUntil, now)` alone drops every NULL row, because a NULL comparison in SQL is
      // neither true nor false. The isNull branch is what keeps open rows open.
      expect(source).toContain('or(isNull(questionLedger.validUntil), gt(questionLedger.validUntil, now))');
    });

    it('the clock is injected so the validity boundary is testable', () => {
      expect(source).toContain('now: Date = new Date()');
    });
  });
});
