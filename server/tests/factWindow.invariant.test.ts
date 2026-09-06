import { describe, it, expect } from 'vitest';
import { observationsFromMemory } from '../domain/memoryFacts';
import { activeFacts, planFactWrite, type StoredFact } from '../domain/facts';
import { exceededCap, MAX_FACTS_PER_CONVERSATION } from '../lib/factStore';

/**
 * Two ways the fact history could be corrupted without anything reporting it.
 *
 * Both were found by an adversarial investigation of the P1.6/P1.8 fact path and confirmed
 * against the tree. Neither had a test, and neither would have been visible in a log.
 */

// ===========================================================================
describe('1. an extracted-key collision does not fabricate a supersession', () => {
  /**
   * `rawKey.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')` maps "Head count", "Head-count"
   * and "head.count" onto `head_count`. `recordFacts` then processes the batch SEQUENTIALLY and
   * deliberately, so two observations of the same key supersede in order.
   *
   * Two correct decisions, one wrong result: a single message would record a fact and then
   * immediately supersede it, writing a `validUntil` and a supersession pointer, with both
   * observations carrying the same `sourceMessageId`. The history would read as the customer
   * changing their position mid-message.
   */

  const keysOf = (obs: { key: string }[]) => obs.map((o) => o.key);

  it('two raw keys that collapse with DIFFERENT values record nothing for that key', () => {
    const rejected: { key: string; rawKeys: string[]; reason: string }[] = [];
    const observations = observationsFromMemory(
      { keyFactsExtracted: { 'Head count': '40', 'head-count': '50' } },
      'msg_1',
      { onRejected: (r) => rejected.push(r) }
    );

    expect(keysOf(observations)).not.toContain('extracted.head_count');
    expect(observations).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].key).toBe('extracted.head_count');
    expect(rejected[0].rawKeys.sort()).toEqual(['Head count', 'head-count']);
  });

  it('the rejection names both raw keys and says why, rather than logging a count', () => {
    const rejected: { key: string; rawKeys: string[]; reason: string }[] = [];
    observationsFromMemory(
      { keyFactsExtracted: { 'Renewal Date': '2026-01-01', 'renewal.date': '2027-06-30' } },
      'msg_1',
      { onRejected: (r) => rejected.push(r) }
    );
    expect(rejected[0].reason).toContain('supersession');
    expect(rejected[0].reason).toMatch(/2 extracted keys/);
  });

  it('two raw keys that collapse with the SAME value collapse to one observation', () => {
    // A duplicate is harmless — it is not two readings that disagree. Dropping it would lose a
    // fact the model did extract.
    const rejected: unknown[] = [];
    const observations = observationsFromMemory(
      { keyFactsExtracted: { 'Head count': '40', 'head-count': '40' } },
      'msg_1',
      { onRejected: (r) => rejected.push(r) }
    );
    expect(keysOf(observations)).toEqual(['extracted.head_count']);
    expect(observations[0].value).toBe('40');
    expect(rejected).toHaveLength(0);
  });

  it('a collision does not discard the well-formed keys beside it', () => {
    const observations = observationsFromMemory(
      {
        keyFactsExtracted: {
          'Head count': '40',
          'head-count': '50',
          budget: '15000',
          'Decision Maker': 'Alice',
        },
      },
      'msg_1'
    );
    expect(keysOf(observations).sort()).toEqual(['extracted.budget', 'extracted.decision_maker']);
  });

  it('normal single keys are completely unaffected', () => {
    const observations = observationsFromMemory(
      { keyFactsExtracted: { 'Head count': '40', budget: '15000' } },
      'msg_1'
    );
    expect(keysOf(observations).sort()).toEqual(['extracted.budget', 'extracted.head_count']);
  });

  it('onRejected is optional — omitting it must not throw', () => {
    expect(() =>
      observationsFromMemory({ keyFactsExtracted: { 'A b': '1', 'a-b': '2' } }, 'msg_1')
    ).not.toThrow();
  });

  it('an empty value is dropped before collision detection, not counted as a disagreement', () => {
    const rejected: unknown[] = [];
    const observations = observationsFromMemory(
      { keyFactsExtracted: { 'Head count': '40', 'head-count': '   ' } },
      'msg_1',
      { onRejected: (r) => rejected.push(r) }
    );
    expect(rejected).toHaveLength(0);
    expect(keysOf(observations)).toEqual(['extracted.head_count']);
    expect(observations[0].value).toBe('40');
  });
});

