import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildContextBundle, hashContext, type ContextKind } from '../domain/contextBundle';
import type { StoredFact } from '../domain/facts';

/**
 * S21 — one drafting path.
 *
 * `buildContextBundle`, `pricingContextFor` and `nextBusinessSlot` were each built by a
 * separate hardening pass (P1.8, P1.7, P1.9) and each wired into
 * `executeMultiAgentReplyPipeline` — a function with two occurrences in the repository, its own
 * definition and an unused import. Three capabilities the repository contained and the running
 * system did not have.
 */

const NOW = '2026-09-07T12:00:00.000Z';

const fact = (over: Partial<StoredFact> = {}): StoredFact =>
  ({
    id: 'ft_1',
    organizationId: 'org_1',
    conversationId: 'conv_1',
    key: 'head_count',
    value: '40',
    sourceType: 'AGENT_SYNTHESIS',
    sourceMessageId: 'msg_1',
    confidence: null,
    validFrom: '2026-09-01T00:00:00.000Z',
    validUntil: null,
    supersededBy: null,
    observedAt: '2026-09-01T00:00:00.000Z',
    derivedFromUntrusted: true,
    ...over,
  }) as StoredFact;

const inputs = (over: Partial<Parameters<typeof buildContextBundle>[0]> = {}) => ({
  thread: [
    {
      id: 'msg_1',
      sender: 'PROSPECT' as const,
      subject: 'Pricing',
      bodyText: 'What does it cost?',
      sentAt: '2026-09-07T11:00:00.000Z',
    },
  ],
  facts: [fact()],
  openQuestions: [],
  unresolvedObjections: [],
  outstandingCommitments: [],
  quotes: [],
  companyFacts: [],
  now: NOW,
  ...over,
});

// ===========================================================================
describe('an unreadable source is not an empty one (§14)', () => {
  /**
   * Every input to the bundle is an array, and an empty array says "there are none". With
   * three of the five stores behind an unreachable database, that is the wrong answer far more
   * often than the right one — and "this customer has raised no objections" reads identically
   * to "the objections table threw".
   */

  it('the bundle reports which sources could not be read', () => {
    const bundle = buildContextBundle(inputs({ unavailable: ['OPEN_QUESTION', 'QUOTE'] }));
    expect(bundle.unavailable).toEqual(['OPEN_QUESTION', 'QUOTE']);
  });

  it('a bundle with everything available reports nothing unavailable', () => {
    expect(buildContextBundle(inputs()).unavailable).toEqual([]);
  });

  it('the list is deduplicated and ordered, so it is a set and not a log', () => {
    const bundle = buildContextBundle(
      inputs({ unavailable: ['QUOTE', 'FACT', 'QUOTE', 'OPEN_QUESTION'] })
    );
    expect(bundle.unavailable).toEqual(['FACT', 'OPEN_QUESTION', 'QUOTE']);
  });

  it('THE HASH DISTINGUISHES THEM — same records, different availability, different hash', () => {
    // The whole point. Two runs that select the same records and render the same prompt block
    // are not the same context if one of them could not read a store, and §21 asks the hash
    // exactly one question: "was this the same context?"
    const available = buildContextBundle(inputs());
    const degraded = buildContextBundle(inputs({ unavailable: ['UNRESOLVED_OBJECTION'] }));

    expect(degraded.promptBlock).toBe(available.promptBlock);
    expect(degraded.contextIds).toEqual(available.contextIds);
    expect(degraded.contextHash).not.toBe(available.contextHash);
  });

  it('the hash is stable for the same availability, whatever order it is given in', () => {
    const a = buildContextBundle(inputs({ unavailable: ['QUOTE', 'FACT'] }));
    const b = buildContextBundle(inputs({ unavailable: ['FACT', 'QUOTE'] }));
    expect(a.contextHash).toBe(b.contextHash);
  });

  it('hashContext defaults to "nothing unavailable" rather than throwing', () => {
    const records = buildContextBundle(inputs()).records;
    expect(hashContext(records)).toBe(hashContext(records, []));
    expect(hashContext(records)).not.toBe(hashContext(records, ['FACT']));
  });

  it('unavailability does not smuggle records into the prompt', () => {
    // It is metadata about what could not be read, not content. A model must not be given
    // our infrastructure state to reason about.
    const bundle = buildContextBundle(inputs({ unavailable: ['QUOTE'] }));
    expect(bundle.promptBlock).not.toContain('QUOTE');
    expect(bundle.promptBlock).not.toContain('unavailable');
  });
});

