export interface WorkflowBudget {
  maxAgentStepsPerReply: number;
  maxModelCallsPerReply: number;
  maxRetriesPerAgent: number;
  maxTokensPerReplyWorkflow: number;
  /**
   * USD cents, the provider's currency (see modelPricing.ts). This was `maxCostPerReply: 0.10`
   * — a float, in dollars, that nothing compared against anything (S37).
   */
  maxCostPerReplyMinor: number;
  maxDecisionLatencyMs: number;
}

export const defaultWorkflowBudget: WorkflowBudget = {
  maxAgentStepsPerReply: 5,
  maxModelCallsPerReply: 3,
  maxRetriesPerAgent: 2,
  maxTokensPerReplyWorkflow: 8000,
  maxCostPerReplyMinor: 10,
  maxDecisionLatencyMs: 30000 // 30 seconds
};

/**
 * A snapshot of what a reply has actually spent (addendum §46, §2).
 *
 * `tokens` is a LOWER BOUND whenever `unmeasuredCalls > 0`: it is the sum of what the provider
 * reported, and calls the provider said nothing about contribute nothing to it. Reading it as
 * a total when calls went unmeasured is the mistake this type exists to prevent. `costMinor`
 * carries the same caveat under `costIsPartial`.
 */
export interface BudgetSnapshot {
  steps: number;
  modelCalls: number;
  /** Sum of PROVIDER-REPORTED tokens. A lower bound when `unmeasuredCalls > 0`. */
  tokens: number;
  /** Calls the provider reported no usage for. Their token cost is unknown, not zero. */
  unmeasuredCalls: number;
  /** True when `tokens` is known to be incomplete. */
  tokensArePartial: boolean;
  elapsedMs: number;
  /**
   * USD cents this reply is KNOWN to have cost, from the provider's prices. A lower bound when
   * `costIsPartial`; a ceiling rather than a price when `costIsUpperBound`.
   */
  costMinor: number;
  costCurrency: 'USD';
  /** True when a call could not be priced, so `costMinor` is incomplete. */
  costIsPartial: boolean;
  /** True when a call was priced conservatively (unlisted model, output inferred from a total). */
  costIsUpperBound: boolean;
  /** Calls the provider reported too little usage to price. */
  unpricedCalls: number;
}

/**
 * Per-reply budget (addendum §46).
 *
 * WHAT WAS WRONG
 * --------------
 * The only cost accounting in the system was one line in the inbound pipeline:
 *
 *     budgetTracker.recordModelCall(500, 0.01); // Mock cost
 *
 * A constant token count and a constant cost, recorded on the line BEFORE the model call — so
 * it was charged even when the call failed, when it failed over to a different model, and when
 * `safeGenerateJSON` returned `fallbackData` instead of an answer. Meanwhile the two REAL model
 * calls on that path (`extractAndSynthesizeMemory` and `composeAutonomousSalesReply`) were
 * never recorded at all.
 *
 * So the ceilings were evaluating a fiction. Three calls at a made-up 500 tokens and £0.01
 * cannot reach 8000 tokens or £0.10, which means **no amount of real spending could ever trip
 * this budget** — while the number it reported was invented. That is worse than no budget: an
 * absent control is visibly absent.
 *
 * WHAT CHANGED
 * ------------
 * Usage now comes from the provider, via `reportModelCall` in the client that makes the call,
 * so a failover or a fallback is recorded as what it was. Where the provider reports nothing,
 * the call is counted as UNMEASURED rather than as zero — "this call cost nothing" is a
 * stronger claim than we can make, and it fails in the permissive direction (§14).
 *
 * COST, AND THE TWO PLACES AN UNKNOWN IS TREATED DIFFERENTLY (S37)
 * ----------------------------------------------------------------
 * Until S37 the cost ceiling was a float in a config file and a sentence in every snapshot
 * saying so, because no price table existed and writing one meant inventing figures. The
 * table exists now (modelPricing.ts, from the provider's published page, dated), so each call
 * arrives here with a price in cents, and `maxCostPerReplyMinor` binds.
 *
 * A call the provider did not report enough usage to price is handled in two places, and not
 * the same way, on purpose:
 *
 *   AT THE REPLY, here, it is PARTIAL: it adds nothing to `costMinor`, `costIsPartial` says so,
 *   and the ceiling is compared against the known sum. Inflating an unknown into a breach would
 *   be inventing the number the fabricated £0.01 invented — the same rule the token ceiling
 *   already follows, and `observability.invariant` pins.
 *
 *   IN THE TENANT LEDGER (tenantSpend.service.ts), where the money accumulates and the daily
 *   and monthly limits are enforced, it is charged the WHOLE per-reply ceiling and the window is
 *   marked an upper bound. A provider that stops reporting usage then runs the tenant into its
 *   limit at the fastest rate the policy allows, and stops — visibly. `ledgerChargeFor` is that
 *   rule, and it lives here because it is policy.
 */