// ===========================================================================
describe('2. a partial fact window cannot be read as "this key has no fact"', () => {
  /**
   * `listFacts` capped at 500 documents with NO ordering, so the window was sliced by
   * Firestore's implicit `__name__` order — and ids are `ft_` + a sha256 prefix, uncorrelated
   * with time. `recordFact` finds the fact to supersede from exactly that list, so an active
   * fact outside the window yielded CREATE and a second active document for the same key, the
   * first never given `validUntil` or `supersededBy`.
   *
   * The store itself needs Firestore, so these assert the DECISION the store makes with the
   * truncation flag, plus the domain rule the flag protects.
   */

  const storedFact = (over: Partial<StoredFact> = {}): StoredFact =>
    ({
      id: 'ft_existing',
      organizationId: 'org_1',
      conversationId: 'conv_1',
      key: 'head_count',
      value: '40',
      sourceType: 'AGENT_SYNTHESIS',
      sourceMessageId: 'msg_0',
      confidence: null,
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: null,
      supersededBy: null,
      observedAt: '2026-01-01T00:00:00.000Z',
      derivedFromUntrusted: true,
      ...over,
    }) as StoredFact;

  it('THE DOMAIN RULE: with no current fact, the plan is CREATE', () => {
    // This is why a partial window is dangerous rather than merely stale — the store cannot
    // tell "no active fact" from "I did not load it", and this is what it does with the answer.
    const plan = planFactWrite(
      null,
      {
        key: 'head_count',
        value: '50',
        sourceType: 'AGENT_SYNTHESIS',
        sourceMessageId: 'msg_1',
        confidence: null,
        derivedFromUntrusted: true,
      },
      { organizationId: 'org_1', conversationId: 'conv_1', nextId: 'ft_new' }
    );
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.action).toBe('CREATE');
  });

  it('...and with the current fact present it supersedes instead', () => {
    const plan = planFactWrite(
      storedFact(),
      {
        key: 'head_count',
        value: '50',
        sourceType: 'AGENT_SYNTHESIS',
        sourceMessageId: 'msg_1',
        confidence: null,
        derivedFromUntrusted: true,
      },
      { organizationId: 'org_1', conversationId: 'conv_1', nextId: 'ft_new' }
    );
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.action).toBe('SUPERSEDE');
  });

  it('two active facts for one key is the corruption being prevented', () => {
    // What the store would hold if CREATE ran while an active fact existed outside the window.
    const forked = [
      storedFact({ id: 'ft_a', value: '40' }),
      storedFact({ id: 'ft_b', value: '50', validFrom: '2026-02-01T00:00:00.000Z' }),
    ];
    const active = activeFacts(forked);
    expect(active).toHaveLength(2);
    expect(active.map((f) => f.value).sort()).toEqual(['40', '50']);
    // Both would render into one prompt as simultaneously in force.
  });

  it('the store refuses that write instead, and the refusal names the cause', () => {
    const source = readStoreSource();
    expect(source).toMatch(/if \(current === null && truncated\)/);
    expect(source).toContain("code: 'HISTORY_TRUNCATED'");
    // Scoped: a found fact must still supersede, so a long conversation keeps working.
    expect(source).not.toMatch(/if \(truncated\) \{\s*return \{\s*ok: false/);
  });

  it('the window is fetched with one MORE than the cap, so exceeding it is observable', () => {
    const source = readStoreSource();
    expect(source).toContain('fsLimit(MAX_FACTS_PER_CONVERSATION + 1)');
    expect(source).not.toMatch(/fsLimit\(MAX_FACTS_PER_CONVERSATION\)/);
  });

  it('recordFact reads the page, not the flag-less list', () => {
    const source = readStoreSource();
    expect(source).toMatch(/const \{ facts: existing, truncated \} = await listFactPage\(/);
  });

  it('the cap is a real number, so the truncation branch is reachable', () => {
    expect(MAX_FACTS_PER_CONVERSATION).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_FACTS_PER_CONVERSATION)).toBe(true);
  });

  it('THE FLAG ITSELF: loading more than the cap is truncated, exactly at the cap is not', () => {
    // Added because `const truncated = false` survived the whole suite. Asserting the fetch
    // limit and the branch proved nothing about the value that reaches the branch.
    expect(exceededCap(MAX_FACTS_PER_CONVERSATION + 1)).toBe(true);
    expect(exceededCap(MAX_FACTS_PER_CONVERSATION)).toBe(false);
    expect(exceededCap(MAX_FACTS_PER_CONVERSATION - 1)).toBe(false);
    expect(exceededCap(0)).toBe(false);
  });

  it('the flag is not constant in either direction', () => {
    // Catches both `return false` and `return true` — one disables the control, the other
    // blocks every first write to a conversation.
    expect(new Set([exceededCap(0), exceededCap(MAX_FACTS_PER_CONVERSATION + 1)]).size).toBe(2);
  });

  it('listFactPage derives its flag from that function, not an inline comparison', () => {
    expect(readStoreSource()).toContain('const truncated = exceededCap(facts.length);');
  });

  it('the false docstring is gone', () => {
    // It said "beyond this the oldest are not loaded". The window is unordered; which facts
    // fall outside it is decided by a hash.
    const raw = readStoreSource({ comments: true });
    expect(raw).not.toContain('beyond this the oldest are not loaded');
  });
});

function readStoreSource(options: { comments?: boolean } = {}): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('node:fs');
  const raw = readFileSync('server/lib/factStore.ts', 'utf8') as string;
  if (options.comments) return raw;
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
