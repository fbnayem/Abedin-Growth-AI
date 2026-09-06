import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BudgetTracker, defaultWorkflowBudget } from '../policies/workflowBudgets';
import {
  isCollecting,
  readUsage,
  reportModelCall,
  withModelCallCollector,
  type ModelCallRecord,
} from '../lib/modelCallLog';

/**
 * Four places the system reported health it had never measured.
 *
 * A fabricated cost, a failover nobody recorded, a catch that turned a dropped customer email
 * into a 200 OK, and a log endpoint ordering by a field its own log shape does not have.
 */

const call = (over: Partial<ModelCallRecord> = {}): ModelCallRecord => ({
  agentName: 'test-agent',
  category: 'SMART',
  model: 'gemini-3.1-pro-preview',
  outcome: 'ANSWERED',
  attempts: 1,
  promptTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  durationMs: 12,
  failures: [],
  ...over,
});

// ===========================================================================
describe('1. the budget counts what was spent, not a literal', () => {
  it('an unmeasured call is unmeasured, NOT zero', () => {
    const tracker = new BudgetTracker();
    tracker.recordModelCall(null);
    const s = tracker.snapshot();
    expect(s.modelCalls).toBe(1);
    expect(s.unmeasuredCalls).toBe(1);
    expect(s.tokensArePartial).toBe(true);
    // The token total is a lower bound and says so, rather than reading as "cost nothing".
    expect(s.tokens).toBe(0);
  });

  it('a measured call contributes its real tokens and is not partial', () => {
    const tracker = new BudgetTracker();
    tracker.recordModelCall(1200);
    const s = tracker.snapshot();
    expect(s.tokens).toBe(1200);
    expect(s.unmeasuredCalls).toBe(0);
    expect(s.tokensArePartial).toBe(false);
  });

  it('a mixed run reports a partial total, so it cannot be read as complete', () => {
    const tracker = new BudgetTracker();
    tracker.recordModelCall(1000);
    tracker.recordModelCall(null);
    const s = tracker.snapshot();
    expect(s.tokens).toBe(1000);
    expect(s.tokensArePartial).toBe(true);
    expect(s.unmeasuredCalls).toBe(1);
  });

  it('rubbish is treated as unmeasured rather than coerced to a number', () => {
    // A raised call ceiling, because the real one is 3 and would trip first — which is itself
    // the point of the test below it.
    const tracker = new BudgetTracker({ ...defaultWorkflowBudget, maxModelCallsPerReply: 1000 });
    for (const bad of [NaN, -1, Infinity, undefined as any]) tracker.recordModelCall(bad);
    const s = tracker.snapshot();
    expect(s.unmeasuredCalls).toBe(4);
    expect(s.tokens).toBe(0);
  });

  it('THE REGRESSION: real usage can now exceed the token ceiling', () => {
    // The fabricated `recordModelCall(500, 0.01)` meant 3 calls x 500 tokens could never reach
    // 8000, so no amount of real spending could trip this. One honest call now can.
    const tracker = new BudgetTracker();
    expect(() => tracker.recordModelCall(defaultWorkflowBudget.maxTokensPerReplyWorkflow + 1)).toThrow(
      /BUDGET_EXCEEDED: maxTokensPerReplyWorkflow/
    );
  });

  it('the model-call ceiling still binds, and binds on a real count', () => {
    const tracker = new BudgetTracker();
    expect(() => {
      for (let i = 0; i <= defaultWorkflowBudget.maxModelCallsPerReply; i++) {
        tracker.recordModelCall(null);
      }
    }).toThrow(/BUDGET_EXCEEDED: maxModelCallsPerReply/);
  });

  it('unmeasured calls cannot silently push the TOKEN ceiling over', () => {
    // The other direction: an unknown must not be inflated into a breach either.
    const tracker = new BudgetTracker({ ...defaultWorkflowBudget, maxModelCallsPerReply: 1000 });
    expect(() => {
      for (let i = 0; i < 50; i++) tracker.recordModelCall(null);
    }).not.toThrow();
    expect(tracker.snapshot().tokens).toBe(0);
  });

  it('the cost ceiling states that it is NOT enforced, instead of reading zero forever', () => {
    // §2: converting tokens to pounds needs a per-model price table that does not exist here.
    // Silence would look like "nothing was spent"; the fabricated £0.01 was the same lie.
    const s = new BudgetTracker().snapshot();
    expect(s.costEnforcement).toBeTruthy();
    expect(s.costEnforcement).toContain('NOT enforced');
    expect(s).not.toHaveProperty('cost');
  });

  it('the fabricated constants are gone from the pipeline', () => {
    const pipeline = stripped('server/services/inboundPipeline.ts');
    expect(pipeline).not.toContain('recordModelCall(500, 0.01)');
    expect(pipeline).not.toMatch(/recordModelCall\(\s*\d/);
  });
});

// ===========================================================================
describe('2. which model answered is recorded', () => {
  it('a collector receives the model that answered', async () => {
    const seen: ModelCallRecord[] = [];
    await withModelCallCollector({ record: (c) => seen.push(c) }, async () => {
      reportModelCall(call({ model: 'gemini-3.7-flash', attempts: 2 }));
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBe('gemini-3.7-flash');
    expect(seen[0].attempts).toBe(2);
  });

  /**
   * The real client, exercised through its real failure path.
   *
   * A hand-built record asserting `model: null` here passed while the CLIENT named a model on
   * the fallback — the mutation that changed `model: null` to `model: primaryModel` survived,
   * because nothing tested what geminiClient actually reports. With no API key the SDK rejects
   * before any network call, so this measures the genuine path in ~0.5s.
   *
   * Skipped when a key IS present, because it would then make real calls; the source-level
   * assertion below runs unconditionally so the invariant is never left unguarded.
   */
  const noKey = !process.env.GEMINI_API_KEY;
  it.skipIf(!noKey)('a total failover records model: null, not a plausible id', async () => {
    const { safeGenerateJSON } = await import('../geminiClient');
    const seen: ModelCallRecord[] = [];
    const out = await withModelCallCollector({ record: (c) => seen.push(c) }, () =>
      safeGenerateJSON({ prompt: 'x', fallbackData: { fell: 'back' }, agentName: 'test-fallback' })
    );

    expect(out).toEqual({ fell: 'back' });
    expect(seen).toHaveLength(1);
    // `fallbackData` is a failure that type-checks. Naming a model would attribute an answer to
    // a model that never produced one, and would make cost attribution wrong in the same
    // direction as the fabricated £0.01.
    expect(seen[0].model).toBeNull();
    expect(seen[0].outcome).toBe('FALLBACK');
    expect(seen[0].totalTokens).toBeNull();
    expect(seen[0].attempts).toBeGreaterThan(1);
    expect(seen[0].failures.length).toBeGreaterThan(0);
  });

  it('the fallback record names no model in the source either', () => {
    const client = stripped('server/geminiClient.ts');
    const fallbackBlock = client.slice(client.lastIndexOf('reportModelCall('));
    expect(fallbackBlock).toContain('model: null');
    expect(fallbackBlock).not.toMatch(/model: (primaryModel|model|candidateModels)/);
  });

  it('two concurrent requests do not spend each other\'s budget', async () => {
    // The reason this uses AsyncLocalStorage and not a module-level array.
    const a: ModelCallRecord[] = [];
    const b: ModelCallRecord[] = [];
    await Promise.all([
      withModelCallCollector({ record: (c) => a.push(c) }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        reportModelCall(call({ agentName: 'A' }));
      }),
      withModelCallCollector({ record: (c) => b.push(c) }, async () => {
        reportModelCall(call({ agentName: 'B' }));
      }),
    ]);
    expect(a.map((c) => c.agentName)).toEqual(['A']);
    expect(b.map((c) => c.agentName)).toEqual(['B']);
  });

  it('reporting with no collector is silent, not a crash', () => {
    expect(isCollecting()).toBe(false);
    expect(() => reportModelCall(call())).not.toThrow();
  });

  it('geminiClient reports on BOTH the success and the total-failure paths', () => {
    const client = stripped('server/geminiClient.ts');
    expect((client.match(/reportModelCall\(/g) ?? []).length).toBe(2);
    expect(client).toContain("outcome: 'ANSWERED'");
    expect(client).toContain("outcome: 'FALLBACK'");
    // The id of the model that answered, not the one that was requested.
    expect(client).toMatch(/model,\s*\n\s*outcome: 'ANSWERED'/);
  });
});

// ===========================================================================
describe('3. provider usage is read without inventing numbers', () => {
  it('an absent usage object yields nulls, never zeros', () => {
    for (const absent of [undefined, null, 'nonsense', 42]) {
      expect(readUsage(absent)).toEqual({
        promptTokens: null,
        outputTokens: null,
        totalTokens: null,
      });
    }
  });

  it('a partial usage object does not have its gaps filled in', () => {
    expect(readUsage({ totalTokenCount: 300 })).toEqual({
      promptTokens: null,
      outputTokens: null,
      totalTokens: 300,
    });
  });

  it('a complete usage object is read exactly', () => {
    expect(
      readUsage({ promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 })
    ).toEqual({ promptTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  it('a zero the provider actually reported is kept as zero', () => {
    // Distinct from "not reported". Both must survive the round trip as themselves.
    expect(readUsage({ totalTokenCount: 0 }).totalTokens).toBe(0);
  });

  it('nonsense values are rejected rather than coerced', () => {
    expect(readUsage({ totalTokenCount: -5 }).totalTokens).toBeNull();
    expect(readUsage({ totalTokenCount: 'lots' }).totalTokens).toBeNull();
    expect(readUsage({ totalTokenCount: NaN }).totalTokens).toBeNull();
  });
});

// ===========================================================================
describe('4. a dropped email is no longer reported as success', () => {
  const pipeline = stripped('server/services/inboundPipeline.ts');

  it('the catch returns a failure outcome instead of only logging', () => {
    expect(pipeline).not.toMatch(/catch \(e\) \{\s*console\.error\("Error in inbound pipeline:", e\);\s*\}/);
    expect(pipeline).toMatch(/return \{\s*ok: false,/);
    expect(pipeline).toContain("stage: budgetHit ? 'BUDGET' : 'UNHANDLED'");
  });

  it('a budget breach is distinguishable from an unhandled throw', () => {
    expect(pipeline).toContain("message.startsWith('BUDGET_EXCEEDED')");
  });

  it('the success path returns a disposition, so it cannot be confused with a silent fall-through', () => {
    expect(pipeline).toMatch(/return \{ ok: true, disposition: 'QUEUED'/);
    expect(pipeline).toMatch(/disposition: 'SUPPRESSED'/);
    expect(pipeline).toMatch(/disposition: 'BLOCKED'/);
  });

  it('every early exit returns an outcome — no bare `return;` survives in the pipeline body', () => {
    // A bare return would be `undefined`, which is exactly the void the outcome type replaces.
    expect(pipeline).not.toMatch(/^\s*return;\s*$/m);
  });

  it('the caller READS the outcome rather than awaiting a void', () => {
    const sync = stripped('server/services/gmailHistorySync.service.ts');
    expect(sync).toMatch(/const outcome = await inboundPipeline\.processNewEmail\(/);
    expect(sync).toContain('outcome.ok === false');
    expect(sync).toContain('outcome.stage');
  });
});

// ===========================================================================
describe('5. the log endpoint can actually return a log', () => {
  const server = stripped('server.ts');

  it('it orders by the field the log shape has', () => {
    // Firestore EXCLUDES documents lacking the ordered field, so ordering by `timestamp` —
    // which AIRunLog does not have — would return [] even after a writer was added.
    expect(server).not.toMatch(/ai_logs'\)\), orderBy\('timestamp'/);
    expect(server).toMatch(/ai_run_logs'\)\), orderBy\('createdAt', 'desc'\)/);
  });

  it('AIRunLog really does use createdAt and really has no timestamp field', () => {
    const models = readFileSync('shared/domain/models.ts', 'utf8');
    const shape = models.slice(models.indexOf('export interface AIRunLog'));
    const body = shape.slice(0, shape.indexOf('}'));
    expect(body).toContain('createdAt');
    expect(body).not.toContain('timestamp');
  });

  it('an empty result says WHY it is empty', () => {
    // §14 applied to observability: an empty log must not read as "no problems".
    expect(server).toContain('writerExists: false');
    expect(server).toMatch(/An empty\s*\n?\s*'?\s*\+?\s*'?list here is an absent writer/);
  });
});

function stripped(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}
