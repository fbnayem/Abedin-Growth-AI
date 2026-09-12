import { v4 as uuidv4 } from 'uuid';
import { collection, doc, setDoc } from '../store';
import { store } from '../store';
import { orgPath } from '../tenancy/orgScope';
import type { AIRunLog } from '../../shared/domain/models';
import type { ModelCallRecord } from './modelCallLog';
import type { BudgetSnapshot } from '../policies/workflowBudgets';
import { POLICY_VERSION } from '../policies/version';

/**
 * The run-log writer (addendum §21, §46, §2, §18).
 *
 * WHAT WAS MISSING
 * ----------------
 * `/api/logs` read a collection with no producer, ordered by a field the log shape does not
 * have. The `ai_run_logs` table in the PostgreSQL schema had the right columns — `model`,
 * `promptHash`, `contextHash`, `promptTokens` — and nothing ever inserted a row into it. So the
 * observability surface was three correct halves that had never met: an endpoint, a shape, and
 * a schema, with no writer.
 *
 * Rows go to the DOCUMENT STORE, under the tenant path. When this was written that store was
 * Firestore, and this paragraph said the PostgreSQL table "remains the right destination if
 * PostgreSQL is ever provisioned". It has been (§1x): the document store runs on it, so the
 * relational `ai_run_logs` table is not a future destination but a second, empty table in the
 * same database with the same columns. It is RETIRED in schema.ts and guarded by
 * `deadSchema.invariant.test.ts` until S5 drops it (S22).
 *
 * WHAT IS DELIBERATELY NOT WRITTEN
 * --------------------------------
 * The customer's email text, the assembled prompt, and the drafted reply. A run log is read by
 * operators and is exactly the kind of record that gets pasted back into a model. Storing
 * untrusted customer text here is how one injected sentence becomes a durable artefact the
 * system quotes to itself (§18). `promptHashes` settles "was this the same prompt?" without
 * retaining it, and the ids address the real content where it already lives.
 *
 * WHY A FAILED WRITE DOES NOT FAIL THE RUN
 * ----------------------------------------
 * Observability must not be able to break the thing it observes: a Firestore outage must not
 * stop a customer's email being answered. But a silent failure here would recreate the exact
 * defect this closes, so a failed write is logged loudly and reported in the return value.
 */

export interface RunLogInput {
  organizationId: string;
  agentType: string;
  actionType: string;
  status: 'SUCCESS' | 'FAILED';
  disposition: 'QUEUED' | 'SUPPRESSED' | 'BLOCKED' | 'AUTOMATED' | 'ABSTAINED' | 'FAILED';
  /** System-generated prose. NEVER customer text (§18). */
  summary: string;
  stage?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  durationMs: number;
  /**
   * §21 — the identity of the context the model was shown, from `buildContextBundle`.
   *
   * `contextIds` is the manifest: every record that went in, addressable, so the exact input
   * can be reconstructed. Null means no bundle was built, which is a different fact from an
   * empty manifest and is recorded as such.
   */
  contextHash?: string | null;
  contextIds?: string[] | null;
  modelCalls: readonly ModelCallRecord[];
  budget: BudgetSnapshot;
  /** ISO instant. Injected rather than read from the wall clock, so this is testable (§30). */
  now: string;
}

/**
 * The shape of a pipeline outcome, structurally — deliberately not an import of
 * `InboundOutcome`, which would be a cycle since the pipeline imports this module.
 */
export interface RunOutcomeSummary {
  ok: boolean;
  disposition?: 'QUEUED' | 'SUPPRESSED' | 'BLOCKED' | 'AUTOMATED' | 'ABSTAINED';
  stage?: string | null;
  detail: string;
}

/**
 * Map a pipeline outcome onto the log's status fields.
 *
 * A pure function rather than four lines inside `processNewEmail`, because mutating that inline
 * form to record a FAILED run as `status: 'SUCCESS'` survived the whole suite: every test built
 * a row with the status already chosen, so nothing exercised the choosing. A log that records
 * failures as successes is the defect this writer exists to close, wearing the writer's clothes.
 */
