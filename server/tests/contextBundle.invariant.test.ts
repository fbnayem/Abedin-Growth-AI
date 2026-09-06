import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULTS,
  buildContextBundle,
  hashContext,
  renderBundle,
  type ContextBundleInputs,
} from '../domain/contextBundle';
import type { StoredFact } from '../domain/facts';
import type { Quote } from '../../shared/domain/quote';

/**
 * INVARIANTS (addendum §21, §20, §24, §18 / P1.8).
 *
 * §21 Context is selected by rule and the selection is recorded, so a bad reply can be explained.
 * §20 A superseded fact is history and must not re-enter a prompt as current.
 * §24 A lapsed offer must not be restated as though it were still open.
 * §18 A model's paraphrase of a customer email must not render indistinguishably from a record.
 */

const NOW = '2026-09-06T12:00:00.000Z';

function fact(overrides: Partial<StoredFact> = {}): StoredFact {
  return {
    id: 'f1',
    organizationId: 'org1',
    conversationId: 'conv1',
    key: 'budget',
    value: '5000',
    sourceType: 'CUSTOMER_ASSERTION',
    sourceMessageId: 'm1',
    confidence: null,
    observedAt: '2026-01-01T00:00:00.000Z',
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    supersededBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastVerifiedAt: null,
    observationCount: 1,
    derivedFromUntrusted: true,
    ...overrides,
  };
}

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    id: 'q1',
    organizationId: 'org1',
    contactId: 'ct1',
    currency: 'GBP',
    lineItems: [{ tierId: 'standard', description: 'Standard', quantity: 1, unitPrice: { amountMinor: 42_500, currency: 'GBP' } }],
    status: 'APPROVED',
    version: 1,
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    approvedBy: 'operator@example.com',
    approvedAt: '2026-01-01T00:00:00.000Z',
    supersededBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function inputs(overrides: Partial<ContextBundleInputs> = {}): ContextBundleInputs {
  return {
    thread: [
      { id: 'm1', sender: 'PROSPECT', subject: 'Hello', bodyText: 'What does it cost?', sentAt: '2026-01-01T00:00:00.000Z' },
      { id: 'm2', sender: 'AGENT', subject: 'Re: Hello', bodyText: 'Happy to explain.', sentAt: '2026-01-02T00:00:00.000Z' },
      { id: 'm3', sender: 'PROSPECT', subject: 'Re: Hello', bodyText: 'And integrations?', sentAt: '2026-01-03T00:00:00.000Z' },
    ],
    facts: [],
    openQuestions: [],
    unresolvedObjections: [],
    outstandingCommitments: [],
    quotes: [],
    companyFacts: [],
    now: NOW,
    ...overrides,
  };
}

describe('§21 — the exact fixture the addendum names', () => {
  it('a superseded fact and a withdrawn quote yield a manifest excluding the superseded id and including the current quote id', () => {
    const supersededFact = fact({ id: 'f_old', value: '5000', validUntil: '2026-06-01T00:00:00.000Z', supersededBy: 'f_new' });
    const currentFact = fact({ id: 'f_new', value: '15000', observedAt: '2026-06-01T00:00:00.000Z' });
    const withdrawn = quote({ id: 'q_withdrawn', status: 'WITHDRAWN' });
    const current = quote({ id: 'q_current' });

    const bundle = buildContextBundle(
      inputs({ facts: [supersededFact, currentFact], quotes: [withdrawn, current] })
    );

    expect(bundle.contextIds).not.toContain('fact:f_old');
    expect(bundle.contextIds).toContain('fact:f_new');
    expect(bundle.contextIds).not.toContain('quote:q_withdrawn');
    expect(bundle.contextIds).toContain('quote:q_current');

    // And both exclusions are REPORTED, with a reason. A record dropped silently is
    // indistinguishable from one that was never there.
    const excludedIds = bundle.excluded.map((e) => e.id);
    expect(excludedIds).toContain('fact:f_old');
    expect(excludedIds).toContain('quote:q_withdrawn');
    expect(bundle.excluded.find((e) => e.id === 'fact:f_old')?.reason).toMatch(/[Ss]uperseded/);
    expect(bundle.excluded.find((e) => e.id === 'quote:q_withdrawn')?.reason).toMatch(/WITHDRAWN/);

    // The superseded value must not reach the prompt by any route.
    //
    // Asserted as `budget: 5000` rather than `5000`, because "15000" CONTAINS "5000" — the
    // same substring trap that made the old pricing check pass "£4,499" as "£499".
    expect(bundle.promptBlock).not.toContain('budget: 5000');
    expect(bundle.promptBlock).toContain('budget: 15000');
  });
});

