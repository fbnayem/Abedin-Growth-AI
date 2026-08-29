import React from "react";
import {
  BarChart3,
  TrendingUp,
  Users,
  Calendar,
  MessageSquare,
  DollarSign,
  ArrowRight,
  Sparkles,
} from "lucide-react";

export const AnalyticsView: React.FC = () => {
  const funnelSteps = [
    { label: "1. Discovered", count: 240, dropoff: "100%", color: "bg-slate-700" },
    { label: "2. AI Qualified (Score > 80)", count: 184, dropoff: "76.6%", color: "bg-blue-600" },
    { label: "3. Outreach Sent", count: 120, dropoff: "50.0%", color: "bg-indigo-600" },
    { label: "4. Opened", count: 88, dropoff: "73.3% Open Rate", color: "bg-purple-600" },
    { label: "5. Replied", count: 34, dropoff: "28.3% Reply Rate", color: "bg-amber-600" },
    { label: "6. Positive Intent", count: 19, dropoff: "55.8% Positivity", color: "bg-emerald-600" },
    { label: "7. Demo Booked", count: 8, dropoff: "42.1% Conversion", color: "bg-emerald-500" },
  ];

  return (
    <div className="space-y-6">
      {/* Title */}
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Growth Analytics & Funnel</h1>
          <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold">
            Live Velocity
          </span>
        </div>
        <p className="text-xs text-slate-500 mt-0.5">
          End-to-end performance analytics across customer discovery, response classification, and closed revenue.
        </p>
      </div>

      {/* Top Velocity Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs">
          <div className="text-xs text-slate-500 font-semibold">Average Reply Latency</div>
          <div className="text-2xl font-black text-slate-900 mt-1">4.2 hrs</div>
          <div className="text-[10px] text-emerald-600 mt-0.5">AI drafts ready in &lt;3s</div>
        </div>

        <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs">
          <div className="text-xs text-slate-500 font-semibold">Positive Conversion Rate</div>
          <div className="text-2xl font-black text-blue-600 mt-1">15.8%</div>
          <div className="text-[10px] text-slate-500 mt-0.5">3.2x industry average</div>
        </div>

        <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs">
          <div className="text-xs text-slate-500 font-semibold">Customer ACV</div>
          <div className="text-2xl font-black text-indigo-600 mt-1">£7,200</div>
          <div className="text-[10px] text-slate-500 mt-0.5">Per Clinic / Practice</div>
        </div>

        <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs">
          <div className="text-xs text-slate-500 font-semibold">Pipeline Velocity</div>
          <div className="text-2xl font-black text-emerald-600 mt-1">14 Days</div>
          <div className="text-[10px] text-emerald-600 mt-0.5">First touch to booked demo</div>
        </div>
      </div>

      {/* Conversion Funnel Bar */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-4">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-blue-600" />
            <h3 className="text-sm font-bold text-slate-900">Conversion Funnel Drop-off</h3>
          </div>
          <span className="text-xs text-slate-400 font-medium">All Engines Combined</span>
        </div>

        <div className="space-y-3">
          {funnelSteps.map((step, idx) => {
            const maxVal = 240;
            const percentage = Math.round((step.count / maxVal) * 100);
            return (
              <div key={idx} className="space-y-1">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-700">
                  <span>{step.label}</span>
                  <span className="font-mono text-slate-900 font-bold">
                    {step.count} ({step.dropoff})
                  </span>
                </div>
                <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${step.color} rounded-full transition-all duration-500`}
                    style={{ width: `${percentage}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
