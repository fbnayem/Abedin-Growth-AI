import React from "react";
import {
  Sparkles,
  Users,
  MessageSquare,
  Calendar,
  DollarSign,
  TrendingUp,
  Handshake,
  AlertTriangle,
  ArrowRight,
  Flame,
  CheckCircle2,
  Clock,
  Send,
  HelpCircle,
} from "lucide-react";
import { NeedsAttentionItem, DailyGrowthBrief, AutopilotStatusState } from "../types";
import { AutonomousGrowthPipelineCard } from "../components/AutonomousGrowthPipelineCard";

interface DashboardViewProps {
  kpis: {
    qualifiedLeads: number;
    positiveConversations: number;
    meetingsBooked: number;
    pipelineValue: number;
    investorConversations: number;
    partnerConversations: number;
  };
  attentionItems: NeedsAttentionItem[];
  dailyBrief: DailyGrowthBrief;
  autopilotStatus?: AutopilotStatusState;
  onToggleAutopilot?: () => Promise<void>;
  onRunCycleNow?: () => Promise<void>;
  onNavigateTab: (tab: any) => void;
  onOpenCommandBar: () => void;
  onOpenAttentionItem: (item: NeedsAttentionItem) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  kpis = {
    qualifiedLeads: 0,
    positiveConversations: 0,
    meetingsBooked: 0,
    pipelineValue: 0,
    investorConversations: 0,
    partnerConversations: 0,
  },
  attentionItems = [],
  dailyBrief = {
    date: new Date().toLocaleDateString(),
    prospectsResearched: 0,
    qualifiedCount: 0,
    contactedCount: 0,
    demosBooked: 0,
    strategicRecommendation: "AI agents are analyzing new pipeline opportunities.",
  },
  autopilotStatus,
  onToggleAutopilot,
  onRunCycleNow,
  onNavigateTab,
  onOpenCommandBar,
  onOpenAttentionItem,
}) => {
  const safeAttentionItems = attentionItems || [];
  const safeKpis = {
    qualifiedLeads: kpis?.qualifiedLeads || 0,
    positiveConversations: kpis?.positiveConversations || 0,
    meetingsBooked: kpis?.meetingsBooked || 0,
    pipelineValue: kpis?.pipelineValue || 0,
    investorConversations: kpis?.investorConversations || 0,
    partnerConversations: kpis?.partnerConversations || 0,
  };
  const safeDailyBrief = dailyBrief || {
    date: new Date().toLocaleDateString(),
    prospectsResearched: 0,
    qualifiedCount: 0,
    contactedCount: 0,
    demosBooked: 0,
    strategicRecommendation: "AI agents are analyzing new pipeline opportunities.",
  };
  return (
    <div className="space-y-6">
      {/* Top Welcome Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 p-6 rounded-2xl text-white shadow-lg border border-slate-800">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-blue-500/20 text-blue-300 text-xs font-semibold border border-blue-500/30">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            AI Growth Engine: Active
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
            Good evening, Nayem
          </h1>
          <p className="text-xs sm:text-sm text-slate-300">
            Your autonomous AI Growth Team is prospecting, researching leads, and managing conversations for <strong>Abedin Voice AI</strong>.
          </p>
        </div>

        {/* Command Bar Trigger in Banner */}
        <div className="flex items-center gap-2">
          <button
            onClick={onOpenCommandBar}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shadow-md shadow-blue-600/30 transition-all cursor-pointer"
          >
            <Sparkles className="w-4 h-4 text-blue-200" />
            <span>AI Command Center</span>
          </button>
        </div>
      </div>

      {/* 24/7 Autonomous Daily Growth Engine Card */}
      {autopilotStatus && (
        <AutonomousGrowthPipelineCard
          statusState={autopilotStatus}
          onToggleAutopilot={onToggleAutopilot || (async () => {})}
          onRunCycleNow={onRunCycleNow || (async () => {})}
          onNavigateTab={onNavigateTab}
        />
      )}

      {/* Primary KPI Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
        {/* Qualified Leads */}
        <div
          onClick={() => onNavigateTab("leads")}
          className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-xs transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between text-slate-400 group-hover:text-blue-600">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Qualified Leads</span>
            <Users className="w-4 h-4 text-blue-600" />
          </div>
          <div className="mt-2 text-2xl font-black text-slate-900">{safeKpis.qualifiedLeads}</div>
          <div className="text-[10px] text-emerald-600 font-medium mt-0.5 flex items-center gap-1">
            <span>+4 today</span>
          </div>
        </div>

        {/* Positive Conversations */}
        <div
          onClick={() => onNavigateTab("inbox")}
          className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-xs transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between text-slate-400 group-hover:text-indigo-600">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Positive Replies</span>
            <MessageSquare className="w-4 h-4 text-indigo-600" />
          </div>
          <div className="mt-2 text-2xl font-black text-slate-900">{safeKpis.positiveConversations}</div>
          <div className="text-[10px] text-indigo-600 font-medium mt-0.5">3 pending replies</div>
        </div>

        {/* Meetings Booked */}
        <div
          onClick={() => onNavigateTab("meetings")}
          className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-xs transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between text-slate-400 group-hover:text-emerald-600">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Demos Booked</span>
            <Calendar className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="mt-2 text-2xl font-black text-slate-900">{safeKpis.meetingsBooked}</div>
          <div className="text-[10px] text-emerald-600 font-medium mt-0.5">Next on Thursday</div>
        </div>

        {/* Pipeline Value */}
        <div
          onClick={() => onNavigateTab("pipeline")}
          className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-xs transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between text-slate-400 group-hover:text-emerald-600">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Pipeline Value</span>
            <DollarSign className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="mt-2 text-2xl font-black text-slate-900">
            £{Math.round(safeKpis.pipelineValue / 1000)}k
          </div>
          <div className="text-[10px] text-slate-500 font-medium mt-0.5">Annual Contract Value</div>
        </div>

        {/* Investor Conversations */}
        <div
          onClick={() => onNavigateTab("investors")}
          className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-xs transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between text-slate-400 group-hover:text-purple-600">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Investor Dialogues</span>
            <TrendingUp className="w-4 h-4 text-purple-600" />
          </div>
          <div className="mt-2 text-2xl font-black text-slate-900">{safeKpis.investorConversations}</div>
          <div className="text-[10px] text-purple-600 font-medium mt-0.5">Seed Fund Round</div>
        </div>

        {/* Partner Conversations */}
        <div
          onClick={() => onNavigateTab("partners")}
          className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-xs transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between text-slate-400 group-hover:text-amber-600">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Partner Leads</span>
            <Handshake className="w-4 h-4 text-amber-600" />
          </div>
          <div className="mt-2 text-2xl font-black text-slate-900">{safeKpis.partnerConversations}</div>
          <div className="text-[10px] text-amber-600 font-medium mt-0.5">Agencies & Telecom</div>
        </div>
      </div>

      {/* AI PRIORITY CENTER: Needs Your Attention */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1 rounded bg-amber-100 text-amber-800">
              <Flame className="w-4 h-4" />
            </div>
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
              Needs Your Attention ({safeAttentionItems.length})
            </h2>
          </div>
          <span className="text-xs text-slate-500">Showing highest impact priority actions</span>
        </div>

        <div className="space-y-2.5">
          {safeAttentionItems.length === 0 ? (
            <div className="p-6 bg-white rounded-xl border border-slate-200 text-center text-xs text-slate-500">
              <CheckCircle2 className="w-6 h-6 text-emerald-500 mx-auto mb-1.5" />
              All conversations and workflows are up to date!
            </div>
          ) : (
            safeAttentionItems.map((item) => (
              <div
                key={item.id}
                className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-xs transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div
                    className={`p-2 rounded-lg mt-0.5 shrink-0 ${
                      item.priority === "HIGH"
                        ? "bg-rose-100 text-rose-700"
                        : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    <AlertTriangle className="w-4 h-4" />
                  </div>
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-900 truncate">{item.title}</span>
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.2 rounded-full uppercase ${
                          item.priority === "HIGH"
                            ? "bg-rose-100 text-rose-800 border border-rose-200"
                            : "bg-amber-100 text-amber-800 border border-amber-200"
                        }`}
                      >
                        {item.priority} Priority
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">{item.description}</p>
                    <div className="text-[11px] text-blue-600 font-medium">
                      Contact: {item.contactName} ({item.companyName})
                    </div>
                  </div>
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  <button
                    onClick={() => onOpenAttentionItem(item)}
                    className="px-3.5 py-1.5 rounded-lg text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-2xs transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <span>
                      {item.actionType === "FOUNDER_REVIEW"
                        ? "Founder Review"
                        : item.actionType === "REVIEW_REPLY"
                        ? "Review Reply"
                        : "Schedule Demo"}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* AI DAILY GROWTH BRIEF & STRATEGY */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Daily Stats Brief */}
        <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-4 lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-blue-600" />
              <h3 className="text-sm font-bold text-slate-900">AI Daily Growth Brief</h3>
            </div>
            <span className="text-xs font-mono text-slate-400">Date: {safeDailyBrief.date}</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
              <div className="text-xs text-slate-500 font-medium">Researched</div>
              <div className="text-lg font-black text-slate-900 mt-0.5">{safeDailyBrief.prospectsResearched}</div>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
              <div className="text-xs text-slate-500 font-medium">Qualified</div>
              <div className="text-lg font-black text-blue-600 mt-0.5">{safeDailyBrief.qualifiedCount}</div>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
              <div className="text-xs text-slate-500 font-medium">Contacted</div>
              <div className="text-lg font-black text-indigo-600 mt-0.5">{safeDailyBrief.contactedCount}</div>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
              <div className="text-xs text-slate-500 font-medium">Demos Booked</div>
              <div className="text-lg font-black text-emerald-600 mt-0.5">{safeDailyBrief.demosBooked}</div>
            </div>
          </div>

          {/* Strategic Recommendation */}
          <div className="p-3.5 rounded-xl bg-blue-50/70 border border-blue-200/80 text-xs text-blue-950 space-y-1">
            <div className="font-bold text-blue-900 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-blue-600" />
              <span>AI Growth Recommendation</span>
            </div>
            <p className="leading-relaxed text-slate-700">{safeDailyBrief.strategicRecommendation}</p>
          </div>
        </div>

        {/* Quick Launchpad */}
        <div className="p-5 rounded-2xl bg-slate-900 text-white border border-slate-800 shadow-md space-y-3 flex flex-col justify-between">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-blue-400">
              Growth Acceleration
            </div>
            <h4 className="text-sm font-bold text-white mt-1">Autonomous Workflows</h4>
            <p className="text-xs text-slate-300 mt-1 leading-relaxed">
              Launch targeted campaigns or discover prospects with specialized Gemini agents.
            </p>
          </div>

          <div className="space-y-1.5">
            <button
              onClick={() => onNavigateTab("leads")}
              className="w-full py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white flex items-center justify-between transition-colors"
            >
              <span>Prospect Customer Leads</span>
              <ArrowRight className="w-3.5 h-3.5 text-blue-400" />
            </button>
            <button
              onClick={() => onNavigateTab("investors")}
              className="w-full py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white flex items-center justify-between transition-colors"
            >
              <span>Explore AI Investors</span>
              <ArrowRight className="w-3.5 h-3.5 text-indigo-400" />
            </button>
            <button
              onClick={() => onNavigateTab("campaigns")}
              className="w-full py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white flex items-center justify-between transition-colors"
            >
              <span>Launch 4-Step Sequence</span>
              <ArrowRight className="w-3.5 h-3.5 text-emerald-400" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