describe('§20/§24 — history and lapsed offers stay out', () => {
  it('excludes every non-binding quote state', () => {
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'WITHDRAWN', 'EXPIRED', 'SUPERSEDED'] as const) {
      const bundle = buildContextBundle(inputs({ quotes: [quote({ id: `q_${status}`, status })] }));
      expect(bundle.contextIds, status).not.toContain(`quote:q_${status}`);
    }
  });

  it('excludes an expired quote and says when it expired', () => {
    const expired = quote({ id: 'q_exp', validUntil: '2026-02-01T00:00:00.000Z' });
    const bundle = buildContextBundle(inputs({ quotes: [expired] }));
    expect(bundle.contextIds).not.toContain('quote:q_exp');
    expect(bundle.excluded.find((e) => e.id === 'quote:q_exp')?.reason).toContain('2026-02-01');
  });

  it('excludes an APPROVED quote that names no approver', () => {
    const bundle = buildContextBundle(inputs({ quotes: [quote({ id: 'q_na', approvedBy: null })] }));
    expect(bundle.contextIds).not.toContain('quote:q_na');
  });
});

describe('§21 — the thread is BOUNDED, not concatenated whole', () => {
  it('includes the latest inbound message always', () => {
    const bundle = buildContextBundle(inputs());
    expect(bundle.contextIds[0]).toBe('msg:m3');
    expect(bundle.records[0].kind).toBe('INBOUND_MESSAGE');
  });

  it('caps the number of earlier turns and reports what it dropped', () => {
    // The previous implementation took EVERY turn with no limit, so a long thread silently
    // overflowed the context window and the model saw a truncation nobody chose.
    const thread = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      sender: (i % 2 === 0 ? 'PROSPECT' : 'AGENT') as 'PROSPECT' | 'AGENT',
      subject: 's',
      bodyText: `body ${i}`,
      sentAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    const bundle = buildContextBundle(inputs({ thread }), { maxThreadTurns: 5 });

    const turns = bundle.records.filter((r) => r.kind === 'THREAD_TURN');
    expect(turns).toHaveLength(5);
    expect(bundle.excluded.filter((e) => e.kind === 'THREAD_TURN').length).toBeGreaterThan(0);
  });

  it('enforces a total character budget and records each drop', () => {
    const thread = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      sender: 'AGENT' as const,
      subject: 's',
      bodyText: 'x'.repeat(500),
      sentAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    const bundle = buildContextBundle(inputs({ thread }), { maxThreadTurns: 10, maxTotalChars: 1200 });
    expect(bundle.totalChars).toBeLessThanOrEqual(1200);
    expect(bundle.excluded.some((e) => e.reason.includes('budget'))).toBe(true);
  });

  it('has sane defaults rather than unbounded ones', () => {
    expect(DEFAULTS.maxThreadTurns).toBeGreaterThan(0);
    expect(DEFAULTS.maxTotalChars).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULTS.maxTotalChars)).toBe(true);
  });
});

