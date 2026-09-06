import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MAX_FACT_VALUE,
  SOURCE_TYPES,
  UNTRUSTED_SOURCES,
  activeFacts,
  authorityOf,
  isAttestedFact,
  planFactWrite,
  validateObservation,
  type FactObservation,
  type StoredFact,
} from '../domain/facts';
import { observationsFromMemory } from '../domain/memoryFacts';
import { factId } from '../lib/factStore';

/**
 * INVARIANTS (addendum §20, §21, §18 / P1.6).
 *
 * §20 A fact is never deleted and never overwritten. History is the product.
 * §21 Every fact names where it came from and when it was observed.
 * §18 A model's summary of an untrusted email must not acquire the standing of a record we
 *     hold, because these facts are read back into later prompts.
 */

const CONTEXT = { organizationId: 'org1', conversationId: 'conv1' };

function storedFact(overrides: Partial<StoredFact> = {}): StoredFact {
  return {
    id: 'ft_existing',
    organizationId: 'org1',
    conversationId: 'conv1',
    key: 'budget',
    value: '5000',
    sourceType: 'CUSTOMER_ASSERTION',
    sourceMessageId: 'msg_1',
    confidence: null,
    observedAt: '2026-01-01T00:00:00.000Z',
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    supersededBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastVerifiedAt: '2026-01-01T00:00:00.000Z',
    observationCount: 1,
    derivedFromUntrusted: true,
    ...overrides,
  };
}

const observation = (overrides: Partial<FactObservation> = {}): FactObservation => ({
  key: 'budget',
  value: '15000',
  sourceType: 'CUSTOMER_ASSERTION',
  sourceMessageId: 'msg_2',
  ...overrides,
});

describe('§20 — a fact is superseded, never deleted and never overwritten', () => {
  it('SUPERSEDES rather than replacing when the value changes', () => {
    const plan = planFactWrite(storedFact(), observation(), { ...CONTEXT, nextId: 'ft_new' });
    expect(plan.ok).toBe(true);
    if (plan.ok === false || plan.action !== 'SUPERSEDE') throw new Error('expected SUPERSEDE');

    // The old fact is CLOSED, not removed: it gets an end date and a pointer to its successor.
    expect(plan.supersededId).toBe('ft_existing');
    expect(plan.supersededPatch.validUntil).toBeTruthy();
    expect(plan.supersededPatch.supersededBy).toBe('ft_new');
    // Nothing in the patch deletes anything.
    expect(Object.values(plan.supersededPatch)).not.toContain(null);
    expect(plan.insert.value).toBe('15000');
    expect(plan.insert.validUntil).toBeNull();
  });

  it('CONFIRMS rather than duplicating when the same value is seen again', () => {
    // Writing a second row would make the history say the customer changed their mind when
    // they simply repeated themselves.
    const plan = planFactWrite(storedFact(), observation({ value: '5000' }), CONTEXT);
    expect(plan.ok).toBe(true);
    if (plan.ok === false || plan.action !== 'CONFIRM') throw new Error('expected CONFIRM');
    expect(plan.factId).toBe('ft_existing');
    expect(plan.patch.observationCount).toBe(2);
    expect(plan.patch.lastVerifiedAt).toBeTruthy();
  });

  it('CREATES when nothing is on record for the key', () => {
    const plan = planFactWrite(null, observation(), CONTEXT);
    expect(plan.ok && plan.action).toBe('CREATE');
  });

  it('treats a fact with a validUntil as history, not as current', () => {
    const facts = [
      storedFact({ id: 'a', validUntil: '2026-02-01T00:00:00.000Z' }),
      storedFact({ id: 'b', observedAt: '2026-03-01T00:00:00.000Z' }),
    ];
    expect(activeFacts(facts).map((f) => f.id)).toEqual(['b']);
  });

  it('orders active facts newest first', () => {
    const facts = [
      storedFact({ id: 'old', observedAt: '2026-01-01T00:00:00.000Z' }),
      storedFact({ id: 'new', observedAt: '2026-06-01T00:00:00.000Z' }),
    ];
    expect(activeFacts(facts).map((f) => f.id)).toEqual(['new', 'old']);
  });
});

