import { apiFetch } from '../lib/apiFetch';
import React, { useState } from "react";
import { Sparkles, ArrowRight, X, Loader2, Target, Users, TrendingUp, Mail, AlertCircle } from "lucide-react";
import { AICommandResult } from "../../server/agents/growthCommandAgent";

interface CommandBarProps {
  isOpen: boolean;
  onClose: () => void;
  onExecutePlan: (plan: AICommandResult) => void;
  onNavigateTab: (tab: any) => void;
}

export const CommandBar: React.FC<CommandBarProps> = ({
  isOpen,
  onClose,
  onExecutePlan,
  onNavigateTab,
}) => {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const quickPrompts = [
    { label: "Find 50 UK dental clinics", icon: Users, tab: "leads" },
    { label: "Find AI investors in Singapore", icon: TrendingUp, tab: "investors" },
    { label: "Follow up with warm leads", icon: Mail, tab: "inbox" },
    { label: "Show people needing my reply", icon: AlertCircle, tab: "inbox" },
    { label: "What should I focus on today?", icon: Target, tab: "home" },
  ];

  const handleSubmit = async (textToSubmit?: string) => {
    const text = textToSubmit || query;
    if (!text.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch("/api/growth-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: text }),
      });

      if (!res.ok) throw new Error("Failed to process growth command");
      const result: AICommandResult = await res.json();

      if (result.requiresPlanApproval && result.planSteps) {
        onExecutePlan(result);
        onClose();
      } else if (result.actionRecommendation?.targetTab) {
        onNavigateTab(result.actionRecommendation.targetTab);
        onClose();
      } else {
        alert(result.responseSummary);
        onClose();
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-start justify-center pt-20 px-4">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Input Bar */}
        <div className="p-4 border-b border-slate-200 flex items-center gap-3">
          <Sparkles className="w-5 h-5 text-blue-600 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
              if (e.key === "Escape") onClose();
            }}
            placeholder="What would you like your AI Growth Team to do?"
            className="w-full text-base outline-hidden text-slate-800 placeholder-slate-400 font-medium"
            autoFocus
          />
          {loading ? (
            <Loader2 className="w-5 h-5 text-blue-600 animate-spin shrink-0" />
          ) : (
            <button
              onClick={() => handleSubmit()}
              disabled={!query.trim()}
              className="p-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 transition-colors"
            >
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="px-4 py-2 bg-rose-50 border-b border-rose-200 text-rose-700 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            <span>{error}</span>
          </div>
        )}

        {/* Quick prompt pills */}
        <div className="p-4 bg-slate-50/70 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Suggested Growth Objectives
          </div>
          <div className="flex flex-wrap gap-1.5">
            {quickPrompts.map((p, idx) => {
              const Icon = p.icon;
              return (
                <button
                  key={idx}
                  onClick={() => {
                    setQuery(p.label);
                    handleSubmit(p.label);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white hover:bg-blue-50 text-slate-700 hover:text-blue-700 border border-slate-200/80 hover:border-blue-200 text-xs font-medium transition-all shadow-2xs"
                >
                  <Icon className="w-3.5 h-3.5 text-blue-600" />
                  <span>{p.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Footer tip */}
        <div className="px-4 py-2.5 bg-slate-100/70 border-t border-slate-200/60 flex items-center justify-between text-[11px] text-slate-500">
          <span>AI will generate a visible step-by-step plan before making bulk changes</span>
          <span className="font-mono">Press ESC to close</span>
        </div>
      </div>
    </div>
  );
};