export function runLogFieldsFor(outcome: RunOutcomeSummary): {
  status: 'SUCCESS' | 'FAILED';
  disposition: 'QUEUED' | 'SUPPRESSED' | 'BLOCKED' | 'AUTOMATED' | 'ABSTAINED' | 'FAILED';
  summary: string;
  stage: string | null;
} {
  // `=== true` rather than a truthiness test.
  //
  // For a genuine boolean the two are identical — mutating this to `if (outcome.ok)` was
  // measured to survive, and it survived honestly. The strictness is for the value arriving as
  // something other than a boolean: this shape is one deserialisation away from a queue or a
  // replayed log, and `ok: 1` or `ok: "yes"` is not a success anybody vouched for. Specified by
  // test rather than left as decoration.
  if (outcome.ok === true) {
    // A run that finished without a disposition is not a success we can describe. Defaulting to
    // QUEUED would claim an outbox row that may not exist (§14).
    const disposition = outcome.disposition;
    if (disposition === undefined) {
      return {
        status: 'FAILED',
        disposition: 'FAILED',
        summary: `FAILED: run reported ok with no disposition — ${outcome.detail}`,
        stage: 'UNHANDLED',
      };
    }
    return {
      status: 'SUCCESS',
      disposition,
      summary: `${disposition}: ${outcome.detail}`,
      stage: null,
    };
  }

  const stage = outcome.stage ?? 'UNHANDLED';
  return {
    status: 'FAILED',
    disposition: 'FAILED',
    summary: `FAILED at ${stage}: ${outcome.detail}`,
    stage,
  };
}

export type RunLogOutcome =
  | { ok: true; id: string }
  | { ok: false; reason: 'STORE_UNAVAILABLE' | 'WRITE_FAILED'; message: string };

/**
 * Build the row without writing it.
 *
 * Separated so every decision in it is testable without a datastore — and because the
 * interesting content of this module is the decisions, not the `setDoc`.
 */
export function buildRunLog(input: RunLogInput): AIRunLog {
  const calls = input.modelCalls ?? [];

  return {
    id: `run_${uuidv4()}`,
    workspaceId: input.organizationId,
    agentType: input.agentType,
    actionType: input.actionType,
    // The category of the first call that happened. `null` when no model was called at all —
    // a run suppressed before composing is a real run and must still be logged, and naming a
    // category nothing used would be an invention.
    modelCategory: categoryOf(calls),
    status: input.status,
    // NOT a placeholder. Nothing in this pipeline computes a confidence, and a number here
    // would be read by an operator as a measurement (§2).
    confidence: null,
    summary: input.summary,
    durationMs: input.durationMs,
    createdAt: input.now,

    disposition: input.disposition,
    stage: input.stage ?? null,
    conversationId: input.conversationId ?? null,
    messageId: input.messageId ?? null,
    // In call order, `null` preserved: a null entry is a total failover where the caller got
    // `fallbackData`. Dropping the nulls would make a run of failures look like a shorter run
    // of successes.
    models: calls.map((c) => c.model),
    promptHashes: calls.map((c) => c.promptHash),
    promptVersions: calls.map((c) => c.promptVersion),
    contextHash: input.contextHash ?? null,
    contextIds: input.contextIds ?? null,
    modelCalls: input.budget.modelCalls,
    reportedTokens: input.budget.tokens,
    tokensArePartial: input.budget.tokensArePartial,
    unmeasuredCalls: input.budget.unmeasuredCalls,
    // S37 — from the provider's prices, in the provider's currency. The known sum, with the two
    // flags that say when it is not the whole story. The sentence that sat here ("NOT enforced:
    // no price table exists") was true when written and is gone with the table.
    costMinor: input.budget.costMinor,
    currency: input.budget.costCurrency,
    costIsPartial: input.budget.costIsPartial,
    costIsUpperBound: input.budget.costIsUpperBound,
    unpricedCalls: input.budget.unpricedCalls,
    // S22 — the rules this run was decided under. A constant, not an input: every run in a
    // process is governed by the same policy, and the test that pins the constant to the policy
    // sources is what makes the number mean something.
    policyVersion: POLICY_VERSION,
  };
}

function categoryOf(calls: readonly ModelCallRecord[]): 'FAST' | 'SMART' | 'DEEP' | null {
  for (const call of calls) {
    if (call.category === 'FAST' || call.category === 'SMART' || call.category === 'DEEP') {
      return call.category;
    }
  }
  return null;
}

/** Write one run log. Never throws. */
export async function writeRunLog(input: RunLogInput): Promise<RunLogOutcome> {
  const row = buildRunLog(input);

  if (!store) {
    console.error(
      `[runLog] Datastore unavailable; run ${row.id} for organisation ${input.organizationId} ` +
        'was NOT recorded. The reply proceeded, but this run is not reproducible.'
    );
    return { ok: false, reason: 'STORE_UNAVAILABLE', message: 'Datastore unavailable.' };
  }

  try {
    await setDoc(doc(collection(store, orgPath(input.organizationId, 'ai_run_logs')), row.id), row);
    return { ok: true, id: row.id };
  } catch (e: any) {
    // Loud, because a run log that fails silently is indistinguishable from the writer that
    // never existed — which is the defect this module closes.
    const message = e?.message ?? String(e);
    console.error(
      `[runLog] FAILED to record run ${row.id} for organisation ${input.organizationId}: ${message}`
    );
    return { ok: false, reason: 'WRITE_FAILED', message };
  }
}