describe('§21 — a fact that cannot say where it came from is not stored', () => {
  it('REFUSES an unattributed claim about a customer', () => {
    for (const sourceType of [...UNTRUSTED_SOURCES]) {
      const rejection = validateObservation(observation({ sourceType, sourceMessageId: undefined }));
      expect(rejection?.code, sourceType).toBe('UNATTRIBUTED');
    }
  });

  it('allows an operator entry with no source message', () => {
    // A person typing into the CRM is the source; there is no message to name.
    expect(
      validateObservation(observation({ sourceType: 'OPERATOR_ENTRY', sourceMessageId: undefined }))
    ).toBeNull();
  });

  it('REFUSES a fact with no key, no value, or an unknown source type', () => {
    expect(validateObservation(observation({ key: '  ' }))?.code).toBe('MISSING_KEY');
    expect(validateObservation(observation({ value: '' }))?.code).toBe('MISSING_VALUE');
    expect(
      validateObservation(observation({ sourceType: 'TRUST_ME' as never }))?.code
    ).toBe('UNKNOWN_SOURCE_TYPE');
  });

  it('REFUSES an oversized value rather than writing an unbounded document', () => {
    expect(validateObservation(observation({ value: 'x'.repeat(MAX_FACT_VALUE + 1) }))?.code).toBe(
      'TOO_LONG'
    );
  });

  it('REFUSES a confidence that is not a number from 0 to 100', () => {
    for (const bad of [-1, 101, NaN, Infinity, '90' as never]) {
      expect(validateObservation(observation({ confidence: bad as number }))?.code, String(bad)).toBe(
        'INVALID_CONFIDENCE'
      );
    }
    // Null is legitimate and distinct from zero: nothing computed one.
    expect(validateObservation(observation({ confidence: null }))).toBeNull();
  });

  it('never invents a confidence when none was computed', () => {
    const plan = planFactWrite(null, observation({ confidence: undefined }), CONTEXT);
    expect(plan.ok && plan.action === 'CREATE' && plan.insert.confidence).toBeNull();
  });

  it('records observedAt distinctly from createdAt', () => {
    const plan = planFactWrite(
      null,
      observation({ observedAt: '2025-12-25T00:00:00.000Z' }),
      { ...CONTEXT, now: '2026-09-06T00:00:00.000Z' }
    );
    expect(plan.ok).toBe(true);
    if (plan.ok === false || plan.action !== 'CREATE') throw new Error('expected CREATE');
    expect(plan.insert.observedAt).toBe('2025-12-25T00:00:00.000Z');
    expect(plan.insert.validFrom).toBe('2025-12-25T00:00:00.000Z');
    expect(plan.insert.createdAt).toBe('2026-09-06T00:00:00.000Z');
  });
});

