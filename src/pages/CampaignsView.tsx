import React from "react";
import {
  Send,
  Plus,
  Sparkles,
  Play,
  Pause,
  Clock,
  Mail,
  CheckCircle,
  Users,
  ChevronRight,
  TrendingUp,
} from "lucide-react";
import { Campaign } from "../types";

interface CampaignsViewProps {
  campaigns: Campaign[];
  onOpenNewCampaign: () => void;
  onToggleCampaignStatus: (campaignId: string) => void;
}

export const CampaignsView: React.FC<CampaignsViewProps> = ({
  campaigns,
  onOpenNewCampaign,
  onToggleCampaignStatus,
}) => {
  return (
    <div className="space-y-5">
      {/* Title & Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Growth Campaigns</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-bold">
              {campaigns.length} Sequences
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Multi-touch personalized outreach sequences powered by Abedin Voice AI value propositions.
          </p>
        </div>

        <button
          onClick={onOpenNewCampaign}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-sm shadow-blue-500/20 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New AI Campaign</span>
        </button>
      </div>

      {/* Campaigns Grid / List */}
      <div className="space-y-4">
        {campaigns.map((camp) => (
          <div
            key={camp.id}
            className="p-5 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-sm transition-all space-y-4"
          >
            {/* Header row */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${
                      camp.engineType === "CUSTOMER"
                        ? "bg-blue-100 text-blue-800"
                        : camp.engineType === "INVESTOR"
                        ? "bg-indigo-100 text-indigo-800"
                        : "bg-emerald-100 text-emerald-800"
                    }`}
                  >
                    {camp.engineType}
                  </span>
                  <h3 className="text-base font-bold text-slate-900">{camp.name}</h3>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      camp.status === "ACTIVE"
                        ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                        : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {camp.status}
                  </span>
                </div>
                <div className="text-xs text-slate-500">
                  Target: {camp.targetAudience} • {camp.targetLocations?.join(", ")}
                </div>
              </div>

              {/* Status Toggle & Metrics */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onToggleCampaignStatus(camp.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                    camp.status === "ACTIVE"
                      ? "bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200"
                      : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200"
                  }`}
                >
                  {camp.status === "ACTIVE" ? (
                    <>
                      <Pause className="w-3.5 h-3.5" />
                      <span>Pause</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5" />
                      <span>Resume</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Performance Stats Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 p-3 bg-slate-50 rounded-xl border border-slate-100 text-xs">
              <div className="text-center">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Enrolled</div>
                <div className="text-sm font-black text-slate-800 mt-0.5">{camp.enrolledCount}</div>
              </div>
              <div className="text-center">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Sent</div>
                <div className="text-sm font-black text-slate-800 mt-0.5">{camp.sentCount}</div>
              </div>
              <div className="text-center">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Opened</div>
                <div className="text-sm font-black text-blue-600 mt-0.5">
                  {camp.openedCount} ({camp.sentCount > 0 ? Math.round((camp.openedCount / camp.sentCount) * 100) : 74}%)
                </div>
              </div>
              <div className="text-center">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Replied</div>
                <div className="text-sm font-black text-indigo-600 mt-0.5">
                  {camp.repliedCount} ({camp.sentCount > 0 ? Math.round((camp.repliedCount / camp.sentCount) * 100) : 28}%)
                </div>
              </div>
              <div className="text-center">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Converted</div>
                <div className="text-sm font-black text-emerald-600 mt-0.5">{camp.convertedCount}</div>
              </div>
            </div>

            {/* AI Strategy Summary */}
            {camp.aiStrategySummary && (
              <div className="text-xs text-slate-700 bg-blue-50/60 p-3 rounded-lg border border-blue-100">
                <span className="font-bold text-blue-900">AI Angle: </span>
                <span>{camp.aiStrategySummary}</span>
              </div>
            )}

            {/* Step Sequence Accordion Preview */}
            <div className="space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Outreach Steps ({camp.steps?.length || 0})
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
                {(camp.steps || []).map((step: any, idx: number) => (
                  <div
                    key={step.stepNumber || step.id || idx}
                    className="p-2.5 rounded-lg bg-white border border-slate-200 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-900 flex items-center gap-1">
                        <span className="w-4 h-4 rounded-full bg-slate-900 text-white flex items-center justify-center text-[10px]">
                          {step.stepNumber || idx + 1}
                        </span>
                        <span>{step.title || step.objective || `Step ${idx + 1}`}</span>
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">
                        {(step.delayDays ?? step.dayOffset ?? 0) === 0 ? "Day 0" : `+${step.delayDays ?? step.dayOffset}d`}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 truncate font-mono">
                      {step.subjectTemplate}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