// ===========================================================================
describe('the live pipeline builds the bundle from real sources', () => {
  const pipeline = stripped('server/services/inboundPipeline.ts');

  it('facts, questions and objections all reach one bundle', () => {
    expect(pipeline).toContain('buildContextBundle({');
    expect(pipeline).toContain('facts: activeFactRecords,');
    expect(pipeline).toContain('openQuestions: adapted.openQuestions,');
    expect(pipeline).toContain('unresolvedObjections: adapted.unresolvedObjections,');
  });

  it('each source that throws is recorded as unavailable, not skipped', () => {
    for (const kind of ['FACT', 'OPEN_QUESTION', 'UNRESOLVED_OBJECTION']) {
      expect(pipeline, kind).toContain(`noteUnavailable('${kind}'`);
    }
    expect(pipeline).toContain('unavailable.push(kind)');
  });

  it('sources with no reader at all are declared unavailable rather than passed as empty', () => {
    // Commitments, quotes and company facts have no reachable reader on this path. Passing
    // `[]` for them would claim "there are none".
    expect(pipeline).toMatch(/unavailable: \[\.\.\.unavailable, 'OUTSTANDING_COMMITMENT', 'QUOTE', 'COMPANY_FACT'\]/);
  });

  it('ledger rows go through the adapter, which had zero callers', () => {
    // The tables name their columns `questionText` and `statement`; the bundle needs `question`
    // and `objection`. `adaptLedgers` also re-checks the tenant and drops superseded rows.
    expect(pipeline).toContain('adaptLedgers(');
    expect(pipeline).toContain('adapted.rejected.length > 0');
  });

  it('the bundle is passed to the planner, not built and discarded', () => {
    expect(pipeline).toMatch(/contextBundle,\s*\n\s*\}\);/);
  });
});

// ===========================================================================
describe('the manifest reaches the run log (§21)', () => {
  const pipeline = stripped('server/services/inboundPipeline.ts');
  const runLog = stripped('server/lib/runLog.ts');

  it('every successful outcome carries the hash and the manifest', () => {
    const carrying = pipeline.match(/contextHash: contextBundle\.contextHash/g) ?? [];
    // QUEUED, SUPPRESSED (post-compose) and BLOCKED all reach it.
    expect(carrying.length).toBeGreaterThanOrEqual(3);
  });

  it('the run log records both, and null when no bundle was built', () => {
    expect(runLog).toContain('contextHash: input.contextHash ?? null,');
    expect(runLog).toContain('contextIds: input.contextIds ?? null,');
  });

  it('the pipeline PASSES the outcome hash through, rather than hardcoding null', () => {
    // The chain has three links — bundle to outcome, outcome to writeRunLog, writeRunLog to
    // row — and asserting the first and third leaves the middle free to be `null`. Mutating
    // exactly that survived the rest of this suite.
    const writeCall = pipeline.slice(pipeline.indexOf('await writeRunLog('));
    const args = writeCall.slice(0, writeCall.indexOf('});'));
    expect(args).toContain('contextHash: outcome.contextHash ?? null,');
    expect(args).toContain('contextIds: outcome.contextIds ?? null,');
    expect(args).not.toMatch(/contextHash: null,/);
  });

  it('the fields the writer fills exist on the row it writes', () => {
    // A document row, not the relational table (dropped by 0008 — it never had a writer).
    const row = readFileSync('shared/domain/models.ts', 'utf8');
    const start = row.indexOf('export interface AIRunLog {');
    const shape = row.slice(start, row.indexOf('\n}\n', start));
    const writer = readFileSync('server/lib/runLog.ts', 'utf8');
    for (const field of ['contextHash', 'contextIds', 'promptHashes', 'models']) {
      expect(shape, field).toContain(`${field}?:`);
      expect(writer, field).toMatch(new RegExp(`^\\s+${field}: `, 'm'));
    }
  });
});

// ===========================================================================
describe('the dead composer is gone, and what it held has moved', () => {
  const composer = readFileSync('server/agents/multiAgentReplySystem.ts', 'utf8');
  const planner = stripped('server/agents/salesDecisionEngine.ts');

  it('the function with two occurrences in the repository has none', () => {
    expect(composer).not.toContain('export async function executeMultiAgentReplyPipeline');
    expect(readFileSync('server.ts', 'utf8')).not.toContain('executeMultiAgentReplyPipeline');
  });

  it('the validators it shared a file with are untouched — six other callers use them', () => {
    expect(composer).toContain('export function validateAndEnforceNoPhonePolicy');
    expect(composer).toContain('export function validateAndEnforceMeetingAndCalendarLinks');
    expect(composer).toContain('export function sanitizeZeroPhoneNumbers');
  });

  it('P1.7 pricing precedence now applies on the path that runs', () => {
    expect(planner).toContain('pricingContextFor(input.activeQuote ?? null, nowIso)');
    expect(planner).toContain('${pricingContext.promptBlock}');
  });

  it('P1.8 context selection now applies on the path that runs', () => {
    expect(planner).toContain('contextBundle?: ContextBundle');
    expect(planner).toContain('${contextBlock}');
  });

  it('list pricing is withheld, not merely deprioritised', () => {
    // Withholding means the model cannot see it. Emitting CANONICAL_KNOWLEDGE whole alongside
    // the decided block would defeat the mechanism entirely.
    expect(planner).toContain('{ ...CANONICAL_KNOWLEDGE, pricing: undefined }');
    expect(planner).not.toContain('${JSON.stringify(CANONICAL_KNOWLEDGE)}');
  });

  it('the plan takes its facts from the bundle, so there is one answer not two', () => {
    expect(planner).toMatch(/input\.contextBundle\s*\n?\s*\?\s*input\.contextBundle\.records\.filter\(\(r\) => r\.kind === 'FACT'\)/);
  });
});

function stripped(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}