describe('§18 — provenance is a TIER, and a model summary cannot outrank a record', () => {
  it('orders the tiers with agent synthesis lowest and operator entry highest', () => {
    expect(authorityOf('AGENT_SYNTHESIS')).toBeLessThan(authorityOf('CUSTOMER_ASSERTION'));
    expect(authorityOf('CUSTOMER_ASSERTION')).toBeLessThan(authorityOf('OPERATOR_ENTRY'));
    expect(authorityOf('PROVIDER_RECORD')).toBeLessThan(authorityOf('OPERATOR_ENTRY'));
  });

  it('REFUSES to let a model summary supersede an operator entry', () => {
    // This is the injected-correction case: text in an inbound email becomes a "fact" that
    // rewrites what a person on our side recorded.
    const current = storedFact({ sourceType: 'OPERATOR_ENTRY', derivedFromUntrusted: false });
    const plan = planFactWrite(current, observation({ sourceType: 'AGENT_SYNTHESIS' }), CONTEXT);
    expect(plan.ok).toBe(false);
    if (plan.ok !== false) return;
    expect(plan.rejection.code).toBe('LOWER_AUTHORITY');
  });

  it('REFUSES to let a model summary supersede a provider record', () => {
    const current = storedFact({ sourceType: 'PROVIDER_RECORD', derivedFromUntrusted: false });
    const plan = planFactWrite(current, observation({ sourceType: 'AGENT_SYNTHESIS' }), CONTEXT);
    expect(plan.ok).toBe(false);
  });

  it('ALLOWS an equal or higher tier to supersede', () => {
    const current = storedFact({ sourceType: 'CUSTOMER_ASSERTION' });
    expect(planFactWrite(current, observation({ sourceType: 'CUSTOMER_ASSERTION' }), CONTEXT).ok).toBe(true);
    expect(
      planFactWrite(current, observation({ sourceType: 'OPERATOR_ENTRY', sourceMessageId: null }), CONTEXT).ok
    ).toBe(true);
  });

  it('PROPAGATES untrusted origin, because a hop does not restore authority', () => {
    const plan = planFactWrite(
      null,
      observation({ sourceType: 'SYSTEM_DERIVED', derivedFromUntrusted: true }),
      CONTEXT
    );
    expect(plan.ok).toBe(true);
    if (plan.ok === false || plan.action !== 'CREATE') throw new Error('expected CREATE');
    expect(plan.insert.derivedFromUntrusted).toBe(true);
    expect(isAttestedFact(plan.insert)).toBe(false);
  });

  it('marks every untrusted-source fact as underived from anything attested', () => {
    for (const sourceType of SOURCE_TYPES) {
      const plan = planFactWrite(null, observation({ sourceType, sourceMessageId: 'msg_1' }), CONTEXT);
      if (plan.ok === false || plan.action !== 'CREATE') continue;
      expect(plan.insert.derivedFromUntrusted, sourceType).toBe(UNTRUSTED_SOURCES.has(sourceType));
    }
  });

  it('upgrades standing when a MORE authoritative source repeats the same claim', () => {
    const current = storedFact({ sourceType: 'AGENT_SYNTHESIS', derivedFromUntrusted: true });
    const plan = planFactWrite(
      current,
      observation({ value: current.value, sourceType: 'OPERATOR_ENTRY', sourceMessageId: null }),
      CONTEXT
    );
    expect(plan.ok).toBe(true);
    if (plan.ok === false || plan.action !== 'CONFIRM') throw new Error('expected CONFIRM');
    expect(plan.patch.sourceType).toBe('OPERATOR_ENTRY');
    expect(plan.patch.derivedFromUntrusted).toBe(false);
  });
});

