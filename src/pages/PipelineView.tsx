import React, { useState } from "react";
import {
  KanbanSquare,
  Plus,
  DollarSign,
  Calendar,
  Sparkles,
  ChevronRight,
  MoreHorizontal,
  Building,
  User,
} from "lucide-react";
import { Opportunity, PipelineStage } from "../types";

interface PipelineViewProps {
  opportunities: Opportunity[];
  onUpdateStage: (oppId: string, newStage: PipelineStage) => void;
  onAddOpportunity: () => void;
}

export const PipelineView: React.FC<PipelineViewProps> = ({
  opportunities,
  onUpdateStage,
  onAddOpportunity,
}) => {
  const stages: { id: PipelineStage; label: string; color: string }[] = [
    { id: "QUALIFIED", label: "Qualified", color: "blue" },
    { id: "MEETING_SCHEDULED", label: "Meeting Scheduled", color: "indigo" },
    { id: "DEMO_COMPLETED", label: "Demo Completed", color: "purple" },
    { id: "PROPOSAL_SENT", label: "Proposal Sent", color: "amber" },
    { id: "WON", label: "Closed Won", color: "emerald" },
  ];

  const totalValue = opportunities.reduce((sum, o) => sum + o.estimatedValue, 0);

  return (
    <div className="space-y-5">
      {/* Title & Pipeline Metrics */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Revenue Pipeline</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold">
              £{totalValue.toLocaleString()} Total Pipeline
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Real-time visual deal flow across customer licenses, agency rev-share, and seed investment.
          </p>
        </div>

        <button
          onClick={onAddOpportunity}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-sm shadow-blue-500/20 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Opportunity</span>
        </button>
      </div>

      {/* Kanban Board Columns */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3 overflow-x-auto pb-4">
        {stages.map((stage) => {
          const items = opportunities.filter((o) => o.stage === stage.id);
          const stageValue = items.reduce((sum, o) => sum + o.estimatedValue, 0);

          return (
            <div
              key={stage.id}
              className="bg-slate-100/70 rounded-xl p-3 flex flex-col space-y-3 min-w-[220px] border border-slate-200/80"
            >
              {/* Column Header */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-slate-900">{stage.label}</div>
                  <div className="text-[10px] text-slate-500 font-semibold mt-0.5">
                    £{stageValue.toLocaleString()} ({items.length})
                  </div>
                </div>
                <span className="w-2.5 h-2.5 rounded-full bg-blue-600" />
              </div>

              {/* Cards List */}
              <div className="space-y-2.5 flex-1">
                {items.length === 0 ? (
                  <div className="p-4 text-center text-[11px] text-slate-400 border border-dashed border-slate-300 rounded-lg">
                    No deals in this stage
                  </div>
                ) : (
                  items.map((opp) => (
                    <div
                      key={opp.id}
                      className="p-3.5 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-xs transition-all space-y-2.5"
                    >
                      <div className="flex items-start justify-between gap-1">
                        <h4 className="text-xs font-bold text-slate-900 leading-tight">
                          {opp.title}
                        </h4>
                        <span className="text-[11px] font-black text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200 shrink-0">
                          £{opp.estimatedValue.toLocaleString()}
                        </span>
                      </div>

                      <div className="text-[11px] text-slate-500 space-y-0.5">
                        <div className="flex items-center gap-1">
                          <Building className="w-3 h-3 text-slate-400" />
                          <span>{opp.companyName}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <User className="w-3 h-3 text-slate-400" />
                          <span>{opp.contactName}</span>
                        </div>
                      </div>

                      {/* Next Step */}
                      <div className="p-2 bg-slate-50 rounded-lg text-[10px] text-slate-600 border border-slate-100">
                        <span className="font-bold text-slate-800">Next: </span>
                        <span>{opp.nextStep}</span>
                      </div>

                      {/* Stage Move Action */}
                      <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                        <span className="text-[10px] font-semibold text-blue-600">
                          {opp.probability}% Win Prob
                        </span>

                        <select
                          value={opp.stage}
                          onChange={(e) => onUpdateStage(opp.id, e.target.value as PipelineStage)}
                          className="text-[10px] font-semibold bg-slate-100 hover:bg-slate-200 rounded px-1.5 py-0.5 border border-slate-200 outline-hidden"
                        >
                          {stages.map((s) => (
                            <option key={s.id} value={s.id}>
                              Move to: {s.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
