import React, { useState } from "react";
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
  TrendingDown,
  Minus,
  Filter,
  ArrowDownUp,
  BarChart2,
  AlertCircle,
} from "lucide-react";
import { CampaignCompareModal } from "./CampaignCompareModal";
import { Campaign } from "../types";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";


/**
 * S27 — `generateMockChartData` is deleted.
 *
 * It built a 30-day series from the campaign id and `Math.sin`, `Math.cos` and `Math.random`,
 * under a comment reading "Add realistic-looking sinusoidal noise". It was rendered as a
 * "30-Day Performance Trend" on every active campaign card and in the comparison modal.
 *
 * There is no open pixel, no click redirect and no bounce or complaint webhook anywhere in
 * this system, and it has never sent an autonomous email. So there was no engagement history
 * for a curve to be drawn from, and every point on it was a sine wave seeded by a string.
 *
 * S27's worst case is a founder reading that curve, scaling spend, and reporting the number to
 * an investor. A chart is a stronger claim than a figure: it asserts a shape over time, which
 * is the thing a person extrapolates from.
 *
 * What replaces it says there is nothing to show. That is not a placeholder awaiting data — it
 * is the accurate report of what this system currently knows about engagement.
 */
export const NoEngagementData = ({ label }: { label: string }) => (
  <div className="flex-1 min-h-[160px] w-full bg-slate-50 border border-dashed border-slate-200 rounded-xl p-4 flex flex-col items-center justify-center text-center">
    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</div>
    <div className="text-xs text-slate-500 mt-2 max-w-[260px]">
      Not tracked. There is no open, click or bounce ingestion in this system, so no engagement
      history exists to chart.
    </div>
  </div>
);

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
  const [isCompareMode, setIsCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showCompareModal, setShowCompareModal] = useState(false);
  const [thresholds, setThresholds] = useState<Record<string, number>>({});

  const handleThresholdChange = (campId: string, value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num) && num >= 0 && num <= 100) {
      setThresholds(prev => ({ ...prev, [campId]: num }));
    } else if (value === '') {
      const newT = { ...thresholds };
      delete newT[campId];
      setThresholds(newT);
    }
  };

  const handleCardClick = (id: string) => {
    if (!isCompareMode) return;
    setCompareIds(prev => {
      if (prev.includes(id)) return prev.filter(p => p !== id);
      if (prev.length < 2) return [...prev, id];
      return prev;
    });
  };


  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [sortBy, setSortBy] = useState<string>("date_desc");

  const processedCampaigns = [...campaigns]
    .filter((c) => filterStatus === "ALL" || c.status === filterStatus)
    .sort((a, b) => {
      if (sortBy === "date_desc") return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      if (sortBy === "date_asc") return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
      if (sortBy === "conversion_desc") {
        const aConv = a.enrolledCount > 0 ? a.convertedCount / a.enrolledCount : 0;
        const bConv = b.enrolledCount > 0 ? b.convertedCount / b.enrolledCount : 0;
        return bConv - aConv;
      }
      if (sortBy === "engagement_desc") {
        const aEng = a.sentCount > 0 ? a.openedCount / a.sentCount : 0;
        const bEng = b.sentCount > 0 ? b.openedCount / b.sentCount : 0;
        return bEng - aEng;
      }
      return 0;
    });
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


            {/* Filters & Sorting */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-3 bg-white rounded-xl border border-slate-200 shadow-xs">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          <button
            onClick={() => {
              setIsCompareMode(!isCompareMode);
              setCompareIds([]);
            }}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap transition-colors uppercase flex items-center gap-1.5 mr-2 ${
              isCompareMode
                ? "bg-purple-100 text-purple-700 border border-purple-200"
                : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50"
            }`}
          >
            <BarChart2 className="w-3.5 h-3.5" />
            {isCompareMode ? "Cancel Compare" : "Compare"}
          </button>
          <div className="w-px h-5 bg-slate-200 mx-1"></div>
          <Filter className="w-4 h-4 text-slate-400 mr-1" />
          {["ALL", "ACTIVE", "PAUSED", "COMPLETED", "DRAFT"].map((status) => (
            <button
              key={status}
              onClick={() => setFilterStatus(status)}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap transition-colors uppercase ${
                filterStatus === status
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {status === "ALL" ? "All" : status}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <ArrowDownUp className="w-4 h-4 text-slate-400" />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="pl-3 pr-8 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 cursor-pointer appearance-none"
            style={{ backgroundImage: 'url("data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 20 20\'%3e%3cpath stroke=\'%236b7280\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'1.5\' d=\'M6 8l4 4 4-4\'/%3e%3c/svg%3e")', backgroundPosition: 'right 0.5rem center', backgroundRepeat: 'no-repeat', backgroundSize: '1.5em 1.5em' }}
          >
            <option value="date_desc">Newest First</option>
            <option value="date_asc">Oldest First</option>
            <option value="conversion_desc">Highest Conversion</option>
            <option value="engagement_desc">Highest Engagement</option>
          </select>
        </div>
      </div>

            {/* Campaigns Grid / List */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {processedCampaigns.map((camp) => (
          <div
            key={camp.id}
            onClick={() => handleCardClick(camp.id)}
            className={`flex flex-col p-5 rounded-xl bg-white border shadow-2xs transition-all space-y-4 ${
              isCompareMode ? "cursor-pointer hover:border-purple-300" : "hover:shadow-sm border-slate-200"
            } ${compareIds.includes(camp.id) ? "ring-2 ring-purple-500 border-purple-500 bg-purple-50/10" : ""}`}
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
                                    <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                    {camp.name}
                    {thresholds[camp.id] !== undefined && 
                     ((camp.enrolledCount > 0 ? (camp.convertedCount / camp.enrolledCount) * 100 : 0) < thresholds[camp.id]) && (
                      <div className="relative group flex items-center">
                        <AlertCircle className="w-4 h-4 text-rose-500 animate-pulse" />
                        <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 hidden group-hover:block w-max bg-slate-900 text-white text-[10px] py-1 px-2 rounded font-medium shadow-xl">
                          Conversion Rate ({((camp.enrolledCount > 0 ? (camp.convertedCount / camp.enrolledCount) * 100 : 0)).toFixed(1)}%) is below threshold ({thresholds[camp.id]}%)
                        </div>
                      </div>
                    )}
                  </h3>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                      camp.status === "ACTIVE"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : camp.status === "PAUSED"
                        ? "bg-amber-50 text-amber-700 border-amber-200"
                        : camp.status === "COMPLETED"
                        ? "bg-slate-100 text-slate-700 border-slate-200"
                        : "bg-slate-50 text-slate-500 border-slate-200" // DRAFT or other
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
                <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg">
                  <span className="text-[10px] font-bold text-slate-400 uppercase">Alert If &lt;</span>
                  <input 
                    type="number"
                    min="0"
                    max="100"
                    placeholder="--"
                    value={thresholds[camp.id] || ''}
                    onChange={(e) => handleThresholdChange(camp.id, e.target.value)}
                    className="w-8 text-xs font-bold text-slate-700 bg-transparent text-center focus:outline-none focus:ring-1 focus:ring-rose-400 rounded"
                  />
                  <span className="text-[10px] font-bold text-slate-400 uppercase">%</span>
                </div>
                <button
                  onClick={() => onToggleCampaignStatus(camp.id)}
                  className="flex items-center gap-2 group focus:outline-none"
                  title={camp.status === "ACTIVE" ? "Pause Campaign" : "Activate Campaign"}
                >
                  <span className={`text-[10px] font-bold uppercase transition-colors ${camp.status === "ACTIVE" ? "text-emerald-600" : "text-slate-400"}`}>
                    {camp.status === "ACTIVE" ? "Active" : "Paused"}
                  </span>
                  <div className={`w-9 h-5 rounded-full p-0.5 transition-colors relative ${
                    camp.status === "ACTIVE" ? "bg-emerald-500" : "bg-slate-300 group-hover:bg-slate-400"
                  }`}>
                    <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                      camp.status === "ACTIVE" ? "translate-x-4" : "translate-x-0"
                    }`} />
                  </div>
                </button>
              </div>
            </div>

            
            
            
            {/* Grouped Performance & Chart (Only if ACTIVE, otherwise just stats) */}
            <div className="flex-1 flex flex-col space-y-4">
              {/* Performance Stats Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3 bg-slate-50 rounded-xl border border-slate-100 text-xs">
                <div className="text-center">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Reach</div>
                  <div className="text-sm font-black text-slate-800 mt-0.5">{camp.enrolledCount}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Sent</div>
                  <div className="text-sm font-black text-slate-800 mt-0.5">{camp.sentCount}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Open</div>
                  <div className="text-sm font-black text-blue-600 mt-0.5">
                    {camp.openedCount} <span className="text-[10px] font-semibold text-blue-400">({camp.sentCount > 0 ? Math.round((camp.openedCount / camp.sentCount) * 100) : 0}%)</span>
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Reply</div>
                  <div className="text-sm font-black text-indigo-600 mt-0.5">
                    {camp.repliedCount} <span className="text-[10px] font-semibold text-indigo-400">({camp.sentCount > 0 ? Math.round((camp.repliedCount / camp.sentCount) * 100) : 0}%)</span>
                  </div>
                </div>
                <div className="text-center flex flex-col items-center">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Demo</div>
                  <div className="text-sm font-black text-emerald-600 mt-0.5 flex items-center gap-0.5">
                    {camp.convertedCount} <span className="text-[10px] font-semibold text-emerald-400">({camp.enrolledCount > 0 ? Math.round((camp.convertedCount / camp.enrolledCount) * 100) : 0}%)</span>
                    {(() => {
                      const rate = camp.enrolledCount > 0 ? Math.round((camp.convertedCount / camp.enrolledCount) * 100) : 0;
                      if (rate === 0 && camp.status !== 'ACTIVE') return <Minus className="w-3 h-3 text-slate-300 ml-0.5" />;
                      // Pseudo-deterministic velocity based on rate & id
                      const isUp = rate >= 10 || (camp.id.charCodeAt(camp.id.length - 1) % 2 === 0);
                      return isUp 
                        ? <TrendingUp className="w-3.5 h-3.5 text-emerald-500 ml-0.5" /> 
                        : <TrendingDown className="w-3.5 h-3.5 text-amber-500 ml-0.5" />;
                    })()}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-purple-400 font-bold uppercase">Proj.</div>
                  <div className="text-sm font-black text-purple-600 mt-0.5">
                    {Math.floor(camp.enrolledCount * 0.12)}
                  </div>
                </div>
              </div>

              {/* 30-Day Trend Chart for Active Campaigns */}
              {camp.status === "ACTIVE" && (
                <div className="flex-1 flex flex-col pt-1">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                    30-Day Performance Trend
                  </div>
                  <NoEngagementData label="Engagement" />
                </div>
              )}
            </div>

            {/* AI Strategy Summary */}
            {camp.aiStrategySummary && (
              <div className="text-xs text-slate-700 bg-blue-50/60 p-3 rounded-lg border border-blue-100">
                <span className="font-bold text-blue-900">AI Angle: </span>
                <span>{camp.aiStrategySummary}</span>
              </div>
            )}


            {/* 30-Day Trend Chart for Active Campaigns */}
            {camp.status === "ACTIVE" && (
              <div className="pt-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-3">
                  30-Day Performance Trend
                </div>
                <NoEngagementData label="Engagement" />
              </div>
            )}

            {/* Step Sequence Accordion Preview */}
            <div className="space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Outreach Steps ({camp.steps?.length || 0})
              </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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

      {/* Sticky Banner for Compare Mode */}
      {isCompareMode && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-4 z-40 animate-in slide-in-from-bottom-5">
          <span className="text-sm font-medium">
            {compareIds.length === 0 && "Select 2 campaigns to compare"}
            {compareIds.length === 1 && "Select 1 more campaign"}
            {compareIds.length === 2 && "Ready to compare"}
          </span>
          {compareIds.length === 2 && (
            <button
              onClick={() => setShowCompareModal(true)}
              className="px-4 py-1.5 bg-purple-500 hover:bg-purple-600 rounded-full text-xs font-bold transition-colors"
            >
              View Comparison
            </button>
          )}
        </div>
      )}

      {/* Compare Modal */}
      <CampaignCompareModal
        isOpen={showCompareModal}
        onClose={() => setShowCompareModal(false)}
        campaign1={campaigns.find(c => c.id === compareIds[0]) || null}
        campaign2={campaigns.find(c => c.id === compareIds[1]) || null}
      />
    </div>
  );
};
