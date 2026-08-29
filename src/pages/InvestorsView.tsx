import React, { useState } from "react";
import {
  TrendingUp,
  Search,
  Plus,
  Sparkles,
  ShieldAlert,
  HelpCircle,
  Mail,
  Calendar,
  ExternalLink,
  DollarSign,
  Globe,
  Building,
  Download,
  Send,
  KanbanSquare,
  Table as TableIcon,
  CheckSquare,
  Square,
  Swords,
  CheckCircle2,
  Lock,
  FileText
} from "lucide-react";
import { Investor, InvestorStatus } from "../types";
import { exportToCSV } from "../utils/exportUtils";

interface InvestorsViewProps {
  investors: Investor[];
  onOpenScoreWhy: (investor: Investor) => void;
  onSelectInvestor: (investor: Investor) => void;
  onBookMeeting: (investor: Investor) => void;
  onAddInvestor: () => void;
  onDiscoverInvestors?: () => void;
  onOpenPitchSimulator?: (investor: Investor) => void;
  onOpenBattlecard?: (investor: Investor) => void;
}

export const InvestorsView: React.FC<InvestorsViewProps> = ({
  investors,
  onOpenScoreWhy,
  onSelectInvestor,
  onBookMeeting,
  onAddInvestor,
  onDiscoverInvestors,
  onOpenPitchSimulator,
  onOpenBattlecard,
}) => {
  const [viewMode, setViewMode] = useState<"table" | "kanban">("table");
  const [searchQuery, setSearchQuery] = useState("");
  const [stageFilter, setStageFilter] = useState<string>("ALL");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const kanbanColumns: { id: InvestorStatus; label: string; bg: string; border: string; badge: string }[] = [
    { id: "DISCOVERED", label: "Discovered", bg: "bg-slate-50", border: "border-slate-200", badge: "bg-slate-200 text-slate-800" },
    { id: "QUALIFIED", label: "Thesis Match", bg: "bg-indigo-50/50", border: "border-indigo-200", badge: "bg-indigo-100 text-indigo-800" },
    { id: "CONTACTED", label: "Intro Sent", bg: "bg-blue-50/50", border: "border-blue-200", badge: "bg-blue-100 text-blue-800" },
    { id: "REPLIED", label: "Engaged / Call", bg: "bg-amber-50/50", border: "border-amber-200", badge: "bg-amber-100 text-amber-800" },
    { id: "DUE_DILIGENCE", label: "Data Room / DD", bg: "bg-purple-50/50", border: "border-purple-200", badge: "bg-purple-100 text-purple-800" },
    { id: "TERM_SHEET", label: "Term Sheet / Closed", bg: "bg-emerald-50/50", border: "border-emerald-200", badge: "bg-emerald-100 text-emerald-800" },
  ];

  const filteredInvestors = investors.filter((inv) => {
    if (stageFilter !== "ALL" && inv.stage !== stageFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        inv.name.toLowerCase().includes(q) ||
        inv.fundName.toLowerCase().includes(q) ||
        inv.country.toLowerCase().includes(q) ||
        inv.targetSectors?.some((s) => s.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredInvestors.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredInvestors.map((i) => i.id)));
    }
  };

  const toggleSelectInvestor = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const handleExportCSV = () => {
    const toExport = selectedIds.size > 0
      ? investors.filter((i) => selectedIds.has(i.id))
      : filteredInvestors;

    exportToCSV(toExport, "Abedin_Investors_Pipeline", {
      name: "Partner Name",
      fundName: "Fund / Syndicate",
      role: "Role",
      stage: "Investment Stage",
      typicalCheckSize: "Check Size",
      country: "Location",
      investorFitScore: "Thesis Fit Score",
      thesisMatchReason: "Thesis Alignment",
      portfolioFitExample: "Portfolio Synergy",
      recommendedPitchAngle: "Pitch Hook",
    });
  };

  return (
    <div className="space-y-5">
      {/* Title & Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Investor Pipeline</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 font-bold">
              {investors.length} Funds & Angels
            </span>
            {selectedIds.size > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-600 text-white font-bold animate-pulse">
                {selectedIds.size} Selected
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            AI-matched Seed & Pre-Seed investors with interactive pitch battle roleplay and check size radar.
          </p>
        </div>

        <div className="flex items-center flex-wrap gap-2">
          {/* Table vs Kanban */}
          <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
            <button
              onClick={() => setViewMode("table")}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-all ${
                viewMode === "table"
                  ? "bg-white text-slate-900 shadow-2xs font-bold"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              <TableIcon className="w-3.5 h-3.5" />
              <span>Table</span>
            </button>
            <button
              onClick={() => setViewMode("kanban")}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-all ${
                viewMode === "kanban"
                  ? "bg-white text-slate-900 shadow-2xs font-bold"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              <KanbanSquare className="w-3.5 h-3.5" />
              <span>Kanban</span>
            </button>
          </div>

          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 border border-slate-300 shadow-2xs transition-colors"
          >
            <Download className="w-3.5 h-3.5 text-slate-500" />
            <span>Export CSV</span>
          </button>

          {onDiscoverInvestors && (
            <button
              id="batch-discover-investors-btn"
              onClick={onDiscoverInvestors}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
              <span>Discover with AI</span>
            </button>
          )}

          <button
            id="add-investor-btn"
            onClick={onAddInvestor}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 shadow-sm transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Investor</span>
          </button>
        </div>
      </div>

      {/* Sensitive Policy Notice */}
      <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200/90 text-xs text-amber-900 flex items-start gap-2.5">
        <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
        <div className="flex-1">
          <span className="font-bold">Autonomous Policy Guardrails: </span>
          AI researches funds and drafts introductory decks, but cap table, valuation, and term-sheet negotiation remain locked for founder execution.
        </div>
      </div>

      {/* Search Bar & Stage Filter */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search investors by partner name, VC fund, geography, or thesis..."
            className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 focus:ring-2 focus:ring-indigo-500 outline-hidden bg-white font-medium"
          />
        </div>

        <select
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
          className="px-3 py-2 text-xs rounded-lg border border-slate-300 bg-white font-medium text-slate-700 outline-hidden focus:ring-2 focus:ring-indigo-500"
        >
          <option value="ALL">All Stages</option>
          <option value="PRE_SEED">Pre-Seed</option>
          <option value="SEED">Seed</option>
          <option value="SERIES_A">Series A</option>
          <option value="ANGEL">Angel Syndicate</option>
        </select>
      </div>

      {/* VIEW MODE 1: Table */}
      {viewMode === "table" ? (
        <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
          {filteredInvestors.length === 0 ? (
            <div className="py-16 text-center space-y-3">
              <TrendingUp className="w-10 h-10 text-slate-300 mx-auto" />
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-slate-800">No investors found</h3>
                <p className="text-xs text-slate-500 max-w-sm mx-auto">
                  Click below to discover Seed & Pre-Seed funds investing in Voice AI & B2B automation.
                </p>
              </div>
              {onDiscoverInvestors && (
                <button
                  onClick={onDiscoverInvestors}
                  className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm transition-colors"
                >
                  Discover Investors with AI
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50/80 border-b border-slate-200 text-slate-500 uppercase tracking-wider font-bold">
                  <tr>
                    <th className="py-3 px-3 w-10 text-center">
                      <button onClick={toggleSelectAll} className="text-slate-400 hover:text-slate-700">
                        {selectedIds.size > 0 && selectedIds.size === filteredInvestors.length ? (
                          <CheckSquare className="w-4 h-4 text-indigo-600" />
                        ) : (
                          <Square className="w-4 h-4" />
                        )}
                      </button>
                    </th>
                    <th className="py-3 px-4">Partner & Role</th>
                    <th className="py-3 px-4">Fund Name</th>
                    <th className="py-3 px-4">Stage & Check</th>
                    <th className="py-3 px-4">Geography</th>
                    <th className="py-3 px-4">Thesis Fit</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredInvestors.map((inv) => {
                    const isSelected = selectedIds.has(inv.id);
                    return (
                      <tr
                        key={inv.id}
                        className={`hover:bg-slate-50/70 transition-colors group cursor-pointer ${
                          isSelected ? "bg-indigo-50/40" : ""
                        }`}
                        onClick={() => onSelectInvestor(inv)}
                      >
                        <td className="py-3 px-3 text-center" onClick={(e) => toggleSelectInvestor(inv.id, e)}>
                          {isSelected ? (
                            <CheckSquare className="w-4 h-4 text-indigo-600 mx-auto" />
                          ) : (
                            <Square className="w-4 h-4 text-slate-300 group-hover:text-slate-500 mx-auto" />
                          )}
                        </td>

                        <td className="py-3 px-4">
                          <div className="font-bold text-slate-900">{inv.name}</div>
                          <div className="text-[11px] text-slate-500">{inv.role}</div>
                        </td>

                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-800">{inv.fundName}</div>
                          <div className="text-[11px] text-slate-400">
                            {inv.targetSectors?.slice(0, 2).join(", ")}
                          </div>
                        </td>

                        <td className="py-3 px-4">
                          <span className="font-bold text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded text-[11px]">
                            {inv.stage}
                          </span>
                          <div className="text-[11px] text-emerald-700 font-semibold mt-0.5">
                            {inv.typicalCheckSize}
                          </div>
                        </td>

                        <td className="py-3 px-4 text-slate-600">{inv.country}</td>

                        <td
                          className="py-3 px-4"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenScoreWhy(inv);
                          }}
                        >
                          <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-200/80 transition-colors">
                            <span className="font-black text-xs">{inv.investorFitScore}</span>
                            <span className="text-[10px] font-semibold text-indigo-600 underline">
                              Why?
                            </span>
                          </div>
                        </td>

                        <td className="py-3 px-4">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-indigo-100 text-indigo-800 border border-indigo-200">
                            {inv.status}
                          </span>
                        </td>

                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {onOpenBattlecard && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenBattlecard(inv);
                                }}
                                className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 border border-emerald-200 transition-colors"
                                title="1-Page Pre-Flight Call Battlecard"
                              >
                                <FileText className="w-4 h-4" />
                              </button>
                            )}
                            {onOpenPitchSimulator && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenPitchSimulator(inv);
                                }}
                                className="p-1.5 rounded-lg text-indigo-600 hover:bg-indigo-50 border border-indigo-200 transition-colors"
                                title="AI Pitch Battle with VC Partner"
                              >
                                <Swords className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onBookMeeting(inv);
                              }}
                              className="p-1.5 rounded-lg text-slate-500 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
                              title="Schedule Partner Call"
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
            </div>
          )}
        </div>
      ) : (
        /* VIEW MODE 2: Kanban */
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3 overflow-x-auto pb-4">
          {kanbanColumns.map((col) => {
            const colItems = filteredInvestors.filter((i) => i.status === col.id);
            return (
              <div
                key={col.id}
                className={`${col.bg} rounded-xl p-3 flex flex-col space-y-3 min-w-[210px] border ${col.border}`}
              >
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold text-slate-900">{col.label}</div>
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${col.badge}`}>
                    {colItems.length}
                  </span>
                </div>

                <div className="space-y-2.5 flex-1">
                  {colItems.length === 0 ? (
                    <div className="p-4 text-center text-[11px] text-slate-400 border border-dashed border-slate-300 rounded-lg">
                      No funds in stage
                    </div>
                  ) : (
                    colItems.map((inv) => (
                      <div
                        key={inv.id}
                        onClick={() => onSelectInvestor(inv)}
                        className="p-3 rounded-xl bg-white border border-slate-200/90 shadow-2xs hover:shadow-xs transition-all space-y-2 cursor-pointer group"
                      >
                        <div className="flex items-start justify-between gap-1">
                          <h4 className="text-xs font-bold text-slate-900 group-hover:text-indigo-600 transition-colors line-clamp-1">
                            {inv.name}
                          </h4>
                          <span className="text-[10px] font-black text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-200">
                            {inv.investorFitScore}
                          </span>
                        </div>

                        <p className="text-[11px] text-slate-600 font-medium truncate">
                          {inv.role} • {inv.fundName}
                        </p>

                        <div className="text-[10px] text-emerald-700 font-bold flex items-center justify-between pt-1 border-t border-slate-100">
                          <span>{inv.typicalCheckSize}</span>
                          <span className="text-slate-500 font-semibold">{inv.stage}</span>
                        </div>

                        <div className="flex items-center justify-between pt-1 gap-1">
                          {onOpenPitchSimulator && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenPitchSimulator(inv);
                              }}
                              className="px-2 py-1 rounded text-[10px] font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 flex items-center gap-1"
                            >
                              <Swords className="w-3 h-3" />
                              <span>Battle</span>
                            </button>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onBookMeeting(inv);
                            }}
                            className="px-2 py-1 rounded text-[10px] font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 flex items-center gap-1"
                          >
                            <Calendar className="w-3 h-3" />
                            <span>Book</span>
                          </button>
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
    </div>
  );
};
