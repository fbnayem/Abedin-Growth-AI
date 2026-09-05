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

export class BudgetTracker {
  private steps = 0;
  private modelCalls = 0;
  private tokens = 0;
  private cost = 0;
  private startTime = Date.now();

  constructor(private budget: WorkflowBudget = defaultWorkflowBudget) {}

  recordStep() {
    this.steps++;
    this.checkBudget();
  }

  recordModelCall(tokensUsed: number, costIncurred: number) {
    this.modelCalls++;
    this.tokens += tokensUsed;
    this.cost += costIncurred;
    this.checkBudget();
  }

  private checkBudget() {
    if (this.steps > this.budget.maxAgentStepsPerReply) throw new Error("BUDGET_EXCEEDED: maxAgentStepsPerReply");
    if (this.modelCalls > this.budget.maxModelCallsPerReply) throw new Error("BUDGET_EXCEEDED: maxModelCallsPerReply");
    if (this.tokens > this.budget.maxTokensPerReplyWorkflow) throw new Error("BUDGET_EXCEEDED: maxTokensPerReplyWorkflow");
    if (this.cost > this.budget.maxCostPerReply) throw new Error("BUDGET_EXCEEDED: maxCostPerReply");
    if ((Date.now() - this.startTime) > this.budget.maxDecisionLatencyMs) throw new Error("BUDGET_EXCEEDED: maxDecisionLatencyMs");
  }
}