describe('§21 — selection is DETERMINISTIC', () => {
  it('produces the same manifest and hash for the same inputs', () => {
    const a = buildContextBundle(inputs({ facts: [fact({ id: 'f1' }), fact({ id: 'f2', key: 'seats', value: '10' })] }));
    const b = buildContextBundle(inputs({ facts: [fact({ id: 'f1' }), fact({ id: 'f2', key: 'seats', value: '10' })] }));
    expect(a.contextIds).toEqual(b.contextIds);
    expect(a.contextHash).toBe(b.contextHash);
  });

  it('is INSENSITIVE to the order the datastore returned records in', () => {
    // Two facts observed at the same instant would otherwise be ordered by whatever the query
    // returned, and the manifest would differ between two runs on identical data.
    const f1 = fact({ id: 'f1', key: 'a', value: '1', observedAt: NOW });
    const f2 = fact({ id: 'f2', key: 'b', value: '2', observedAt: NOW });
    const forward = buildContextBundle(inputs({ facts: [f1, f2] }));
    const reversed = buildContextBundle(inputs({ facts: [f2, f1] }));
    expect(forward.contextIds).toEqual(reversed.contextIds);
    expect(forward.contextHash).toBe(reversed.contextHash);
  });

  it('changes the hash when the CONTENT changes under a stable id', () => {
    // Hashing ids alone would not notice a fact's value being edited.
    const a = buildContextBundle(inputs({ facts: [fact({ id: 'f1', value: '5000' })] }));
    const b = buildContextBundle(inputs({ facts: [fact({ id: 'f1', value: '9000' })] }));
    expect(a.contextIds).toEqual(b.contextIds);
    expect(a.contextHash).not.toBe(b.contextHash);
  });

  it('changes the hash when the ORDER changes', () => {
    // Hashing content alone would not notice a reordering that changes what the model reads first.
    const records = [
      { id: 'a', kind: 'FACT' as const, content: 'one', untrusted: false, reason: '' },
      { id: 'b', kind: 'FACT' as const, content: 'two', untrusted: false, reason: '' },
    ];
    expect(hashContext(records)).not.toBe(hashContext([...records].reverse()));
  });

  it('does not read the wall clock', () => {
    // `now` is an input. A context builder that calls Date.now() cannot be reproduced.
    const source = readFileSync('server/domain/contextBundle.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(source).not.toMatch(/Date\.now\(\)/);
    expect(source).not.toMatch(/new Date\(\)/);
  });
});

describe('§18 — untrusted material is labelled where it is rendered', () => {
  it('marks a model-derived fact as unverified', () => {
    const bundle = buildContextBundle(
      inputs({ facts: [fact({ id: 'f1', sourceType: 'AGENT_SYNTHESIS', derivedFromUntrusted: true })] })
    );
    const record = bundle.records.find((r) => r.id === 'fact:f1');
    expect(record?.untrusted).toBe(true);
    expect(bundle.promptBlock).toContain('not verified');
  });

  it('does NOT mark an operator-entered fact as unverified', () => {
    const bundle = buildContextBundle(
      inputs({ facts: [fact({ id: 'f1', sourceType: 'OPERATOR_ENTRY', derivedFromUntrusted: false })] })
    );
    expect(bundle.records.find((r) => r.id === 'fact:f1')?.untrusted).toBe(false);
  });

  it('marks the inbound message and prospect turns as untrusted', () => {
    const bundle = buildContextBundle(inputs());
    expect(bundle.records.find((r) => r.kind === 'INBOUND_MESSAGE')?.untrusted).toBe(true);
    expect(bundle.records.find((r) => r.id === 'msg:m2')?.untrusted).toBe(false);
    expect(bundle.records.find((r) => r.id === 'msg:m1')?.untrusted).toBe(true);
  });

  it('renders sections in a fixed order regardless of which are present', () => {
    const withAll = renderBundle([
      { id: 'c1', kind: 'COMPANY_FACT', content: 'company', untrusted: false, reason: '' },
      { id: 'm1', kind: 'INBOUND_MESSAGE', content: 'inbound', untrusted: true, reason: '' },
    ]);
    expect(withAll.indexOf('THE MESSAGE YOU ARE REPLYING TO')).toBeLessThan(
      withAll.indexOf('APPROVED COMPANY KNOWLEDGE')
    );
  });
});

describe('§21 — the three unused ledger reads now have somewhere to go', () => {
  it('includes open questions, unresolved objections and outstanding commitments', () => {
    const bundle = buildContextBundle(
      inputs({
        openQuestions: [{ id: 'q1', question: 'Do you integrate with Dentally?' }],
        unresolvedObjections: [{ id: 'o1', objection: 'Too expensive' }],
        outstandingCommitments: [{ id: 'c1', commitment: 'Send the integration guide', dueAt: '2026-09-10' }],
      })
    );
    expect(bundle.contextIds).toContain('question:q1');
    expect(bundle.contextIds).toContain('objection:o1');
    expect(bundle.contextIds).toContain('commitment:c1');
    expect(bundle.promptBlock).toContain('Send the integration guide (due 2026-09-10)');
  });
});

describe('P1.8 — the defects this replaces are gone from the source', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('the ledger call no longer passes an email as a contact id, and no longer swallows failures', () => {
    const source = strip(readFileSync('server/agents/salesDecisionEngine.ts', 'utf8'));
    expect(source).not.toContain('getQuotes(input.identity.email)');
    expect(source).not.toMatch(/catch\s*\(\s*e\s*\)\s*\{\s*\}/);
    // A lookup failure must be recorded, not treated as "no quote".
    expect(source).toContain('quoteLookupFailed');
  });

  it('knownRelevantFacts is no longer a hardcoded pair of sentences', () => {
    const source = strip(readFileSync('server/agents/salesDecisionEngine.ts', 'utf8'));
    expect(source).not.toContain('Abedin Voice AI operates at sub-500ms latency for natural phone conversations');
    expect(source).toContain('input.knownRelevantFacts ?? []');
  });

  it('the COMPOSER actually uses the bundle — the module existing is not the same claim', () => {
    // S18 spent this entire document at NOT_STARTED with a sanitiser already in the repository:
    // the function was there and nothing called it. The same distinction applies here.
    const source = strip(readFileSync('server/agents/multiAgentReplySystem.ts', 'utf8'));
    expect(source).toContain('buildContextBundle({');
    expect(source).toContain('const fullTranscript = contextBundle.promptBlock;');
    // The unbounded concatenation must be gone, not merely unused.
    expect(source).not.toMatch(/thread\s*\n?\s*\.map\([\s\S]{0,400}?\.join\("\\n\\n---\\n\\n"\)/);
  });

  it('the run log can record what the model was shown', () => {
    const schema = readFileSync('server/db/schema.ts', 'utf8');
    for (const column of ['prompt_hash', 'context_hash', 'context_ids', 'prompt_tokens', 'completion_tokens', 'model']) {
      expect(schema, column).toContain(column);
    }
  });
});
