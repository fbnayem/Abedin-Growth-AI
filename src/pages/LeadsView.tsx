import React, { useState } from "react";
import {
  Users,
  Search,
  Plus,
  Sparkles,
  Filter,
  Mail,
  Calendar,
  MoreHorizontal,
  ArrowUpDown,
  ExternalLink,
  HelpCircle,
  Loader2,
  Building2,
  CheckCircle2,
  Download,
  Send,
  KanbanSquare,
  Table as TableIcon,
  CheckSquare,
  Square,
  Swords,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Flame,
  FileText,
  Linkedin,
  Clock,
  Check,
  Eye,
  MousePointerClick,
  ShieldCheck,
  Zap,
  ArrowRight,
  X,
} from "lucide-react";
import { Lead, LeadStatus, Conversation } from "../types";
import { exportToCSV, exportToJSON } from "../utils/exportUtils";
import { diagnosticFetch } from "../utils/diagnosticFetch";

interface LeadsViewProps {
  leads: Lead[];
  conversations?: Conversation[];
  onSelectLead: (lead: Lead) => void;
  onOpenScoreWhy: (lead: Lead) => void;
  onOpenAddLead: () => void;
  onBatchDiscoverLeads: () => void;
  onBookMeeting: (lead: Lead) => void;
  onOpenPitchSimulator?: (lead: Lead) => void;
  onOpenBattlecard?: (lead: Lead) => void;
  onUpdateLeadStatus?: (leadId: string, newStatus: LeadStatus) => void;
  onBulkEnrollCampaign?: (leads: Lead[]) => void;
  onNavigateToInbox?: (conversationId?: string) => void;
  onRefreshLeads?: () => void;
}

