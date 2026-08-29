import React from "react";
import { Menu, Sparkles, Plus, Calendar, Mail, ShieldCheck, HelpCircle, Zap } from "lucide-react";
import { AutopilotStatusState } from "../types";

interface HeaderProps {
  onToggleMobileMenu: () => void;
  onOpenCommandBar: () => void;
  onOpenOnboarding: () => void;
  onOpenNewCampaign: () => void;
  autopilotStatus?: AutopilotStatusState;
  onToggleAutopilot?: () => void;
  companyName: string;
  productName: string;
}

export const Header: React.FC<HeaderProps> = ({
  onToggleMobileMenu,
  onOpenCommandBar,
  onOpenOnboarding,
  onOpenNewCampaign,
  autopilotStatus,
  onToggleAutopilot,
  companyName,
  productName,
}) => {
  const sentCount = autopilotStatus?.emailsSentToday || 0;
  const maxLimit = autopilotStatus?.dailyEmailLimit || 100;
  const isActive = autopilotStatus?.isActive ?? true;

  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-xs border-b border-slate-200/80 px-4 sm:px-6 py-2.5">
      <div className="flex items-center justify-between gap-4">
        {/* Left: Mobile trigger & Workspace Info */}
        <div className="flex items-center space-x-3">
          <button
            id="mobile-menu-btn"
            onClick={onToggleMobileMenu}
            className="p-1.5 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 lg:hidden"
            aria-label="Toggle menu"
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2">
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-bold text-slate-900 tracking-tight">{companyName}</span>
                <span className="text-xs text-slate-400">/</span>
                <span className="text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded border border-blue-200/60">
                  {productName}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Center: Command Bar Quick Trigger */}
        <div className="flex-1 max-w-xl hidden md:block">
          <button
            id="header-command-bar-btn"
            onClick={onOpenCommandBar}
            className="w-full flex items-center justify-between px-3.5 py-1.5 rounded-lg bg-slate-100/90 hover:bg-slate-100 text-slate-500 text-xs border border-slate-200/80 transition-all shadow-2xs hover:border-slate-300"
          >
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-blue-600" />
              <span>Ask AI Growth Team (e.g. &quot;Find 50 UK dental clinics&quot;)...</span>
            </div>
            <kbd className="px-1.5 py-0.5 rounded bg-white text-[10px] font-mono text-slate-600 border border-slate-200 shadow-2xs">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* Right: Status & Action Pills */}
        <div className="flex items-center space-x-2 sm:space-x-3">
          {/* Active Engine Badge with Daily Email Cap */}
          <button
            onClick={onToggleAutopilot}
            title="Click to toggle 24/7 Daily Autopilot"
            className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium cursor-pointer transition-all ${
              isActive
                ? "bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100"
                : "bg-slate-100 text-slate-600 border-slate-300 hover:bg-slate-200"
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${isActive ? "bg-emerald-500 animate-pulse" : "bg-slate-400"}`} />
            <span>
              {isActive ? "24/7 Autopilot: Active" : "Autopilot: Paused"} ({sentCount}/{maxLimit} today)
            </span>
          </button>

          {/* Sync Indicators */}
          <div className="hidden lg:flex items-center gap-1 text-slate-400 text-xs">
            <div className="flex items-center gap-1 px-2 py-1 rounded bg-slate-50 border border-slate-200" title="Gmail Connected">
              <Mail className="w-3.5 h-3.5 text-emerald-600" />
              <span className="text-slate-600">Gmail</span>
            </div>
            <div className="flex items-center gap-1 px-2 py-1 rounded bg-slate-50 border border-slate-200" title="Google Calendar Connected">
              <Calendar className="w-3.5 h-3.5 text-blue-600" />
              <span className="text-slate-600">Calendar</span>
            </div>
          </div>

          {/* Onboarding / Brain Wizard Button */}
          <button
            id="growth-strategy-btn"
            onClick={onOpenOnboarding}
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded-lg border border-slate-200 transition-colors"
          >
            <HelpCircle className="w-3.5 h-3.5 text-slate-500" />
            <span className="hidden sm:inline">Growth Strategy</span>
          </button>

          {/* New Campaign Action */}
          <button
            id="new-campaign-btn"
            onClick={onOpenNewCampaign}
            className="flex items-center gap-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg shadow-sm shadow-blue-500/20 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Campaign</span>
          </button>
        </div>
      </div>
    </header>
  );
};

