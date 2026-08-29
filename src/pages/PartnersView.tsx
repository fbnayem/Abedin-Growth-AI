import React, { useState } from "react";
import {
  Handshake,
  Search,
  Plus,
  Sparkles,
  HelpCircle,
  Mail,
  Calendar,
  Building,
  DollarSign,
  Percent,
  Download,
  KanbanSquare,
  Table as TableIcon,
  CheckSquare,
  Square
} from "lucide-react";
import { Partner, PartnerStatus } from "../types";
import { exportToCSV } from "../utils/exportUtils";

interface PartnersViewProps {
  partners: Partner[];
  onOpenScoreWhy: (partner: Partner) => void;
  onSelectPartner: (partner: Partner) => void;
  onBookMeeting: (partner: Partner) => void;
  onAddPartner: () => void;
  onDiscoverPartners?: () => void;
}

export const PartnersView: React.FC<PartnersViewProps> = ({
  partners,
  onOpenScoreWhy,
  onSelectPartner,
  onBookMeeting,
  onAddPartner,
  onDiscoverPartners,
}) => {
  const [viewMode, setViewMode] = useState<"table" | "kanban">("table");
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const kanbanColumns: { id: PartnerStatus; label: string; bg: string; border: string; badge: string }[] = [
    { id: "DISCOVERED", label: "Identified Agency", bg: "bg-slate-50", border: "border-slate-200", badge: "bg-slate-200 text-slate-800" },
    { id: "QUALIFIED", label: "Rev-Share Fit", bg: "bg-emerald-50/50", border: "border-emerald-200", badge: "bg-emerald-100 text-emerald-800" },
    { id: "CONTACTED", label: "Outreach Sent", bg: "bg-blue-50/50", border: "border-blue-200", badge: "bg-blue-100 text-blue-800" },
    { id: "CONVERSATION", label: "Active Talk", bg: "bg-amber-50/50", border: "border-amber-200", badge: "bg-amber-100 text-amber-800" },
    { id: "PROPOSAL", label: "Agreement Sent", bg: "bg-purple-50/50", border: "border-purple-200", badge: "bg-purple-100 text-purple-800" },
    { id: "ACTIVE_PARTNER", label: "Active Partner", bg: "bg-emerald-100/50", border: "border-emerald-300", badge: "bg-emerald-200 text-emerald-900" },
  ];

  const filteredPartners = partners.filter((p) => {
    if (typeFilter !== "ALL" && p.partnerType !== typeFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.companyName.toLowerCase().includes(q) ||
        p.country.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredPartners.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredPartners.map((p) => p.id)));
    }
  };

  const toggleSelect = (id: string, e: React.MouseEvent) => {
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
      ? partners.filter((p) => selectedIds.has(p.id))
      : filteredPartners;

    exportToCSV(toExport, "Abedin_Channel_Partners", {
      name: "Decision Maker",
      companyName: "Agency / Reseller",
      partnerType: "Partner Type",
      role: "Role",
      country: "Location",
      partnerFitScore: "Fit Score",
      potentialCollaboration: "Collaboration Angle",
      revenueModel: "Revenue Model",
      status: "Partner Status",
    });
  };

  return (
    <div className="space-y-5">
      {/* Title & Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Partner Network</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold">
              {partners.length} Potential Partners
            </span>
            {selectedIds.size > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-600 text-white font-bold animate-pulse">
                {selectedIds.size} Selected
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Recruiting Marketing Agencies, Telecom Resellers, and BPO Providers for recurring rev-share expansion.
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

          {onDiscoverPartners && (
            <button
              id="batch-discover-partners-btn"
              onClick={onDiscoverPartners}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
              <span>Discover with AI</span>
            </button>
          )}

          <button
            id="add-partner-btn"
            onClick={onAddPartner}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 shadow-sm transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Partner</span>
          </button>
        </div>
      </div>

      {/* Search & Filter */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search partners, agencies, consultants..."
            className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 focus:ring-2 focus:ring-emerald-500 outline-hidden bg-white font-medium"
          />
        </div>

        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-3 py-2 text-xs rounded-lg border border-slate-300 bg-white font-medium text-slate-700 outline-hidden focus:ring-2 focus:ring-emerald-500"
        >
          <option value="ALL">All Partner Types</option>
          <option value="AGENCY">Marketing / Dev Agency</option>
          <option value="RESELLER">Telecom / Software Reseller</option>
          <option value="BPO_CALL_CENTER">BPO / Call Center</option>
          <option value="CRM_CONSULTANT">CRM Consultant</option>
          <option value="STRATEGIC">Strategic</option>
        </select>
      </div>

      {/* VIEW MODE 1: Table */}
      {viewMode === "table" ? (
        <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
          {filteredPartners.length === 0 ? (
            <div className="py-16 text-center space-y-3">
              <Handshake className="w-10 h-10 text-slate-300 mx-auto" />
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-slate-800">No partners found</h3>
                <p className="text-xs text-slate-500 max-w-sm mx-auto">
                  Click below to discover agency partners matching your revenue-share criteria.
                </p>
              </div>
              {onDiscoverPartners && (
                <button
                  onClick={onDiscoverPartners}
                  className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow-sm transition-colors"
                >
                  Discover Partners with AI
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
                        {selectedIds.size > 0 && selectedIds.size === filteredPartners.length ? (
                          <CheckSquare className="w-4 h-4 text-emerald-600" />
                        ) : (
                          <Square className="w-4 h-4" />
                        )}
                      </button>
                    </th>
                    <th className="py-3 px-4">Decision Maker</th>
                    <th className="py-3 px-4">Agency / Partner</th>
                    <th className="py-3 px-4">Partner Type</th>
                    <th className="py-3 px-4">Revenue Model</th>
                    <th className="py-3 px-4">Fit Score</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredPartners.map((partner) => {
                    const isSelected = selectedIds.has(partner.id);
                    return (
                      <tr
                        key={partner.id}
                        className={`hover:bg-slate-50/70 transition-colors group cursor-pointer ${
                          isSelected ? "bg-emerald-50/40" : ""
                        }`}
                        onClick={() => onSelectPartner(partner)}
                      >
                        <td className="py-3 px-3 text-center" onClick={(e) => toggleSelect(partner.id, e)}>
                          {isSelected ? (
                            <CheckSquare className="w-4 h-4 text-emerald-600 mx-auto" />
                          ) : (
                            <Square className="w-4 h-4 text-slate-300 group-hover:text-slate-500 mx-auto" />
                          )}
                        </td>

                        <td className="py-3 px-4">
                          <div className="font-bold text-slate-900">{partner.name}</div>
                          <div className="text-[11px] text-slate-500">{partner.role}</div>
                        </td>

                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-800">{partner.companyName}</div>
                          <div className="text-[11px] text-slate-400">{partner.country}</div>
                        </td>

                        <td className="py-3 px-4">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
                            {partner.partnerType}
                          </span>
                        </td>

                        <td className="py-3 px-4 text-emerald-800 font-semibold text-[11px]">
                          {partner.revenueModel}
                        </td>

                        <td
                          className="py-3 px-4"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenScoreWhy(partner);
                          }}
                        >
                          <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200/80 transition-colors">
                            <span className="font-black text-xs">{partner.partnerFitScore}</span>
                            <span className="text-[10px] font-semibold text-emerald-600 underline">
                              Why?
                            </span>
                          </div>
                        </td>

                        <td className="py-3 px-4">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800 border border-emerald-200">
                            {partner.status}
                          </span>
                        </td>

                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onBookMeeting(partner);
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
            const colItems = filteredPartners.filter((p) => p.status === col.id);
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
                      No partners in stage
                    </div>
                  ) : (
                    colItems.map((p) => (
                      <div
                        key={p.id}
                        onClick={() => onSelectPartner(p)}
                        className="p-3 rounded-xl bg-white border border-slate-200/90 shadow-2xs hover:shadow-xs transition-all space-y-2 cursor-pointer group"
                      >
                        <div className="flex items-start justify-between gap-1">
                          <h4 className="text-xs font-bold text-slate-900 group-hover:text-emerald-600 transition-colors line-clamp-1">
                            {p.name}
                          </h4>
                          <span className="text-[10px] font-black text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                            {p.partnerFitScore}
                          </span>
                        </div>

                        <p className="text-[11px] text-slate-600 font-medium truncate">
                          {p.role} • {p.companyName}
                        </p>

                        <div className="text-[10px] text-emerald-700 font-semibold truncate pt-1 border-t border-slate-100">
                          {p.revenueModel}
                        </div>

                        <div className="flex items-center justify-end pt-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onBookMeeting(p);
                            }}
                            className="px-2 py-1 rounded text-[10px] font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 flex items-center gap-1"
                          >
                            <Calendar className="w-3 h-3" />
                            <span>Book Call</span>
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
