import React, { useState } from "react";
import { X, Sparkles, DollarSign, MapPin, Building2, Sliders, Loader2, ShieldCheck } from "lucide-react";
import { Investor, InvestorStage } from "../types";

interface DiscoverInvestorsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInvestorsDiscovered: (investors: Investor[]) => void;
}

const STAGE_OPTIONS: { label: string; value: InvestorStage }[] = [
  { label: "Pre-Seed ($250K - $500K)", value: "PRE_SEED" },
  { label: "Seed ($500K - $1.5M)", value: "SEED" },
  { label: "Series A ($2M - $5M)", value: "SERIES_A" },
  { label: "Angel Syndicate", value: "ANGEL" },
];

const SECTOR_PRESETS = [
  "Applied AI & Voice Agents",
  "Vertical B2B SaaS",
  "Workflow Automation",
  "Healthcare Tech",
  "Enterprise Software",
  "SMB Infrastructure",
];

const LOCATION_PRESETS = [
  "Singapore & Southeast Asia",
  "London & UK",
  "San Francisco & Silicon Valley",
  "New York, US",
  "Europe (Berlin, Paris, Stockholm)",
  "Global",
];

export const DiscoverInvestorsModal: React.FC<DiscoverInvestorsModalProps> = ({
  isOpen,
  onClose,
  onInvestorsDiscovered,
}) => {
  const [stage, setStage] = useState<InvestorStage>("SEED");
  const [selectedSectors, setSelectedSectors] = useState<string[]>(["Applied AI & Voice Agents", "Vertical B2B SaaS"]);
  const [location, setLocation] = useState("Global");
  const [count, setCount] = useState(4);
  const [loading, setLoading] = useState(false);
  const [stepText, setStepText] = useState("");

  if (!isOpen) return null;

  const toggleSector = (sector: string) => {
    if (selectedSectors.includes(sector)) {
      if (selectedSectors.length > 1) {
        setSelectedSectors(selectedSectors.filter((s) => s !== sector));
      }
    } else {
      setSelectedSectors([...selectedSectors, sector]);
    }
  };

  const handleDiscover = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setStepText("Engaging Gemini AI Investor Intelligence Specialist...");

    const t1 = setTimeout(() => setStepText("Analyzing VC mandates, check sizes & portfolio synergies..."), 700);
    const t2 = setTimeout(() => setStepText("Formulating thesis alignment score & tailored pitch angles..."), 1500);

    try {
      const res = await fetch("/api/investors/batch-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage,
          sectors: selectedSectors,
          location,
          count,
        }),
      });

      if (!res.ok) throw new Error("Failed to discover investors");
      const discoveredInvestors: Investor[] = await res.json();
      onInvestorsDiscovered(discoveredInvestors);
      onClose();
    } catch (error) {
      console.error("Discovery error:", error);
      alert("Failed to discover investors. Please try again.");
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
        <div className="p-6 border-b border-slate-800/80 flex items-center justify-between bg-gradient-to-r from-indigo-950/30 to-slate-900">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                AI Investor Discovery Engine
                <span className="text-[11px] font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded-full">
                  Gemini Smart
                </span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Discover matching VC funds, angel syndicates, and check-writers with thesis alignment
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
          {/* Target Stage & Count */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5 text-indigo-400" />
                Target Investment Stage
              </label>
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value as InvestorStage)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
              >
                {STAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                Batch Count
              </label>
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
              >
                <option value={4}>4 New Funds</option>
                <option value={8}>8 New Funds</option>
                <option value={12}>12 New Funds</option>
              </select>
            </div>
          </div>

          {/* Sectors */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-indigo-400" />
              Investment Sector Focus
            </label>
            <div className="flex flex-wrap gap-1.5">
              {SECTOR_PRESETS.map((sec) => {
                const active = selectedSectors.includes(sec);
                return (
                  <button
                    type="button"
                    key={sec}
                    onClick={() => toggleSector(sec)}
                    className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                      active
                        ? "bg-indigo-500/15 border-indigo-500/40 text-indigo-300"
                        : "bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-300"
                    }`}
                  >
                    {sec}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Location Selection */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5 text-indigo-400" />
              Target Hub / Geography
            </label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g., Singapore, London, Silicon Valley, Global"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all mb-2"
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
                      ? "bg-indigo-500/15 border-indigo-500/40 text-indigo-300"
                      : "bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-300"
                  }`}
                >
                  {loc}
                </button>
              ))}
            </div>
          </div>

          {/* AI Info Note */}
          <div className="p-3.5 bg-indigo-950/20 border border-indigo-800/30 rounded-xl flex items-start gap-2.5 text-xs text-indigo-300/90 leading-relaxed">
            <ShieldCheck className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />
            <span>
              The AI verifies stage fit, checks recent portfolio deals for vertical synergy, and generates pitch hooks adhering to founder governance boundaries.
            </span>
          </div>

          {/* Progress / Step text */}
          {loading && (
            <div className="p-3 bg-slate-950 border border-indigo-500/30 rounded-xl flex items-center gap-3 text-xs text-indigo-400 animate-pulse">
              <Loader2 className="w-4 h-4 animate-spin text-indigo-400 flex-shrink-0" />
              <span>{stepText || "AI Investor Discovery running..."}</span>
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
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs rounded-xl shadow-lg shadow-indigo-900/30 hover:shadow-indigo-900/50 transition-all flex items-center gap-2 disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Discovering Investors...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Discover {count} Matching Funds
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
