import React from "react";
import { X, Sparkles, CheckCircle, AlertTriangle, HelpCircle, ShieldAlert } from "lucide-react";
import { ScoreBreakdown } from "../types";

interface ScoreWhyModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  totalScore: number;
  breakdown?: ScoreBreakdown;
  recommendedPitch?: string;
  bestAngle?: string;
  type?: "CUSTOMER" | "INVESTOR" | "PARTNER";
  customReasons?: string[];
  sensitiveRestrictions?: string[];
}

export const ScoreWhyModal: React.FC<ScoreWhyModalProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  totalScore,
  breakdown,
  recommendedPitch,
  bestAngle,
  type = "CUSTOMER",
  customReasons,
  sensitiveRestrictions,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center font-bold text-sm">
              {totalScore}
            </div>
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                <span>AI Score Breakdown: {title}</span>
              </h3>
              {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          {/* Sub-Score Bars if available */}
          {breakdown && (
            <div className="space-y-3 p-4 bg-slate-50 rounded-xl border border-slate-200/80">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Factor Scoring Weight
              </div>

              <div className="space-y-2">
                {/* ICP Fit (30%) */}
                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-700 mb-1">
                    <span>ICP Fit (Target Industry & Business Model)</span>
                    <span>{breakdown.icpFit} / 30</span>
                  </div>
                  <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-600 rounded-full"
                      style={{ width: `${(breakdown.icpFit / 30) * 100}%` }}
                    />
                  </div>
                </div>

                {/* Pain Probability (25%) */}
                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-700 mb-1">
                    <span>Pain Probability (Missed Calls & Overtime)</span>
                    <span>{breakdown.painProbability} / 25</span>
                  </div>
                  <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-600 rounded-full"
                      style={{ width: `${(breakdown.painProbability / 25) * 100}%` }}
                    />
                  </div>
                </div>

                {/* Intent (20%) */}
                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-700 mb-1">
                    <span>Intent & Automation Readiness</span>
                    <span>{breakdown.intent} / 20</span>
                  </div>
                  <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-600 rounded-full"
                      style={{ width: `${(breakdown.intent / 20) * 100}%` }}
                    />
                  </div>
                </div>

                {/* Decision Maker Quality (15%) */}
                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-700 mb-1">
                    <span>Decision Maker Authority</span>
                    <span>{breakdown.decisionMakerQuality} / 15</span>
                  </div>
                  <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-amber-500 rounded-full"
                      style={{ width: `${(breakdown.decisionMakerQuality / 15) * 100}%` }}
                    />
                  </div>
                </div>

                {/* Contactability (10%) */}
                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-700 mb-1">
                    <span>Contactability & Deliverability</span>
                    <span>{breakdown.contactability} / 10</span>
                  </div>
                  <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-purple-600 rounded-full"
                      style={{ width: `${(breakdown.contactability / 10) * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Key Reasons */}
          <div className="space-y-2">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
              <CheckCircle className="w-4 h-4 text-emerald-600" />
              <span>Why They Are A Strong Match</span>
            </div>
            <ul className="space-y-1.5">
              {(breakdown?.reasons || customReasons || [
                "Target industry reliant on inbound telephone appointments",
                "Decision maker title holds operational budget approval",
                "High appointment recovery ROI for after-hours calls",
              ]).map((r, idx) => (
                <li key={idx} className="text-xs text-slate-700 flex items-start gap-2 bg-slate-50 p-2 rounded-lg border border-slate-200/60">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-600 mt-1.5 shrink-0" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Recommended Pitch / Angle */}
          {(recommendedPitch || bestAngle) && (
            <div className="p-3.5 bg-blue-50/80 rounded-xl border border-blue-100 space-y-1.5">
              <div className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                <span>Recommended Outreach Pitch Angle</span>
              </div>
              <p className="text-xs text-slate-700 leading-relaxed font-medium">
                {recommendedPitch || bestAngle}
              </p>
            </div>
          )}

          {/* Sensitive Restrictions for Investors */}
          {sensitiveRestrictions && sensitiveRestrictions.length > 0 && (
            <div className="p-3.5 bg-amber-50 rounded-xl border border-amber-200 space-y-1.5">
              <div className="text-xs font-bold text-amber-900 flex items-center gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />
                <span>Sensitive Policy Restrictions</span>
              </div>
              <ul className="space-y-1">
                {sensitiveRestrictions.map((item, i) => (
                  <li key={i} className="text-xs text-amber-800 flex items-center gap-1.5">
                    <span>•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors"
          >
            Got It
          </button>
        </div>
      </div>
    </div>
  );
};
