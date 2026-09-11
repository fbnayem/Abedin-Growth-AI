/**
 * S40 — THE GROWTH COMMAND'S RESULT, AS A TYPE BOTH SIDES MAY NAME.
 *
 * These interfaces lived in `server/agents/growthCommandAgent.ts`, so four React modules —
 * `App.tsx`, `CommandBar.tsx`, `WorkflowPlanModal.tsx`, `GrowthAgentView.tsx` — imported a server
 * agent to refer to them. The imports were written as value imports. Only esbuild eliding an
 * import whose bindings are used as types kept that agent, `@google/genai` and its API-key read
 * out of the browser bundle; one value used from that module would have shipped all three.
 *
 * A type the browser and the server both use belongs in `shared/`, and the browser imports it
 * with `import type`, which is erased by construction rather than by an optimisation.
 */

export interface AICommandPlanStep {
  stepNumber: number;
  title: string;
  description: string;
  actionType: "READ" | "WRITE" | "EXTERNAL";
}

export interface AICommandResult {
  intent: string;
  userMessage: string;
  responseSummary: string;
  requiresPlanApproval: boolean;
  structuredIntent?: {
    goal: string;
    engineType: "CUSTOMER" | "INVESTOR" | "PARTNER";
    targetIndustry?: string;
    location?: string;
    count?: number;
    filters?: Record<string, any>;
  };
  planSteps?: AICommandPlanStep[];
  actionRecommendation?: {
    type: string;
    targetTab?: string;
    payload?: any;
  };
}
