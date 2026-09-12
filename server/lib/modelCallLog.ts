import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What actually happened on one model call (addendum §21, §46).
 *
 * WHY THIS EXISTS
 * ---------------
 * `geminiClient` fails over across five model ids — `gemini-3.1-pro-preview`,
 * `gemini-3.7-flash`, `gemini-3.1-flash-lite`, `gemini-flash-latest` and whatever the requested
 * category resolves to. They have different capabilities and different prices, and the caller
 * received an identical `T` in every case. **Nothing recorded which one answered.** So cost
 * could not be attributed even in principle, and a reply that went wrong could not be
 * reproduced — §21 reproducibility needs the model id, which is exactly what the unused `model`
 * column in the schema was for.
 *
 * Meanwhile the only cost accounting in the system was this, in the inbound pipeline:
 *
 *     budgetTracker.recordModelCall(500, 0.01); // Mock cost
 *
 * A constant token count and a constant cost, recorded on the line BEFORE the call, so it was
 * charged even when the call failed, failed over, or returned `fallbackData`. The two real
 * model calls on that path were never recorded at all. Three calls at a fabricated 500 tokens
 * cannot reach an 8000-token ceiling, so §46's budget could never trip however much was
 * actually spent.
 *
 * WHY `null` AND NOT `0`
 * ----------------------
 * When the provider does not report usage, the token counts are `null`. Zero would say "this
 * call cost nothing", which is a stronger claim than we can make and fails in the permissive
 * direction — the same mistake as the fabricated 500, pointing the other way (§14).
 *
 * WHY AsyncLocalStorage
 * ---------------------
 * `safeGenerateJSON` is called from inside agents several frames below the pipeline, so
 * threading a callback through every signature would touch a dozen call sites and be
 * forgotten at the thirteenth. A module-level array would be worse: two inbound emails
 * processed concurrently would spend each other's budget. The storage scopes the collector to
 * one logical request, which is exactly the boundary a per-reply budget is defined over.
 */
export interface ModelCallRecord {
  /** The agent that asked. */
  agentName: string;
  /** The category requested — a failover away from it is only visible by comparing with `model`. */
  category: string;
  /** The model that actually answered, or null when every candidate failed. */
  model: string | null;
  /** ANSWERED means a model returned usable text. FALLBACK means the caller got `fallbackData`. */
  outcome: 'ANSWERED' | 'FALLBACK';
  /** How many candidates were tried before this ended. */
  attempts: number;
  /** Provider-reported counts. `null` means NOT REPORTED — never assume zero. */
  promptTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Thinking tokens, reported separately by the provider and billed as output (S37). */
  thoughtsTokens: number | null;
  durationMs: number;
  /** One line per failed candidate, so a silent failover is legible after the fact. */
  failures: string[];
  /**
   * sha256 of exactly what was sent, or null if it could not be computed.
   *
   * THE HASH AND NOT THE PROMPT. §21 needs to prove which prompt produced a reply; §18 forbids
   * retaining the customer's words in a record operators read and models may be shown. A hash
   * settles "was this the same prompt?" — which is the question a reproducibility record is
   * actually asked — without keeping the text.
   */
  promptHash: string | null;
  /**
   * S22 — which TEMPLATE the prompt was rendered from, as declared at the call site. Two
   * renderings of one template have different hashes and the same version; the version is
   * pinned to the template's text by `promptVersions.invariant.test.ts`. `null` when the call
   * site declares none.
   */
  promptVersion: number | null;
}

/** Hash what was sent. The instruction and the untrusted content are hashed as distinct fields
 * so that moving text between them changes the hash — that move is the §18 violation. */
export function hashPrompt(parts: { systemInstruction?: string; contents?: string; prompt?: string }): string | null {
  try {
    const material = JSON.stringify({
      systemInstruction: parts.systemInstruction ?? null,
      contents: parts.contents ?? null,
      prompt: parts.prompt ?? null,
    });
    return createHash('sha256').update(material, 'utf8').digest('hex');
  } catch {
    // A prompt that cannot be hashed must not stop the call it describes.
    return null;
  }
}

export interface ModelCallCollector {
  record(call: ModelCallRecord): void;
}

const storage = new AsyncLocalStorage<ModelCallCollector>();

/** Run `fn` with a collector in scope; every model call inside it reports to that collector. */
export function withModelCallCollector<T>(collector: ModelCallCollector, fn: () => Promise<T>): Promise<T> {
  return storage.run(collector, fn);
}

/**
 * Report a completed model call to whatever collector is in scope.
 *
 * Silent when there is none — a script or a test calling an agent directly is not a bug, and
 * throwing here would make observability able to break the thing it observes.
 */
export function reportModelCall(call: ModelCallRecord): void {
  storage.getStore()?.record(call);
}

/** Is anything collecting? Lets a caller say "unmeasured" honestly rather than reporting zero. */
export function isCollecting(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Read a provider usage object without inventing numbers.
 *
 * Every field is independently optional: a provider that reports a total but not a breakdown
 * must not have the breakdown filled in with zeros.
 */
export function readUsage(usage: unknown): {
  promptTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  thoughtsTokens: number | null;
} {
  const pick = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

  if (usage === null || typeof usage !== 'object') {
    return { promptTokens: null, outputTokens: null, totalTokens: null, thoughtsTokens: null };
  }
  const u = usage as Record<string, unknown>;
  return {
    promptTokens: pick(u.promptTokenCount),
    outputTokens: pick(u.candidatesTokenCount),
    totalTokens: pick(u.totalTokenCount),
    thoughtsTokens: pick(u.thoughtsTokenCount),
  };
}
