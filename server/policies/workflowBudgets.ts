export interface WorkflowBudget {
  maxAgentStepsPerReply: number;
  maxModelCallsPerReply: number;
  maxRetriesPerAgent: number;
  maxTokensPerReplyWorkflow: number;
  maxCostPerReply: number;
  maxDecisionLatencyMs: number;
}

export const defaultWorkflowBudget: WorkflowBudget = {
  maxAgentStepsPerReply: 5,
  maxModelCallsPerReply: 3,
  maxRetriesPerAgent: 2,
  maxTokensPerReplyWorkflow: 8000,
  maxCostPerReply: 0.10,
  maxDecisionLatencyMs: 30000 // 30 seconds
};

/**
 * A snapshot of what a reply has actually spent (addendum §46, §2).
 *
 * `tokens` is a LOWER BOUND whenever `unmeasuredCalls > 0`: it is the sum of what the provider
 * reported, and calls the provider said nothing about contribute nothing to it. Reading it as
 * a total when calls went unmeasured is the mistake this type exists to prevent.
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
   * Why the cost ceiling is not enforced, or null if it is. Non-null means `maxCostPerReply`
   * is currently a number in a config file and nothing else.
   */
  costEnforcement: string | null;
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
 * COST IS NOT ENFORCED, AND SAYS SO
 * ---------------------------------
 * Turning tokens into pounds needs a per-model price table. The five models this system fails
 * over between are priced differently and I have no authoritative figures for them, so writing
 * a table would be inventing the numbers the fabricated £0.01 already invented. `maxCostPerReply`
 * therefore remains in the config and `costEnforcement` states, at runtime, that nothing
 * enforces it — rather than a cost meter that silently reads zero forever (§2).
 *
 * `maxModelCallsPerReply` is the ceiling that actually binds today, and it binds on a real
 * count.
 */
export class BudgetTracker {
  private steps = 0;
  private modelCalls = 0;
  private tokens = 0;
  private unmeasuredCalls = 0;
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
   * literal could be passed and never questioned.
   */
  recordModelCall(tokensUsed: number | null) {
    this.modelCalls++;
    if (typeof tokensUsed === 'number' && Number.isFinite(tokensUsed) && tokensUsed >= 0) {
      this.tokens += tokensUsed;
    } else {
      this.unmeasuredCalls++;
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
      costEnforcement: BudgetTracker.COST_NOT_ENFORCED,
    };
  }

  /**
   * Stated once, here, so every reader of a snapshot gets the same sentence and nobody has to
   * infer from a zero that the meter is off.
   */
  static readonly COST_NOT_ENFORCED =
    'maxCostPerReply is NOT enforced: converting provider tokens to pounds needs a per-model ' +
    'price table for the five models this client fails over between, and no authoritative ' +
    'figures for them exist in this repository. maxModelCallsPerReply is the ceiling that binds.';

  private checkBudget() {
    if (this.steps > this.budget.maxAgentStepsPerReply) throw new Error("BUDGET_EXCEEDED: maxAgentStepsPerReply");
    if (this.modelCalls > this.budget.maxModelCallsPerReply) throw new Error("BUDGET_EXCEEDED: maxModelCallsPerReply");
    // Compared against REPORTED tokens only. Unmeasured calls cannot push this over, which is
    // why `tokensArePartial` exists rather than this quietly standing in for a real total.
    if (this.tokens > this.budget.maxTokensPerReplyWorkflow) throw new Error("BUDGET_EXCEEDED: maxTokensPerReplyWorkflow");
    if ((Date.now() - this.startTime) > this.budget.maxDecisionLatencyMs) throw new Error("BUDGET_EXCEEDED: maxDecisionLatencyMs");
  }
}
