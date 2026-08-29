import React, { useState } from "react";
import { X, Sparkles, Compass, MapPin, Building2, Sliders, Loader2, CheckCircle2, ShieldCheck } from "lucide-react";
import { Lead } from "../types";
import { diagnosticFetch } from "../utils/diagnosticFetch";

interface DiscoverLeadsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLeadsDiscovered: (leads: Lead[]) => void;
}

const INDUSTRY_PRESETS = [
  "Dental & Aesthetic Clinics",
  "Private Healthcare & Medical Practices",
  "Real Estate Agencies & Property Management",
  "Automotive Dealerships & Service Centers",
  "Legal & Accountancy Firms",
  "Home Improvement & Trade Services",
  "B2B SaaS & Tech Providers",
];

const LOCATION_PRESETS = [
  "United Kingdom",
  "United States",
  "London, UK",
  "California, US",
  "Australia",
  "United Arab Emirates",
  "Canada",
];

export const DiscoverLeadsModal: React.FC<DiscoverLeadsModalProps> = ({
  isOpen,
  onClose,
  onLeadsDiscovered,
}) => {
  const [industry, setIndustry] = useState("Dental & Aesthetic Clinics");
  const [location, setLocation] = useState("United Kingdom");
  const [criteria, setCriteria] = useState("High inbound telephone appointment bookings, after-hours missed call risk");
  const [count, setCount] = useState(4);
  const [loading, setLoading] = useState(false);
  const [stepText, setStepText] = useState("");

  if (!isOpen) return null;

  const handleDiscover = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setStepText("Engaging Gemini AI Lead Intelligence Agent...");

    const t1 = setTimeout(() => setStepText("Analyzing practice websites, domain footprints & decision-makers..."), 700);
    const t2 = setTimeout(() => setStepText("Calculating ICP fit score, call volume probability & outreach hooks..."), 1600);

    try {
      const res = await diagnosticFetch(
        "/api/leads/batch-generate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            industry,
            location,
            criteria,
            count,
          }),
        },
        { context: "DiscoverLeadsModal.handleDiscover" }
      );

      if (!res.ok) throw new Error(`Failed to discover leads: HTTP ${res.status}`);
      const discoveredLeads: Lead[] = await res.json();
      onLeadsDiscovered(discoveredLeads);
      onClose();
    } catch (error) {
      console.error("Discovery error:", error);
      alert("Failed to discover leads. Please try again.");
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
      setLoading(false);
      setStepText("");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden text-slate-100">
        {/* Header */}
        <div className="p-6 border-b border-slate-800/80 flex items-center justify-between bg-gradient-to-r from-emerald-950/30 to-slate-900">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                AI Prospect Discovery Engine
                <span className="text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                  Gemini Smart
                </span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Automatically research, score, and verify new ICP-matched business leads
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            className="text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 p-2 rounded-xl transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleDiscover} className="p-6 space-y-5">
          {/* Industry Selection */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-emerald-400" />
              Target Vertical / Industry
            </label>
            <input
              type="text"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="e.g., Dental & Aesthetic Clinics"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all mb-2"
              required
            />
            <div className="flex flex-wrap gap-1.5">
              {INDUSTRY_PRESETS.slice(0, 4).map((ind) => (
                <button
                  type="button"
                  key={ind}
                  onClick={() => setIndustry(ind)}
                  className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                    industry === ind
                      ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                      : "bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-300"
                  }`}
                >
                  {ind}
                </button>
              ))}
            </div>
          </div>

          {/* Location Selection */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5 text-emerald-400" />
              Target Geography / Territory
            </label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g., United Kingdom, London, United States"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all mb-2"
              required
            />
            <div className="flex flex-wrap gap-1.5">
              {LOCATION_PRESETS.slice(0, 4).map((loc) => (
                <button
                  type="button"
                  key={loc}
                  onClick={() => setLocation(loc)}
                  className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                    location === loc
                      ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                      : "bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-300"
                  }`}
                >
                  {loc}
                </button>
              ))}
            </div>
          </div>

          {/* ICP Criteria & Batch Count */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-emerald-400" />
                Specific ICP Filter / Buying Signal
              </label>
              <input
                type="text"
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
                placeholder="e.g., Weekend booking demand, high hold times"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                Batch Count
              </label>
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all"
              >
                <option value={4}>4 New Leads</option>
                <option value={8}>8 New Leads</option>
                <option value={12}>12 New Leads</option>
                <option value={16}>16 New Leads</option>
              </select>
            </div>
          </div>

          {/* AI Info Note */}
          <div className="p-3.5 bg-emerald-950/20 border border-emerald-800/30 rounded-xl flex items-start gap-2.5 text-xs text-emerald-300/90 leading-relaxed">
            <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
            <span>
              Every discovered lead is checked against your company ICP brain, analyzed for phone reliance and decision-maker seniority, and scored on a 0-100 scale.
            </span>
          </div>

          {/* Progress / Step text */}
          {loading && (
            <div className="p-3 bg-slate-950 border border-emerald-500/30 rounded-xl flex items-center gap-3 text-xs text-emerald-400 animate-pulse">
              <Loader2 className="w-4 h-4 animate-spin text-emerald-400 flex-shrink-0" />
              <span>{stepText || "AI Discovery Agent running..."}</span>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800/80">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800/60 rounded-xl transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs rounded-xl shadow-lg shadow-emerald-900/30 hover:shadow-emerald-900/50 transition-all flex items-center gap-2 disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating Fresh Leads...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Discover {count} New Leads
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
