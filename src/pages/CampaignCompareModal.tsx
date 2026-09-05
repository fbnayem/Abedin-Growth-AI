import React from "react";
import { X, TrendingUp, Users, Target } from "lucide-react";
import { Campaign } from "../types";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { generateMockChartData } from "./CampaignsView";

interface CampaignCompareModalProps {
  isOpen: boolean;
  onClose: () => void;
  campaign1: Campaign | null;
  campaign2: Campaign | null;
}

export const CampaignCompareModal: React.FC<CampaignCompareModalProps> = ({
  isOpen,
  onClose,
  campaign1,
  campaign2,
}) => {
  if (!isOpen || !campaign1 || !campaign2) return null;

  const renderCampaignColumn = (camp: Campaign, colorHex: string, secColorHex: string) => {
    const data = generateMockChartData(camp.enrolledCount, camp.id);
    const winRate = camp.enrolledCount > 0 ? Math.round((camp.convertedCount / camp.enrolledCount) * 100) : 0;
    const engagementRate = camp.sentCount > 0 ? Math.round((camp.openedCount / camp.sentCount) * 100) : 0;
    
    return (
      <div className="flex-1 flex flex-col space-y-4">
        <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-900">{camp.name}</h3>
            <div className="text-xs text-slate-500 mt-1">Target: {camp.targetAudience}</div>
          </div>
          <span className="px-2 py-1 rounded-md text-[10px] font-bold uppercase bg-slate-100 text-slate-600">
            {camp.status}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="p-4 bg-white rounded-xl border border-slate-200 flex flex-col items-center justify-center text-center">
            <div className="text-xs font-bold text-slate-400 uppercase">Conversion Rate</div>
            <div className="text-2xl font-black mt-1" style={{ color: colorHex }}>{winRate}%</div>
            <div className="text-[10px] text-slate-500 mt-1">{camp.convertedCount} Demos / {camp.enrolledCount} Leads</div>
          </div>
          <div className="p-4 bg-white rounded-xl border border-slate-200 flex flex-col items-center justify-center text-center">
            <div className="text-xs font-bold text-slate-400 uppercase">Engagement Rate</div>
            <div className="text-2xl font-black mt-1" style={{ color: secColorHex }}>{engagementRate}%</div>
            <div className="text-[10px] text-slate-500 mt-1">{camp.openedCount} Opens / {camp.sentCount} Sent</div>
          </div>
        </div>

        <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs flex-1 flex flex-col min-h-[250px]">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-4 flex items-center gap-1.5">
            <TrendingUp className="w-4 h-4" />
            30-Day Performance Comparison
          </div>
          <div className="flex-1 w-full min-h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis 
                  dataKey="date" 
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                  dy={10}
                  minTickGap={20}
                />
                <YAxis 
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                  dx={-10}
                />
                <Tooltip 
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)', fontSize: '12px' }}
                />
                <Line 
                  type="monotone" 
                  name="Engagement"
                  dataKey="engagement" 
                  stroke={secColorHex} 
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line 
                  type="monotone" 
                  name="Conversion"
                  dataKey="conversion" 
                  stroke={colorHex} 
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="bg-slate-50 rounded-2xl shadow-2xl w-full max-w-6xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[95vh]">
        {/* Header */}
        <div className="px-6 py-4 bg-white border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
              <Target className="w-5 h-5 text-purple-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 leading-tight">Campaign Comparison</h2>
              <p className="text-xs text-slate-500">Side-by-side performance analysis</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto">
          <div className="flex flex-col lg:flex-row gap-6">
            {renderCampaignColumn(campaign1, "#10b981", "#3b82f6")}
            {/* Divider */}
            <div className="hidden lg:flex w-px bg-slate-200 self-stretch my-4"></div>
            {renderCampaignColumn(campaign2, "#8b5cf6", "#f43f5e")}
          </div>
        </div>
      </div>
    </div>
  );
};
