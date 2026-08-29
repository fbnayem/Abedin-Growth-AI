import React from "react";
import {
  LayoutDashboard,
  Users,
  Building2,
  TrendingUp,
  Handshake,
  Send,
  Inbox,
  KanbanSquare,
  Calendar,
  Sparkles,
  BookOpen,
  BarChart3,
  Plug,
  Settings,
  ChevronRight,
  Bot,
  Flame,
} from "lucide-react";

export type NavTab =
  | "home"
  | "leads"
  | "companies"
  | "investors"
  | "partners"
  | "campaigns"
  | "inbox"
  | "pipeline"
  | "meetings"
  | "agent"
  | "knowledge"
  | "analytics"
  | "integrations"
  | "settings";

interface SidebarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  unreadInboxCount: number;
  attentionCount: number;
  isOpen: boolean;
  onCloseMobile?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  unreadInboxCount,
  attentionCount,
  isOpen,
  onCloseMobile,
}) => {
  const mainNavItems: { id: NavTab; label: string; icon: any; badge?: number; hot?: boolean }[] = [
    { id: "home", label: "Home", icon: LayoutDashboard, badge: attentionCount > 0 ? attentionCount : undefined, hot: attentionCount > 0 },
    { id: "leads", label: "Leads", icon: Users },
    { id: "companies", label: "Companies", icon: Building2 },
    { id: "investors", label: "Investors", icon: TrendingUp },
    { id: "partners", label: "Partners", icon: Handshake },
    { id: "campaigns", label: "Campaigns", icon: Send },
    { id: "inbox", label: "Inbox", icon: Inbox, badge: unreadInboxCount > 0 ? unreadInboxCount : undefined },
    { id: "pipeline", label: "Pipeline", icon: KanbanSquare },
    { id: "meetings", label: "Meetings", icon: Calendar },
    { id: "agent", label: "AI Growth Agent", icon: Sparkles },
    { id: "analytics", label: "Analytics", icon: BarChart3 },
    { id: "knowledge", label: "Knowledge", icon: BookOpen },
  ];

  const bottomNavItems: { id: NavTab; label: string; icon: any }[] = [
    { id: "integrations", label: "Integrations", icon: Plug },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-40 lg:hidden"
          onClick={onCloseMobile}
        />
      )}

      <aside
        id="app-sidebar"
        className={`fixed top-0 left-0 bottom-0 w-64 bg-slate-900 text-slate-200 z-50 flex flex-col border-r border-slate-800 transition-transform duration-200 ease-in-out lg:translate-x-0 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Brand Header */}
        <div className="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white shadow-md shadow-blue-500/20">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <div className="font-semibold text-white tracking-tight text-base flex items-center gap-1.5">
                Abedin Growth AI
              </div>
              <div className="text-xs text-blue-400 font-medium flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Abedin Voice AI Engine
              </div>
            </div>
          </div>
        </div>

        {/* Growth Engines Quick Switcher */}
        <div className="px-3.5 py-3 border-b border-slate-800/60 bg-slate-950/40">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 px-2 mb-1.5">
            Active Growth Engines
          </div>
          <div className="grid grid-cols-3 gap-1 text-[11px] text-center">
            <button
              onClick={() => onSelectTab("leads")}
              className={`py-1 rounded px-1 font-medium transition-colors ${
                currentTab === "leads" ? "bg-blue-600/30 text-blue-300 border border-blue-500/40" : "bg-slate-800/60 text-slate-300 hover:bg-slate-800"
              }`}
            >
              Customers
            </button>
            <button
              onClick={() => onSelectTab("investors")}
              className={`py-1 rounded px-1 font-medium transition-colors ${
                currentTab === "investors" ? "bg-indigo-600/30 text-indigo-300 border border-indigo-500/40" : "bg-slate-800/60 text-slate-300 hover:bg-slate-800"
              }`}
            >
              Investors
            </button>
            <button
              onClick={() => onSelectTab("partners")}
              className={`py-1 rounded px-1 font-medium transition-colors ${
                currentTab === "partners" ? "bg-emerald-600/30 text-emerald-300 border border-emerald-500/40" : "bg-slate-800/60 text-slate-300 hover:bg-slate-800"
              }`}
            >
              Partners
            </button>
          </div>
        </div>

        {/* Main Navigation */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5 custom-scrollbar">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 px-2.5 mb-1">
            Navigation
          </div>
          {mainNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentTab === item.id;
            return (
              <button
                key={item.id}
                id={`nav-item-${item.id}`}
                onClick={() => {
                  onSelectTab(item.id);
                  if (onCloseMobile) onCloseMobile();
                }}
                className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-sm font-medium transition-all group ${
                  isActive
                    ? "bg-blue-600 text-white shadow-sm shadow-blue-500/20"
                    : "text-slate-300 hover:text-white hover:bg-slate-800/80"
                }`}
              >
                <div className="flex items-center space-x-2.5 min-w-0">
                  <Icon
                    className={`w-4 h-4 shrink-0 transition-colors ${
                      isActive ? "text-white" : "text-slate-400 group-hover:text-slate-200"
                    }`}
                  />
                  <span className="truncate">{item.label}</span>
                </div>

                {item.badge !== undefined && (
                  <span
                    className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-0.5 ${
                      item.hot
                        ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                        : isActive
                        ? "bg-blue-800 text-blue-100"
                        : "bg-slate-800 text-slate-300 border border-slate-700"
                    }`}
                  >
                    {item.hot && <Flame className="w-2.5 h-2.5" />}
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Bottom Navigation */}
        <div className="p-3 border-t border-slate-800/80 space-y-0.5 bg-slate-950/20">
          {bottomNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentTab === item.id;
            return (
              <button
                key={item.id}
                id={`nav-item-${item.id}`}
                onClick={() => {
                  onSelectTab(item.id);
                  if (onCloseMobile) onCloseMobile();
                }}
                className={`w-full flex items-center space-x-2.5 px-2.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-slate-800 text-white"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}

          {/* User Profile */}
          <div className="pt-2 mt-2 border-t border-slate-800/60 flex items-center justify-between px-1">
            <div className="flex items-center space-x-2.5 min-w-0">
              <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center font-bold text-white text-xs shrink-0">
                NA
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-100 truncate">Nayem Abedin</div>
                <div className="text-[11px] text-slate-400 truncate">Founder & CEO</div>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-500" />
          </div>
        </div>
      </aside>
    </>
  );
};
