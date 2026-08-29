import React, { useState, useEffect } from "react";
import {
  Zap,
  Play,
  Pause,
  RotateCw,
  CheckCircle2,
  AlertTriangle,
  Mail,
  Users,
  TrendingUp,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  Clock,
  Sparkles,
  Layers,
  ArrowRight,
  Activity,
  Cpu,
  Radio,
  Search,
  CheckCheck,
  Send,
  Sliders,
  Trash2,
} from "lucide-react";
import { AutopilotStatusState } from "../types";

interface AutonomousGrowthPipelineCardProps {
  statusState: AutopilotStatusState;
  onToggleAutopilot: () => Promise<void>;
  onRunCycleNow: () => Promise<void>;
  onNavigateTab: (tab: string) => void;
  isLoading?: boolean;
}

export const AutonomousGrowthPipelineCard: React.FC<AutonomousGrowthPipelineCardProps> = ({
  statusState,
  onToggleAutopilot,
  onRunCycleNow,
  onNavigateTab,
  isLoading = false,
}) => {
  const [showLogs, setShowLogs] = useState(true);
  const [cycleRunning, setCycleRunning] = useState(false);
  const [livePulse, setLivePulse] = useState(true);

  // Pulse effect for live real-time status
  useEffect(() => {
    const timer = setInterval(() => {
      setLivePulse((prev) => !prev);
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  const handleRunCycle = async () => {
    setCycleRunning(true);
    try {
      await onRunCycleNow();
    } finally {
      setCycleRunning(false);
    }
  };

  const sentCount = statusState?.emailsSentToday || 0;
  const maxLimit = statusState?.dailyEmailLimit || 100;
  const percentUsed = Math.min(100, Math.round((sentCount / maxLimit) * 100));
  const isLimitReached = sentCount >= maxLimit;
  const isActive = statusState?.isActive ?? true;

  // Real-time task display
  const currentTask =
    cycleRunning
      ? "Executing Real-Time Discovery & Outbound Cycle..."
      : statusState?.currentLiveTask ||
        (isActive
          ? "24/7 Autonomous Growth Engine Active & Standby"
          : "Engine Paused by User");

  const activeStage = statusState?.activeStage || (isActive ? "IDLE_MONITORING" : "PAUSED");
  const stageDetail = statusState?.stageDetail || (isActive ? "Monitoring practice directories and inbound reply webhooks." : "Autopilot is currently paused.");
  const progressPercent = cycleRunning ? 65 : statusState?.progressPercent || (isActive ? 100 : 0);

  const stagesList = [
    {
      id: "PROSPECT_DISCOVERY",
      label: "1. Prospect Discovery",
      desc: "Scan UK clinics & AI VCs",
      icon: Search,
      isActive: activeStage === "PROSPECT_DISCOVERY" || cycleRunning,
    },
    {
      id: "ICP_SCORING",
      label: "2. 0-100 ICP Scoring",
      desc: "Evaluate missed call ROI",
      icon: Cpu,
      isActive: activeStage === "ICP_SCORING",
    },
    {
      id: "DELIVERABILITY_AUDIT",
      label: "3. QC & Spam Check",
      desc: "Verify 0 spam triggers",
      icon: ShieldCheck,
      isActive: activeStage === "DELIVERABILITY_AUDIT",
    },
    {
      id: "CADENCE_DISPATCH",
      label: "4. Outbound Dispatch",
      desc: "Throttled (Max 100/day)",
      icon: Send,
      isActive: activeStage === "CADENCE_DISPATCH",
    },
    {
      id: "IDLE_MONITORING",
      label: "5. 24/7 Monitoring",
      desc: "Listen for replies & demos",
      icon: Radio,
      isActive: activeStage === "IDLE_MONITORING" && isActive,
    },
  ];

  return (
    <div className="bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden transition-all">
      {/* 1. Header Banner */}
      <div className="p-5 sm:p-6 bg-gradient-to-r from-slate-950 via-slate-900 to-indigo-950 text-white flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-400">
              <Zap className="w-4 h-4 animate-pulse" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base sm:text-lg font-bold tracking-tight text-white">
                24/7 Autonomous Daily Growth Engine
              </h2>
              <span
                className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full border flex items-center gap-1.5 ${
                  !isActive
                    ? "bg-slate-800 text-slate-300 border-slate-700"
                    : isLimitReached
                    ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
                    : "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    !isActive ? "bg-slate-400" : isLimitReached ? "bg-amber-400" : "bg-emerald-400 animate-ping"
                  }`}
                />
                {!isActive ? "ENGINE PAUSED" : isLimitReached ? "DAILY 100 LIMIT REACHED" : "LIVE & AUTONOMOUS"}
              </span>
            </div>
          </div>
          <p className="text-xs text-slate-300 max-w-2xl leading-relaxed">
            Auto-runs daily to discover UK dental/medical practices and AI investors, scoring ICP fit and dispatching personalized outbound one-by-one with a strict <strong>100 emails/day cap</strong>.
          </p>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onToggleAutopilot}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
              isActive
                ? "bg-slate-800/90 hover:bg-slate-800 text-slate-200 border-slate-700 hover:border-slate-600"
                : "bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500 shadow-md shadow-emerald-600/30"
            }`}
          >
            {isActive ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span>{isActive ? "Pause Autopilot" : "Resume Autopilot"}</span>
          </button>

          <button
            onClick={handleRunCycle}
            disabled={cycleRunning || isLoading}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white bg-blue-600 hover:bg-blue-500 shadow-md shadow-blue-600/30 border border-blue-400/40 transition-all cursor-pointer disabled:opacity-50"
          >
            <RotateCw className={`w-3.5 h-3.5 ${cycleRunning ? "animate-spin" : ""}`} />
            <span>{cycleRunning ? "Running Discovery & Dispatch..." : "Trigger Auto-Cycle Now"}</span>
          </button>
        </div>
      </div>

      {/* 2. REAL-TIME LIVE ACTIVITY RADAR (WHAT THE SYSTEM IS DOING RIGHT NOW) */}
      <div className="bg-slate-900 border-y border-slate-800 px-5 py-4 text-white">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-start sm:items-center gap-3">
            <div className="relative p-2.5 rounded-xl bg-blue-950/80 border border-blue-500/40 text-blue-400 shrink-0">
              <Activity className="w-5 h-5 animate-pulse" />
              <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${isActive ? "bg-emerald-400 opacity-75" : "bg-slate-500 opacity-50"}`} />
                <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isActive ? "bg-emerald-500" : "bg-slate-400"}`} />
              </span>
            </div>

            <div className="space-y-0.5 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-blue-400 flex items-center gap-1">
                  <span>Current Live System Operation</span>
                </span>
                <span className="text-[10px] font-mono px-2 py-0.2 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  {activeStage}
                </span>
              </div>
              <div className="text-sm sm:text-base font-bold text-white tracking-tight truncate">
                {currentTask}
              </div>
              <div className="text-xs text-slate-400 font-normal">
                {stageDetail}
              </div>
            </div>
          </div>

          {/* Quick Real-Time Telemetry Counters */}
          <div className="flex items-center gap-3 shrink-0 pt-2 lg:pt-0 border-t lg:border-t-0 border-slate-800">
            <div className="px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-center">
              <div className="text-[10px] text-slate-400 uppercase font-semibold">Clinics Discovered</div>
              <div className="text-sm font-black text-emerald-400">+{statusState?.leadsDiscoveredToday || 0}</div>
            </div>
            <div className="px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-center">
              <div className="text-[10px] text-slate-400 uppercase font-semibold">Investors Discovered</div>
              <div className="text-sm font-black text-purple-400">+{statusState?.investorsDiscoveredToday || 0}</div>
            </div>
            <div className="px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-center">
              <div className="text-[10px] text-slate-400 uppercase font-semibold">Sent Today</div>
              <div className="text-sm font-black text-blue-400">{sentCount} / {maxLimit}</div>
            </div>
          </div>
        </div>

        {/* 5-Step Pipeline Flow Indicator */}
        <div className="mt-4 pt-3 border-t border-slate-800/80">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {stagesList.map((stage, idx) => {
              const Icon = stage.icon;
              return (
                <div
                  key={stage.id}
                  className={`p-2 rounded-lg border transition-all ${
                    stage.isActive
                      ? "bg-blue-900/40 border-blue-500/60 text-white shadow-xs shadow-blue-500/20"
                      : "bg-slate-950/40 border-slate-800/60 text-slate-400"
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-xs font-bold">
                    <Icon className={`w-3.5 h-3.5 ${stage.isActive ? "text-blue-400 animate-pulse" : "text-slate-500"}`} />
                    <span className="truncate">{stage.label}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 truncate mt-0.5">{stage.desc}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 3. Daily Quota & Safeguards */}
      <div className="p-5 sm:p-6 space-y-6">
        {/* Daily Sending Quota (Strict 100/day limit) */}
        <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Mail className="w-4 h-4 text-blue-600" />
              <span className="text-xs font-bold text-slate-900">
                Daily Outbound Email Safety Cap
              </span>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                Strict Limit: Max {maxLimit} emails/day
              </span>
            </div>
            <div className="text-xs text-slate-600 font-medium">
              <strong className="text-slate-900 font-bold">{sentCount}</strong> / {maxLimit} sent today ({Math.max(0, maxLimit - sentCount)} remaining)
            </div>
          </div>

          {/* Quota Progress Bar */}
          <div className="space-y-1">
            <div className="w-full h-3 rounded-full bg-slate-200 overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  isLimitReached
                    ? "bg-amber-500"
                    : percentUsed > 75
                    ? "bg-blue-600"
                    : "bg-emerald-500"
                }`}
                style={{ width: `${percentUsed}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>0 (Resets at Midnight)</span>
              <span className="flex items-center gap-1 font-medium text-emerald-700">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                Anti-Spam Reputation Armor Active
              </span>
              <span>100 Daily Safety Cap</span>
            </div>
          </div>
        </div>

        {/* 3-Step Continuous Autonomous Pipeline Quick Navigation */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Step 1: Daily Prospect Discovery */}
          <div
            onClick={() => onNavigateTab("leads")}
            className="p-3.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50/80 transition-colors cursor-pointer space-y-2 group"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <div className="w-5 h-5 rounded-full bg-blue-100 text-blue-800 text-[10px] font-bold flex items-center justify-center">
                  1
                </div>
                <span className="text-xs font-bold text-slate-900">Lead & Clinic Discovery</span>
              </div>
              <Users className="w-4 h-4 text-slate-400 group-hover:text-blue-600 transition-colors" />
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Auto-discovers high-volume dental & healthcare practices in the UK/US.
            </p>
            <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-100">
              <span className="text-[11px] text-emerald-600 font-bold">
                +{statusState?.leadsDiscoveredToday || 0} clinics today
              </span>
              <span className="text-[11px] text-blue-600 font-medium group-hover:underline flex items-center gap-0.5">
                <span>View Leads</span>
                <ArrowRight className="w-3 h-3" />
              </span>
            </div>
          </div>

          {/* Step 2: Investor Pipeline */}
          <div
            onClick={() => onNavigateTab("investors")}
            className="p-3.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50/80 transition-colors cursor-pointer space-y-2 group"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <div className="w-5 h-5 rounded-full bg-purple-100 text-purple-800 text-[10px] font-bold flex items-center justify-center">
                  2
                </div>
                <span className="text-xs font-bold text-slate-900">Investor Pipeline Discovery</span>
              </div>
              <TrendingUp className="w-4 h-4 text-slate-400 group-hover:text-purple-600 transition-colors" />
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Identifies Seed & Applied AI funds with $500K-$1.5M check sizes.
            </p>
            <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-100">
              <span className="text-[11px] text-purple-600 font-bold">
                +{statusState?.investorsDiscoveredToday || 0} investors today
              </span>
              <span className="text-[11px] text-purple-600 font-medium group-hover:underline flex items-center gap-0.5">
                <span>View Investors</span>
                <ArrowRight className="w-3 h-3" />
              </span>
            </div>
          </div>

          {/* Step 3: One-by-One Cadence Dispatch */}
          <div
            onClick={() => onNavigateTab("campaigns")}
            className="p-3.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50/80 transition-colors cursor-pointer space-y-2 group"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <div className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold flex items-center justify-center">
                  3
                </div>
                <span className="text-xs font-bold text-slate-900">One-by-One Cadence</span>
              </div>
              <Layers className="w-4 h-4 text-slate-400 group-hover:text-emerald-600 transition-colors" />
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Dispatches Day 1 $\rightarrow$ Day 3 $\rightarrow$ Day 7 outreach with pre-flight spam check.
            </p>
            <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-100">
              <span className="text-[11px] text-slate-700 font-medium">
                Pacing: <strong>Continuous (Max 100/day)</strong>
              </span>
              <span className="text-[11px] text-emerald-600 font-medium group-hover:underline flex items-center gap-0.5">
                <span>View Sequences</span>
                <ArrowRight className="w-3 h-3" />
              </span>
            </div>
          </div>
        </div>

        {/* Live Execution Logs Drawer Toggle */}
        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="w-full flex items-center justify-between p-3.5 bg-slate-50 hover:bg-slate-100/80 text-xs font-bold text-slate-700 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-blue-600" />
              <span>Real-Time Autonomous Execution Activity ({statusState?.recentLogs?.length || 0} Events)</span>
            </div>
            <div className="flex items-center gap-1.5 text-slate-500 font-normal">
              <span>{showLogs ? "Hide Audit Stream" : "View Live Stream"}</span>
              {showLogs ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>
          </button>

          {showLogs && (
            <div className="divide-y divide-slate-100 bg-white max-h-64 overflow-y-auto font-mono text-[11px]">
              {(statusState?.recentLogs || []).length === 0 ? (
                <div className="p-4 text-center text-slate-400 font-sans">
                  No execution events recorded yet. Click "Trigger Auto-Cycle Now" to start discovery.
                </div>
              ) : (
                statusState.recentLogs.map((log) => (
                  <div key={log.id} className="p-3 hover:bg-slate-50 flex items-start gap-3">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 uppercase ${
                        log.status === "SUCCESS"
                          ? "bg-emerald-100 text-emerald-800"
                          : log.status === "WARNING"
                          ? "bg-amber-100 text-amber-800"
                          : "bg-blue-100 text-blue-800"
                      }`}
                    >
                      {log.type}
                    </span>
                    <div className="flex-1 min-w-0 font-sans">
                      <div className="font-bold text-slate-900 text-xs">{log.title}</div>
                      <div className="text-slate-600 text-xs mt-0.5">{log.detail}</div>
                    </div>
                    <div className="text-[10px] text-slate-400 shrink-0">
                      {new Date(log.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
