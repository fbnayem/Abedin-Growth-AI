import { PolicyDecision, AutopilotSettings } from "../../shared/domain/models";

export interface ActionContext {
  actionName: string;
  category: "CUSTOMER" | "INVESTOR" | "PARTNER";
  isUnsubscribed?: boolean;
  isDuplicate?: boolean;
  involvesPricingOrDiscount?: boolean;
  involvesInvestorValuationOrEquity?: boolean;
  aiConfidence?: number;
  autonomySettings?: Partial<AutopilotSettings>;
}

export function evaluatePolicy(context: ActionContext): {
  decision: PolicyDecision;
  reason: string;
} {
  // 1. Hard Block rules
  if (context.isUnsubscribed) {
    return {
      decision: "BLOCK",
      reason: "Recipient has unsubscribed or is in suppression list. Outreach is strictly blocked.",
    };
  }

  if (context.isDuplicate) {
    return {
      decision: "BLOCK",
      reason: "Duplicate outreach detected within the last 48 hours to this contact.",
    };
  }

  // 2. Escalation rules (Must be founder/executive handled)
  if (context.involvesInvestorValuationOrEquity) {
    return {
      decision: "ESCALATE",
      reason: "Contains discussion of valuation, equity, cap table, or formal investment terms. Founder review is strictly required.",
    };
  }

  // 3. Approval rules
  if (context.involvesPricingOrDiscount) {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: "Non-standard pricing, custom discount, or enterprise contract terms requested. Manual approval needed.",
    };
  }

  // 4. Low AI confidence
  const minConfidence = context.autonomySettings?.minAiConfidenceToSend ?? 0.85;
  if (context.aiConfidence !== undefined && context.aiConfidence < minConfidence) {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: `AI confidence (${Math.round((context.aiConfidence || 0) * 100)}%) is below safety threshold (${Math.round(minConfidence * 100)}%).`,
    };
  }

  // 5. Autonomy toggles check
  if (context.actionName === "SEND_CAMPAIGN_EMAIL" && !context.autonomySettings?.sendApprovedCampaigns) {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: "Campaign automated sending is toggled to manual approval in AI Autopilot settings.",
    };
  }

  if (context.actionName === "SEND_REPLY" && !context.autonomySettings?.replyToSimpleQuestions) {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: "Automated reply sending requires manual one-click user sign-off in settings.",
    };
  }

  return {
    decision: "ALLOW",
    reason: "Action meets all compliance, confidence, and autonomy safety policies.",
  };
}
