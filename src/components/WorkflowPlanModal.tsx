import React, { useState } from "react";
import { Sparkles, CheckCircle2, Play, X, Loader2, ArrowRight, Layers } from "lucide-react";
import { AICommandResult } from "../../server/agents/growthCommandAgent";

interface WorkflowPlanModalProps {
  plan: AICommandResult | null;
  onClose: () => void;
  onConfirmStart: (plan: AICommandResult) => Promise<void>;
}

export const WorkflowPlanModal: React.FC<WorkflowPlanModalProps> = ({
  plan,
  onClose,
  onConfirmStart,
}) => {
  const [executing, setExecuting] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(-1);
  const [completed, setCompleted] = useState(false);

  if (!plan) return null;

  const handleStart = async () => {
    setExecuting(true);
    // Simulate step progression
    if (plan.planSteps && plan.planSteps.length > 0) {
      for (let i = 0; i < plan.planSteps.length; i++) {
        setCurrentStepIndex(i);
        await new Promise((res) => setTimeout(res, 600));
      }
    }
    await onConfirmStart(plan);
    setExecuting(false);
    setCompleted(true);
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-blue-600 to-indigo-600 text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center backdrop-blur-xs">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <div>
              <h3 className="text-base font-bold">Review AI Plan</h3>
              <p className="text-xs text-blue-100 font-medium">
                Autonomous Growth Workflow Proposal
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-white/80 hover:text-white hover:bg-white/10"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Plan Body */}
        <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          {/* Summary Callout */}
          <div className="p-3.5 rounded-lg bg-blue-50/80 border border-blue-100 text-slate-800 text-sm">
            <div className="font-semibold text-blue-900 text-xs uppercase tracking-wider mb-1">
              Objective
            </div>
            <p className="text-xs leading-relaxed">{plan.responseSummary}</p>
          </div>

          {/* Steps Timeline */}
          <div className="space-y-3">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Execution Sequence
            </div>

            {plan.planSteps?.map((step, idx) => {
              const isCurrent = executing && currentStepIndex === idx;
              const isPast = (executing && currentStepIndex > idx) || completed;

              return (
                <div
                  key={idx}
                  className={`p-3.5 rounded-lg border transition-all flex items-start gap-3 ${
                    isCurrent
                      ? "bg-blue-50 border-blue-300 shadow-xs ring-1 ring-blue-400/40"
                      : isPast
                      ? "bg-emerald-50/60 border-emerald-200"
                      : "bg-slate-50/70 border-slate-200/80"
                  }`}
                >
                  <div className="mt-0.5 shrink-0">
                    {isCurrent ? (
                      <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
                    ) : isPast ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    ) : (
                      <div className="w-4 h-4 rounded-full border border-slate-300 flex items-center justify-center text-[10px] font-bold text-slate-500">
                        {step.stepNumber}
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-900 truncate">
                        {step.title}
                      </span>
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.2 rounded uppercase ${
                          step.actionType === "EXTERNAL"
                            ? "bg-amber-100 text-amber-800 border border-amber-200"
                            : step.actionType === "WRITE"
                            ? "bg-blue-100 text-blue-800 border border-blue-200"
                            : "bg-slate-200 text-slate-700"
                        }`}
                      >
                        {step.actionType}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-600 mt-0.5">
                      {step.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Autonomy Note */}
          <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-[11px] text-slate-500 flex items-center gap-2">
            <Layers className="w-4 h-4 text-slate-400 shrink-0" />
            <span>Policy Engine: All outgoing messages will be queued for manual/autonomous safety checks.</span>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
          <button
            onClick={onClose}
            disabled={executing}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg transition-colors"
          >
            Cancel
          </button>

          <div className="flex items-center gap-2">
            {completed ? (
              <button
                onClick={onClose}
                className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Workflow Completed</span>
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={executing}
                className="px-5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm shadow-blue-500/20 transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                {executing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Executing Plan...</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Start Workflow</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