describe('P1.6 — the ConversationMemory crash, and what replaces it', () => {
  it('does not read a member the type does not have', () => {
    // The pipeline iterated `(memory as any).facts`. ConversationMemory has no `facts` member,
    // so the loop threw on undefined — AFTER the delete above it had already run.
    const source = readFileSync('shared/domain/models.ts', 'utf8');
    const declaration = source.slice(source.indexOf('export interface ConversationMemory'));
    const body = declaration.slice(0, declaration.indexOf('}'));
    expect(body).not.toMatch(/^\s*facts\s*[?:]/m);

    // Comments are stripped first: the replacement documents the old code by quoting it, and
    // a check that cannot tell a call site from a description of one is not a check.
    const pipeline = readFileSync('server/services/inboundPipeline.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(pipeline).not.toContain('(memory as any).facts');
    expect(pipeline).not.toContain('.delete(conversationFacts)');
    // And the replacement is actually wired, not merely absent. Matched loosely on the two
    // arguments that carry the meaning — the memory and the message it came from — rather than
    // on the exact call text, which broke when a third (options) argument was added and said
    // nothing about whether the wiring was still correct.
    expect(pipeline).toMatch(/observationsFromMemory\(memory,\s*messageId\b/);
    expect(pipeline).toContain('recordFacts(organizationId, conversationId, observations)');
  });

  it('survives a memory object with every field missing', () => {
    expect(observationsFromMemory({}, 'msg_1')).toEqual([]);
    expect(observationsFromMemory(null, 'msg_1')).toEqual([]);
    expect(observationsFromMemory(undefined, 'msg_1')).toEqual([]);
    expect(observationsFromMemory('nonsense', 'msg_1')).toEqual([]);
    expect(observationsFromMemory({ keyPainPoints: 'not-an-array' }, 'msg_1')).toEqual([]);
  });

  it('derives attributed observations from the fields the type actually has', () => {
    const observations = observationsFromMemory(
      {
        keyPainPoints: ['Manual double-entry', 'Manual double-entry', '  '],
        mentionedPreferences: ['Live demo'],
        prospectSentiment: 'EVALUATING',
        keyFactsExtracted: { 'Renewal Date': '2026-11-01', 'Head count': '40' },
        threadSummaryChronological: ['Asked about pricing'],
      },
      'msg_42'
    );

    const keys = observations.map((o) => o.key);
    expect(keys).toContain('pain_points');
    expect(keys).toContain('stated_preferences');
    expect(keys).toContain('prospect_sentiment');
    expect(keys).toContain('extracted.renewal_date');
    expect(keys).toContain('extracted.head_count');
    expect(keys).toContain('thread_summary');

    // Every one is attributed, lowest-tier, and marked untrusted.
    for (const o of observations) {
      expect(o.sourceMessageId).toBe('msg_42');
      expect(o.sourceType).toBe('AGENT_SYNTHESIS');
      expect(o.derivedFromUntrusted).toBe(true);
      expect(o.confidence).toBeNull();
      expect(validateObservation(o)).toBeNull();
    }
  });

  it('de-duplicates a list so a repeat is a confirmation, not a change', () => {
    const [painPoints] = observationsFromMemory({ keyPainPoints: ['A', 'A', 'B'] }, 'm1');
    expect(painPoints.value).toBe(JSON.stringify(['A', 'B']));
  });

  it('makes a list ONE fact, so supersession has a stable key', () => {
    // "Pain point #2" is not a stable key: the model may reorder, and the second element
    // changing would read as the customer changing their mind about something they never said.
    const observations = observationsFromMemory({ keyPainPoints: ['A', 'B', 'C'] }, 'm1');
    expect(observations.filter((o) => o.key === 'pain_points')).toHaveLength(1);
  });
});

describe('P1.6 — reprocessing the same message is idempotent', () => {
  it('derives the same fact id for the same observation', () => {
    // The pipeline can be retried — a provider redelivery, a worker restart mid-run. A random
    // id would turn each retry into a fresh "the customer changed their mind" entry.
    const a = factId('conv1', 'budget', 'msg_1', '5000');
    const b = factId('conv1', 'budget', 'msg_1', '5000');
    expect(a).toBe(b);
    expect(a).toMatch(/^ft_[0-9a-f]{32}$/);
  });

  it('derives a different id for a different value from the same message', () => {
    expect(factId('conv1', 'budget', 'msg_1', '5000')).not.toBe(
      factId('conv1', 'budget', 'msg_1', '9000')
    );
  });

  it('derives a different id per conversation, key and source message', () => {
    const base = factId('conv1', 'budget', 'msg_1', '5000');
    expect(factId('conv2', 'budget', 'msg_1', '5000')).not.toBe(base);
    expect(factId('conv1', 'headcount', 'msg_1', '5000')).not.toBe(base);
    expect(factId('conv1', 'budget', 'msg_2', '5000')).not.toBe(base);
  });
});