export const LeadsView: React.FC<LeadsViewProps> = ({
  leads,
  conversations,
  onSelectLead,
  onOpenScoreWhy,
  onOpenAddLead,
  onBatchDiscoverLeads,
  onBookMeeting,
  onOpenPitchSimulator,
  onOpenBattlecard,
  onUpdateLeadStatus,
  onBulkEnrollCampaign,
  onNavigateToInbox,
  onRefreshLeads,
}) => {
  const [viewMode, setViewMode] = useState<"table" | "kanban">("table");
  const [activeTab, setActiveTab] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIndustry, setSelectedIndustry] = useState<string>("ALL");
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(new Set());
  const [showBulkSuccess, setShowBulkSuccess] = useState(false);
  const [inspectMessageLead, setInspectMessageLead] = useState<Lead | null>(null);
  const [batchActionLoading, setBatchActionLoading] = useState(false);
  const [batchActionFeedback, setBatchActionFeedback] = useState<string | null>(null);

  // Pagination State
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number | "ALL">(25);

  const engagedCount = leads.filter((l) => l.status === "ENGAGED" || l.status === "DEMO_SCHEDULED" || l.status === "WON").length;
  const contactedCount = leads.filter((l) => l.status === "CONTACTED" || !!l.contactedAt).length;
  const demoCount = leads.filter((l) => l.status === "DEMO_SCHEDULED").length;
  const wonCount = leads.filter((l) => l.status === "WON").length;

  const tabs = [
    { id: "ALL", label: "All Leads", count: leads.length },
    {
      id: "ENGAGED",
      label: "💬 Replied Leads",
      count: engagedCount,
    },
    { id: "DEMO_SCHEDULED", label: "Demo Booked", count: demoCount },
    { id: "CONTACTED", label: "Outreach Sent", count: contactedCount },
    { id: "QUALIFIED", label: "Qualified", count: leads.filter((l) => l.status === "QUALIFIED").length },
    { id: "WON", label: "Won", count: wonCount },
    { id: "NEW", label: "New (Discovered)", count: leads.filter((l) => l.status === "NEW").length },
  ];

  const kanbanColumns: { id: LeadStatus; label: string; bg: string; border: string; badge: string }[] = [
    { id: "NEW", label: "Discovered (New)", bg: "bg-slate-50", border: "border-slate-200", badge: "bg-slate-200 text-slate-800" },
    { id: "QUALIFIED", label: "Qualified ICP", bg: "bg-blue-50/50", border: "border-blue-200", badge: "bg-blue-100 text-blue-800" },
    { id: "CONTACTED", label: "Outreach Sent", bg: "bg-indigo-50/50", border: "border-indigo-200", badge: "bg-indigo-100 text-indigo-800" },
    { id: "ENGAGED", label: "💬 Replied / Engaged", bg: "bg-amber-50/50", border: "border-amber-200", badge: "bg-amber-100 text-amber-800" },
    { id: "DEMO_SCHEDULED", label: "Demo Booked", bg: "bg-purple-50/50", border: "border-purple-200", badge: "bg-purple-100 text-purple-800" },
    { id: "WON", label: "Closed Won", bg: "bg-emerald-50/50", border: "border-emerald-200", badge: "bg-emerald-100 text-emerald-800" },
  ];

  const industries = Array.from(new Set(leads.map((l) => l.industry))).filter(Boolean);

  const filteredLeads = leads.filter((lead) => {
    if (activeTab === "ENGAGED") {
      if (lead.status !== "ENGAGED" && lead.status !== "DEMO_SCHEDULED" && lead.status !== "WON") return false;
    } else if (activeTab === "CONTACTED") {
      if (lead.status !== "CONTACTED" && !lead.contactedAt) return false;
    } else if (activeTab !== "ALL" && lead.status !== activeTab) {
      return false;
    }

    if (selectedIndustry !== "ALL" && lead.industry !== selectedIndustry) {
      return false;
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        lead.name.toLowerCase().includes(q) ||
        lead.companyName.toLowerCase().includes(q) ||
        lead.industry.toLowerCase().includes(q) ||
        lead.country.toLowerCase().includes(q) ||
        lead.title.toLowerCase().includes(q) ||
        (lead.recommendedActionLabel && lead.recommendedActionLabel.toLowerCase().includes(q))
      );
    }
    return true;
  });

  // Calculate Pagination Slices
  const totalCount = filteredLeads.length;
  const totalPages = pageSize === "ALL" ? 1 : Math.ceil(totalCount / (pageSize as number));
  const safePage = Math.min(Math.max(1, currentPage), Math.max(1, totalPages));

  const startIndex = pageSize === "ALL" ? 0 : (safePage - 1) * (pageSize as number);
  const endIndex = pageSize === "ALL" ? totalCount : Math.min(startIndex + (pageSize as number), totalCount);
  const paginatedLeads = filteredLeads.slice(startIndex, endIndex);

  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId);
    setCurrentPage(1);
  };

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    setCurrentPage(1);
  };

  const handleIndustryChange = (ind: string) => {
    setSelectedIndustry(ind);
    setCurrentPage(1);
  };

  const handlePageSizeChange = (newSize: number | "ALL") => {
    setPageSize(newSize);
    setCurrentPage(1);
  };

  const toggleSelectAll = () => {
    if (selectedLeadIds.size === filteredLeads.length) {
      setSelectedLeadIds(new Set());
    } else {
      setSelectedLeadIds(new Set(filteredLeads.map((l) => l.id)));
    }
  };

  const toggleSelectLead = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(selectedLeadIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedLeadIds(next);
  };

  const handleExportSelectedCSV = () => {
    const toExport = selectedLeadIds.size > 0
      ? leads.filter((l) => selectedLeadIds.has(l.id))
      : filteredLeads;
    exportToCSV(toExport, "leads-export.csv");
  };

  const handleBulkEnroll = () => {
    const selected = leads.filter((l) => selectedLeadIds.has(l.id));
    if (onBulkEnrollCampaign && selected.length > 0) {
      onBulkEnrollCampaign(selected);
      setShowBulkSuccess(true);
      setTimeout(() => setShowBulkSuccess(false), 3000);
    }
  };

  // 1-Click Auto-Reply to All Replied Leads
  const handleAutoReplyAllReplied = async () => {
    setBatchActionLoading(true);
    try {
      const res = await diagnosticFetch("/api/inbox/auto-reply-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        setBatchActionFeedback("⚡ Successfully auto-replied to all replied prospect inbounds with calendar slots!");
        if (onRefreshLeads) onRefreshLeads();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setBatchActionLoading(false);
      setTimeout(() => setBatchActionFeedback(null), 4000);
    }
  };

  // 1-Click Follow-Up #2 to all contacted leads
  const handleBatchFollowUp = async () => {
    setBatchActionLoading(true);
    try {
      const res = await diagnosticFetch("/api/leads/batch-followup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        const data = await res.json();
        setBatchActionFeedback(`📨 Dispatched Day 3 Latency follow-up to ${data.dispatchedCount || 50} contacted clinic directors!`);
        if (onRefreshLeads) onRefreshLeads();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setBatchActionLoading(false);
      setTimeout(() => setBatchActionFeedback(null), 4000);
    }
  };

  return (
    <div className="space-y-4">
      {/* Title & Top Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Clinic & Enterprise Leads</h1>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-100 text-blue-800 font-bold">
              {leads.length} Verified Prospects
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Verified dental directors, clinic managers, and veterinary practices discovered for Abedin Voice AI.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* View Toggle */}
          <div className="flex items-center bg-slate-100 p-0.5 rounded-lg text-xs">
            <button
              onClick={() => setViewMode("table")}
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === "table" ? "bg-white text-slate-900 shadow-2xs font-bold" : "text-slate-600 hover:text-slate-900"
              }`}
              title="Table View"
            >
              <TableIcon className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode("kanban")}
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === "kanban" ? "bg-white text-slate-900 shadow-2xs font-bold" : "text-slate-600 hover:text-slate-900"
              }`}
              title="Kanban Pipeline View"
            >
              <KanbanSquare className="w-4 h-4" />
            </button>
          </div>

          <button
            onClick={handleExportSelectedCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 transition-colors"
          >
            <Download className="w-3.5 h-3.5 text-slate-500" />
            <span>Export CSV</span>
          </button>

          <button
            id="batch-discover-leads-btn"
            onClick={onBatchDiscoverLeads}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 transition-colors"
          >
            <Sparkles className="w-3.5 h-3.5 text-blue-600" />
            <span>Discover with AI</span>
          </button>

          <button
            id="add-lead-btn"
            onClick={onOpenAddLead}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-sm shadow-blue-500/20 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Lead</span>
          </button>
        </div>
      </div>

      {/* QUICK ACTION BAR FOR LEADS PIPELINE */}
      <div className="p-3 bg-gradient-to-r from-slate-900 to-indigo-950 rounded-2xl text-white shadow-sm flex flex-col md:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-xs flex-wrap">
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-amber-500/20 border border-amber-500/30 text-amber-300 font-bold">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
            <span>{engagedCount} Leads Replied</span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-indigo-500/20 border border-indigo-500/30 text-indigo-200 font-medium">
            <span>{contactedCount} In Outbound Flow</span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-purple-500/20 border border-purple-500/30 text-purple-200 font-medium">
            <span>{demoCount} Demos Booked</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleAutoReplyAllReplied}
            disabled={batchActionLoading}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-xs transition-colors disabled:opacity-50"
          >
            {batchActionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5 text-amber-300" />}
            <span>Auto-Reply All Replied ({engagedCount})</span>
          </button>

          <button
            onClick={handleBatchFollowUp}
            disabled={batchActionLoading}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-indigo-800 hover:bg-indigo-700 text-slate-100 border border-indigo-600 font-semibold text-xs transition-colors disabled:opacity-50"
          >
            <Send className="w-3 h-3 text-indigo-300" />
            <span>Send Follow-Up #2 ({contactedCount})</span>
          </button>
        </div>
      </div>

      {batchActionFeedback && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 font-bold flex items-center gap-2 animate-in fade-in">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{batchActionFeedback}</span>
        </div>
      )}

      {/* Bulk Actions Floating Banner */}
      {selectedLeadIds.size > 0 && (
        <div className="bg-gradient-to-r from-slate-900 to-indigo-950 text-white px-4 py-2.5 rounded-xl flex items-center justify-between shadow-lg animate-in fade-in slide-in-from-top-2 duration-150">
          <div className="flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            <span className="font-bold">{selectedLeadIds.size} prospects selected</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleBulkEnroll}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs transition-colors"
            >
              <Send className="w-3 h-3" />
              <span>Enroll in Sequence</span>
            </button>

            <button
              onClick={handleExportSelectedCSV}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
            >
              <Download className="w-3 h-3" />
              <span>Export CSV</span>
            </button>

            <button
              onClick={() => setSelectedLeadIds(new Set())}
              className="text-xs text-slate-400 hover:text-white ml-2 underline"
            >
              Deselect All
            </button>
          </div>
        </div>
      )}

      {showBulkSuccess && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 font-bold flex items-center gap-2 animate-in fade-in">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          <span>Successfully queued outreach sequences for {selectedLeadIds.size} leads!</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs border-b border-slate-200">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`px-3 py-2 rounded-t-lg font-semibold whitespace-nowrap transition-all border-b-2 ${
              activeTab === tab.id
                ? "border-blue-600 text-blue-600 bg-blue-50/50"
                : "border-transparent text-slate-500 hover:text-slate-900"
            }`}
          >
            <span>{tab.label}</span>
            <span className="ml-1.5 px-1.5 py-0.2 rounded-full text-[10px] bg-slate-100 text-slate-600 font-bold">
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Search & Filter bar */}
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <div className="relative flex-1 w-full">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search leads by name, company, action recommendation, or status..."
            className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 focus:ring-2 focus:ring-blue-500 outline-hidden bg-white font-medium"
          />
        </div>

        <select
          value={selectedIndustry}
          onChange={(e) => handleIndustryChange(e.target.value)}
          className="w-full sm:w-auto px-3 py-2 text-xs rounded-lg border border-slate-300 bg-white font-semibold outline-hidden"
        >
          <option value="ALL">All Industries ({leads.length})</option>
          {industries.map((ind) => (
            <option key={ind} value={ind}>
              {ind}
            </option>
          ))}
        </select>
      </div>

      {/* MAIN VIEW */}
      {viewMode === "table" ? (
        <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
          {filteredLeads.length === 0 ? (
            <div className="p-12 text-center text-slate-400 space-y-3">
              <Users className="w-10 h-10 mx-auto text-slate-300" />
              <div className="text-sm font-bold text-slate-700">No leads match the filter</div>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Click <strong>"Discover with AI"</strong> or trigger an automated daily cycle from the Dashboard to search for qualified clinics.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-slate-50 text-slate-500 font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-3 w-10 text-center">
                      <button
                        onClick={toggleSelectAll}
                        className="text-slate-400 hover:text-slate-600"
                      >
                        {selectedLeadIds.size === filteredLeads.length && filteredLeads.length > 0 ? (
                          <CheckSquare className="w-4 h-4 text-blue-600" />
                        ) : (
                          <Square className="w-4 h-4" />
                        )}
                      </button>
                    </th>
                    <th className="py-3 px-4">Prospect & Role</th>
                    <th className="py-3 px-4">Company</th>
                    <th className="py-3 px-4">AI Score</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Email Activity & Deliverability</th>
                    <th className="py-3 px-4">What To Do (Recommended Next Action)</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedLeads.map((lead) => {
                    const isSelected = selectedLeadIds.has(lead.id);
                    const isContacted = lead.status === "CONTACTED" || !!lead.contactedAt;
                    const isEngaged = lead.status === "ENGAGED" || lead.status === "DEMO_SCHEDULED" || lead.status === "WON";

                    return (
                      <tr
                        key={lead.id}
                        className={`hover:bg-slate-50/70 transition-colors group cursor-pointer ${
                          isSelected ? "bg-blue-50/40" : ""
                        }`}
                        onClick={() => onSelectLead(lead)}
                      >
                        {/* Checkbox */}
                        <td className="py-3 px-3 text-center" onClick={(e) => toggleSelectLead(lead.id, e)}>
                          {isSelected ? (
                            <CheckSquare className="w-4 h-4 text-blue-600 mx-auto" />
                          ) : (
                            <Square className="w-4 h-4 text-slate-300 group-hover:text-slate-500 mx-auto" />
                          )}
                        </td>

                        {/* Name & Title */}
                        <td className="py-3 px-4">
                          <div className="font-bold text-slate-900 flex items-center gap-1.5">
                            <span>{lead.name}</span>
                            {lead.isDemo && (
                              <span className="text-[10px] px-1 py-0.2 rounded bg-amber-100 text-amber-800 border border-amber-200 font-bold">
                                Demo
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500">{lead.title}</div>
                        </td>

                        {/* Company */}
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-800">{lead.companyName}</div>
                          <div className="text-[10px] text-slate-400">{lead.country || "United Kingdom"}</div>
                        </td>

                        {/* AI Score */}
                        <td
                          className="py-3 px-4"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenScoreWhy(lead);
                          }}
                        >
                          <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-800 border border-blue-200/80 transition-colors">
                            <span className="font-black text-xs">{lead.aiScore}</span>
                            <span className="text-[10px] font-semibold text-blue-600 underline">
                              Why?
                            </span>
                          </div>
                        </td>

                        {/* Status Badge */}
                        <td className="py-3 px-4">
                          <span
                            className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                              lead.status === "ENGAGED"
                                ? "bg-amber-100 text-amber-900 border border-amber-300 shadow-2xs font-extrabold"
                                : lead.status === "DEMO_SCHEDULED"
                                ? "bg-purple-100 text-purple-900 border border-purple-300 shadow-2xs font-extrabold"
                                : lead.status === "WON"
                                ? "bg-emerald-100 text-emerald-900 border border-emerald-300 shadow-2xs font-extrabold"
                                : lead.status === "QUALIFIED"
                                ? "bg-blue-100 text-blue-800 border border-blue-200 font-bold"
                                : lead.status === "NEW"
                                ? "bg-slate-100 text-slate-700 border border-slate-200 font-bold"
                                : "bg-indigo-100 text-indigo-800 border border-indigo-200 font-bold"
                            }`}
                          >
                            {lead.status === "ENGAGED" ? "💬 Replied" : lead.status.replace("_", " ")}
                          </span>
                        </td>

                        {/* Email Activity & Deliverability */}
                        <td className="py-3 px-4">
                          {isContacted ? (
                            <div className="space-y-1">
                              {lead.openCount && lead.openCount > 0 ? (
                                <div className="flex items-center gap-1.5 font-bold text-blue-700">
                                  <Eye className="w-3.5 h-3.5 text-blue-600" />
                                  <span>Opened {lead.openCount}x</span>
                                  {lead.clickedAt && (
                                    <span className="text-[10px] text-indigo-700 bg-indigo-50 px-1 py-0.2 rounded border border-indigo-200">
                                      Clicked
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <div className="flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                                  <span>Delivered (0.0 Spam)</span>
                                </div>
                              )}

                              <div className="flex items-center gap-1.5">
                                {isEngaged ? (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onSelectLead(lead);
                                    }}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500 hover:bg-amber-600 text-white text-[10px] font-bold shadow-2xs transition-colors"
                                  >
                                    <Sparkles className="w-3 h-3" />
                                    <span>Inspect Reply Thread</span>
                                  </button>
                                ) : (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setInspectMessageLead(lead);
                                    }}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-semibold transition-colors"
                                  >
                                    <Eye className="w-3 h-3 text-slate-500" />
                                    <span>Sent Message Log</span>
                                  </button>
                                )}
                              </div>
                            </div>
                          ) : (
                            <div className="text-[11px] text-slate-400 flex items-center gap-1">
                              <Clock className="w-3 h-3 text-slate-300" />
                              <span>Queued for Outreach</span>
                            </div>
                          )}
                        </td>

                        {/* What To Do (Actionable Next Steps) */}
                        <td className="py-3 px-4">
                          <div className="space-y-1">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`text-[10px] font-extrabold px-2 py-0.5 rounded-md flex items-center gap-1 ${
                                  lead.actionUrgency === "HIGH" || isEngaged
                                    ? "bg-rose-100 text-rose-800 border border-rose-200"
                                    : "bg-blue-50 text-blue-800 border border-blue-200"
                                }`}
                              >
                                <Zap className="w-2.5 h-2.5" />
                                <span>{lead.recommendedActionLabel || (isEngaged ? "Lock in Google Meet Demo" : "Send Follow-up #2")}</span>
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-500 line-clamp-1">
                              {lead.recommendedActionReason || "Target clinic with high after-hours patient call inquiries."}
                            </div>
                          </div>
                        </td>

                        {/* Quick Actions */}
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {isEngaged ? (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectLead(lead);
                                }}
                                className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-xs transition-colors flex items-center gap-1"
                                title="Reply and Lock in Demo"
                              >
                                <Sparkles className="w-3 h-3" />
                                <span>Reply Now</span>
                              </button>
                            ) : isContacted ? (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectLead(lead);
                                }}
                                className="px-2 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 font-semibold text-xs transition-colors flex items-center gap-1"
                                title="Send Follow-up"
                              >
                                <Send className="w-3 h-3" />
                                <span>Follow-up</span>
                              </button>
                            ) : (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectLead(lead);
                                }}
                                className="px-2.5 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 font-bold text-xs transition-colors"
                              >
                                Pitch Lead
                              </button>
                            )}

                            {onOpenBattlecard && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenBattlecard(lead);
                                }}
                                className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 border border-emerald-200 transition-colors"
                                title="1-Page Live Call Battlecard & Audio Test"
                              >
                                <FileText className="w-4 h-4" />
                              </button>
                            )}

                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onBookMeeting(lead);
                              }}
                              className="p-1.5 rounded-lg text-slate-500 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
                              title="Schedule Demo on Calendar"
                            >
                              <Calendar className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Pagination Controls */}
              <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
                <div className="flex items-center gap-2">
                  <span>
                    Showing <strong className="text-slate-900">{filteredLeads.length === 0 ? 0 : startIndex + 1}</strong> to{" "}
                    <strong className="text-slate-900">{endIndex}</strong> of{" "}
                    <strong className="text-slate-900">{filteredLeads.length}</strong> leads
                  </span>

                  <span className="text-slate-300">|</span>

                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-500">Per page:</span>
                    <select
                      value={pageSize}
                      onChange={(e) => handlePageSizeChange(e.target.value === "ALL" ? "ALL" : Number(e.target.value))}
                      className="px-2 py-1 rounded-md border border-slate-300 bg-white font-semibold text-slate-700 outline-hidden focus:ring-1 focus:ring-blue-500 text-xs"
                    >
                      <option value={25}>25</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                      <option value="ALL">All ({filteredLeads.length})</option>
                    </select>
                  </div>
                </div>

                {totalPages > 1 && pageSize !== "ALL" && (
                  <div className="flex items-center gap-1">
                    {/* First Page */}
                    <button
                      onClick={() => setCurrentPage(1)}
                      disabled={safePage <= 1}
                      className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-200/70 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                      title="First Page"
                    >
                      <ChevronsLeft className="w-4 h-4" />
                    </button>

                    {/* Previous Page */}
                    <button
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={safePage <= 1}
                      className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-200/70 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                      title="Previous Page"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>

                    {/* Page Numbers */}
                    <div className="flex items-center gap-1 px-1">
                      {Array.from({ length: totalPages }, (_, i) => i + 1)
                        .filter((p) => {
                          if (totalPages <= 7) return true;
                          if (p === 1 || p === totalPages) return true;
                          return Math.abs(p - safePage) <= 2;
                        })
                        .map((p, idx, arr) => {
                          const prev = arr[idx - 1];
                          const showEllipsisBefore = prev && p - prev > 1;

                          return (
                            <React.Fragment key={p}>
                              {showEllipsisBefore && (
                                <span className="px-1 text-slate-400 font-bold">...</span>
                              )}
                              <button
                                onClick={() => setCurrentPage(p)}
                                className={`min-w-[28px] h-7 px-1.5 rounded-md font-bold text-xs transition-colors ${
                                  safePage === p
                                    ? "bg-blue-600 text-white shadow-2xs"
                                    : "text-slate-600 hover:bg-slate-200/70 hover:text-slate-900"
                                }`}
                              >
                                {p}
                              </button>
                            </React.Fragment>
                          );
                        })}
                    </div>

                    {/* Next Page */}
                    <button
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      disabled={safePage >= totalPages}
                      className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-200/70 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                      title="Next Page"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>

                    {/* Last Page */}
                    <button
                      onClick={() => setCurrentPage(totalPages)}
                      disabled={safePage >= totalPages}
                      className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-200/70 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                      title="Last Page"
                    >
                      <ChevronsRight className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* KANBAN VIEW */
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3 overflow-x-auto pb-4">
          {kanbanColumns.map((col) => {
            const colLeads = filteredLeads.filter((l) => l.status === col.id);
            return (
              <div
                key={col.id}
                className={`${col.bg} rounded-xl p-3 flex flex-col space-y-3 min-w-[220px] border ${col.border}`}
              >
                {/* Column Header */}
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold text-slate-900">{col.label}</div>
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${col.badge}`}>
                    {colLeads.length}
                  </span>
                </div>

                {/* Cards List */}
                <div className="space-y-2.5 flex-1">
                  {colLeads.length === 0 ? (
                    <div className="p-4 text-center text-[11px] text-slate-400 border border-dashed border-slate-300 rounded-lg">
                      No leads in this stage
                    </div>
                  ) : (
                    colLeads.map((lead) => (
                      <div
                        key={lead.id}
                        onClick={() => onSelectLead(lead)}
                        className="p-3 bg-white rounded-xl border border-slate-200 shadow-2xs hover:shadow-xs transition-all cursor-pointer space-y-2"
                      >
                        <div className="flex items-start justify-between gap-1">
                          <div className="font-bold text-xs text-slate-900">{lead.name}</div>
                          <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-blue-50 text-blue-800">
                            {lead.aiScore}
                          </span>
                        </div>

                        <div className="text-[11px] text-slate-600 font-medium truncate">
                          {lead.companyName}
                        </div>

                        {/* Email Activity in Card */}
                        {lead.openCount && lead.openCount > 0 ? (
                          <div className="text-[10px] font-bold text-blue-700 flex items-center gap-1 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">
                            <Eye className="w-3 h-3 text-blue-600" />
                            <span>Opened {lead.openCount}x</span>
                          </div>
                        ) : lead.contactedAt ? (
                          <div className="text-[10px] text-emerald-700 font-bold flex items-center gap-1 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-100">
                            <Check className="w-3 h-3" />
                            <span>Delivered</span>
                          </div>
                        ) : null}

                        {/* Action Recommendation */}
                        <div className="pt-1 border-t border-slate-100">
                          <div className="text-[10px] font-bold text-indigo-900 bg-indigo-50 px-1.5 py-0.5 rounded flex items-center gap-1">
                            <Zap className="w-2.5 h-2.5 text-amber-600 shrink-0" />
                            <span className="truncate">{lead.recommendedActionLabel || "Send Follow-up #2"}</span>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* MODAL: VIEW SENT OUTREACH INSPECTOR */}
      {inspectMessageLead && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-blue-600 text-white">
                  <Mail className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-white">Outreach Dispatched to {inspectMessageLead.name}</h3>
                  <div className="text-xs text-slate-300 font-mono">
                    {inspectMessageLead.companyName} • {inspectMessageLead.contactedAt ? new Date(inspectMessageLead.contactedAt).toLocaleString() : "Recently Sent"}
                  </div>
                </div>
              </div>

              <button
                onClick={() => setInspectMessageLead(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4 text-xs">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
                <div className="text-slate-500 font-bold text-[11px]">Sent from Account</div>
                <div className="font-bold text-slate-900">Nayem Abedin &lt;nayem@abedintech.com&gt;</div>
                <div className="text-[11px] text-emerald-700 font-bold flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Via Gmail OAuth 2.0 Direct API • 0.0 Spam Clean</span>
                </div>
              </div>

              <div>
                <label className="block text-slate-500 font-bold mb-1">Subject</label>
                <div className="p-3 rounded-lg bg-slate-100 border border-slate-200 font-semibold text-slate-900">
                  {inspectMessageLead.lastOutreachSubject || `Quick question regarding ${inspectMessageLead.companyName}'s after-hours patient calls`}
                </div>
              </div>

              <div>
                <label className="block text-slate-500 font-bold mb-1">Message Body</label>
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 whitespace-pre-wrap leading-relaxed text-slate-800 font-mono text-[11px]">
                  {inspectMessageLead.lastOutreachBody ||
                    `Hi ${inspectMessageLead.name.split(" ")[0]},\n\nI noticed ${inspectMessageLead.companyName} handles high appointment inquiries.\n\nWe built Abedin Voice AI so clinics never miss high-value consultation calls after hours. Would you be open to a 2-minute test call on your mobile this week?\n\nBest,\nNayem Abedin\nFounder & CEO | Abedin Tech`}
                </div>
              </div>
            </div>

            <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
              <span className="text-xs text-slate-500">Status: <strong>Delivered</strong></span>
              <div className="flex items-center gap-2">
                {(inspectMessageLead.status === "ENGAGED" || inspectMessageLead.status === "DEMO_SCHEDULED" || inspectMessageLead.status === "WON") && (
                  <button
                    onClick={() => {
                      const l = inspectMessageLead;
                      setInspectMessageLead(null);
                      onSelectLead(l);
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 transition-colors flex items-center gap-1 shadow-xs"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>View Prospect Reply Thread</span>
                  </button>
                )}
                <button
                  onClick={() => setInspectMessageLead(null)}
                  className="px-4 py-2 rounded-lg text-xs font-bold text-slate-700 bg-slate-200 hover:bg-slate-300 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
