import React, { useState } from "react";
import {
  Calculator,
  DollarSign,
  TrendingDown,
  Sparkles,
  ArrowRight,
  Copy,
  Check,
  Building2,
  PhoneCall,
  CalendarCheck,
  Flame,
  FileSpreadsheet
} from "lucide-react";
import { Lead } from "../types";

interface RevenueLeakCalculatorProps {
  lead?: Lead;
  onApplyPitchHook?: (hook: string) => void;
}

export const RevenueLeakCalculator: React.FC<RevenueLeakCalculatorProps> = ({
  lead,
  onApplyPitchHook,
}) => {
  // Inputs
  const [dailyCalls, setDailyCalls] = useState<number>(
    lead?.industry?.toLowerCase().includes("dental") || lead?.industry?.toLowerCase().includes("clinic")
      ? 45
      : 30
  );
  const [missedCallPercent, setMissedCallPercent] = useState<number>(24); // Avg 24% after-hours & peak missed
  const [conversionRate, setConversionRate] = useState<number>(35); // 35% of missed callers book an appointment
  const [avgTicketValue, setAvgTicketValue] = useState<number>(140); // £140 avg appointment / consult
  const [copied, setCopied] = useState(false);

  // Calculations
  const missedCallsPerDay = (dailyCalls * (missedCallPercent / 100));
  const missedCallsPerMonth = Math.round(missedCallsPerDay * 24); // 24 working days + weekends
  const lostBookingsPerMonth = Math.round(missedCallsPerMonth * (conversionRate / 100));
  const monthlyRevenueLeak = Math.round(lostBookingsPerMonth * avgTicketValue);
  const annualRevenueLeak = monthlyRevenueLeak * 12;

  // Monthly Abedin Cost comparison: £299/mo vs £2,500/mo receptionist
  const estimatedCost = 299;
  const netMonthlyROI = monthlyRevenueLeak - estimatedCost;
  const roiMultiple = monthlyRevenueLeak > 0 ? (monthlyRevenueLeak / estimatedCost).toFixed(1) : "0";

  const generatedPitchSnippet = `Based on a clinic volume of ~${dailyCalls} calls/day, ${lead?.companyName || "your practice"} is likely dropping ~${missedCallsPerMonth} calls/mo after hours. At a standard ${conversionRate}% booking rate and £${avgTicketValue} avg patient value, that is ~£${monthlyRevenueLeak.toLocaleString()}/mo in lost revenue recovered for under £299/mo.`;

  const handleCopy = () => {
    navigator.clipboard.writeText(generatedPitchSnippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    if (onApplyPitchHook) {
      onApplyPitchHook(generatedPitchSnippet);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden">
      {/* Header */}
      <div className="p-4 bg-gradient-to-r from-slate-900 to-indigo-950 text-white flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center justify-center font-bold">
            <Calculator className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-xs font-bold tracking-tight text-white flex items-center gap-2">
              <span>Revenue Leak & ROI Proof Engine</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500 text-slate-950 font-black">
                {roiMultiple}x ROI
              </span>
            </h3>
            <p className="text-[11px] text-slate-400">
              Calculating lost appointments & after-hours leak for {lead?.companyName || "Target Clinic"}
            </p>
          </div>
        </div>
      </div>

      {/* Main Grid: Inputs vs Results */}
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Left: Input sliders */}
        <div className="space-y-3.5 bg-slate-50/70 p-3.5 rounded-xl border border-slate-200/80 text-xs">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            Practice Baseline Metrics
          </div>

          <div>
            <div className="flex justify-between font-semibold text-slate-700 mb-1">
              <span>Daily Inbound Calls:</span>
              <span className="font-bold text-slate-900">{dailyCalls} calls/day</span>
            </div>
            <input
              type="range"
              min="10"
              max="150"
              value={dailyCalls}
              onChange={(e) => setDailyCalls(Number(e.target.value))}
              className="w-full accent-indigo-600 cursor-pointer"
            />
          </div>

          <div>
            <div className="flex justify-between font-semibold text-slate-700 mb-1">
              <span>Missed / After-Hours Rate:</span>
              <span className="font-bold text-amber-700">{missedCallPercent}%</span>
            </div>
            <input
              type="range"
              min="5"
              max="50"
              value={missedCallPercent}
              onChange={(e) => setMissedCallPercent(Number(e.target.value))}
              className="w-full accent-amber-600 cursor-pointer"
            />
          </div>

          <div>
            <div className="flex justify-between font-semibold text-slate-700 mb-1">
              <span>Avg Appointment Value:</span>
              <span className="font-bold text-emerald-700">£{avgTicketValue}</span>
            </div>
            <input
              type="range"
              min="50"
              max="500"
              step="10"
              value={avgTicketValue}
              onChange={(e) => setAvgTicketValue(Number(e.target.value))}
              className="w-full accent-emerald-600 cursor-pointer"
            />
          </div>
        </div>

        {/* Right: Calculated Financial Impact */}
        <div className="space-y-3 flex flex-col justify-between">
          <div className="p-4 rounded-xl bg-gradient-to-br from-rose-50 to-amber-50/60 border border-rose-200/80 space-y-2">
            <div className="flex items-center justify-between text-xs font-bold text-rose-900">
              <span className="flex items-center gap-1.5">
                <TrendingDown className="w-4 h-4 text-rose-600" /> Current Revenue Leak
              </span>
              <span className="text-rose-700 font-extrabold text-base">
                £{monthlyRevenueLeak.toLocaleString()} <span className="text-[10px] font-medium text-slate-500">/ mo</span>
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-rose-200/60 text-[11px] text-slate-700">
              <div>
                <span className="text-slate-500">Dropped Calls:</span>{" "}
                <strong className="text-slate-900">~{missedCallsPerMonth}/mo</strong>
              </div>
              <div>
                <span className="text-slate-500">Lost Bookings:</span>{" "}
                <strong className="text-rose-700">~{lostBookingsPerMonth}/mo</strong>
              </div>
              <div className="col-span-2 text-rose-900 font-medium">
                Annual Opportunity Loss: <strong>£{annualRevenueLeak.toLocaleString()}/year</strong>
              </div>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs flex items-center justify-between text-emerald-950 font-bold">
            <span>Net Monthly ROI with Abedin AI:</span>
            <span className="text-emerald-700 text-sm font-extrabold">
              +£{netMonthlyROI.toLocaleString()}/mo
            </span>
          </div>
        </div>
      </div>

      {/* Bottom: Generated Pitch Snippet with 1-Click Copy */}
      <div className="p-3 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs">
        <div className="text-slate-700 text-[11px] italic leading-snug flex-1">
          <strong className="text-indigo-900 not-italic">Auto-Generated ROI Hook:</strong> &quot;{generatedPitchSnippet}&quot;
        </div>
        <button
          onClick={handleCopy}
          className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 flex items-center gap-1.5 shadow-2xs transition-colors shrink-0"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5" />
              <span>Applied to Pitch!</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Apply ROI to Email</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