export class BudgetTracker {
  private steps = 0;
  private modelCalls = 0;
  private tokens = 0;
  private unmeasuredCalls = 0;
  private costMinor = 0;
  private costIsUpperBound = false;
  private unpricedCalls = 0;
  private startTime = Date.now();

  constructor(private budget: WorkflowBudget = defaultWorkflowBudget) {}

  recordStep() {
    this.steps++;
    this.checkBudget();
  }

  /**
   * Record one completed model call.
   *
   * `tokensUsed` is `number | null`, and null is REQUIRED to mean "the provider did not say" —
   * callers must not substitute 0. The old signature took a plain number, which is why a
   * literal could be passed and never questioned. `costMinor` follows the same rule: null means
   * the call could not be priced (see modelPricing.ts), never that it was free.
   */
  recordModelCall(tokensUsed: number | null, costMinor: number | null = null, costIsUpperBound = false) {
    this.modelCalls++;
    if (typeof tokensUsed === 'number' && Number.isFinite(tokensUsed) && tokensUsed >= 0) {
      this.tokens += tokensUsed;
    } else {
      this.unmeasuredCalls++;
    }
    if (typeof costMinor === 'number' && Number.isInteger(costMinor) && costMinor >= 0) {
      this.costMinor += costMinor;
      if (costIsUpperBound) this.costIsUpperBound = true;
    } else {
      this.unpricedCalls++;
    }
    this.checkBudget();
  }

  snapshot(): BudgetSnapshot {
    return {
      steps: this.steps,
      modelCalls: this.modelCalls,
      tokens: this.tokens,
      unmeasuredCalls: this.unmeasuredCalls,
      tokensArePartial: this.unmeasuredCalls > 0,
      elapsedMs: Date.now() - this.startTime,
      costMinor: this.costMinor,
      costCurrency: 'USD',
      costIsPartial: this.unpricedCalls > 0,
      costIsUpperBound: this.costIsUpperBound,
      unpricedCalls: this.unpricedCalls,
    };
  }

  private checkBudget() {
    if (this.steps > this.budget.maxAgentStepsPerReply) throw new Error("BUDGET_EXCEEDED: maxAgentStepsPerReply");
    if (this.modelCalls > this.budget.maxModelCallsPerReply) throw new Error("BUDGET_EXCEEDED: maxModelCallsPerReply");
    // Compared against REPORTED tokens only. Unmeasured calls cannot push this over, which is
    // why `tokensArePartial` exists rather than this quietly standing in for a real total.
    if (this.tokens > this.budget.maxTokensPerReplyWorkflow) throw new Error("BUDGET_EXCEEDED: maxTokensPerReplyWorkflow");
    // Likewise against PRICED cost only. The ledger is where an unpriced call is charged.
    if (this.costMinor > this.budget.maxCostPerReplyMinor) throw new Error("BUDGET_EXCEEDED: maxCostPerReplyMinor");
    if ((Date.now() - this.startTime) > this.budget.maxDecisionLatencyMs) throw new Error("BUDGET_EXCEEDED: maxDecisionLatencyMs");
  }
}

/**
 * What one run adds to the tenant ledger (S37). The known cost, plus the whole per-reply ceiling
 * for every call that could not be priced — so a run of unpriced calls is charged the most it
 * was permitted to cost, and the ledger can only ever over-count, never under.
 */
export function ledgerChargeFor(
  snapshot: BudgetSnapshot,
  budget: WorkflowBudget = defaultWorkflowBudget
): { costMinor: number; costIsUpperBound: boolean; tokens: number; calls: number } {
  return {
    costMinor: snapshot.costMinor + snapshot.unpricedCalls * budget.maxCostPerReplyMinor,
    costIsUpperBound: snapshot.costIsUpperBound || snapshot.unpricedCalls > 0,
    tokens: snapshot.tokens,
    calls: snapshot.modelCalls,
  };
}
