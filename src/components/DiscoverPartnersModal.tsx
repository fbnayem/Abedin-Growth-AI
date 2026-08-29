import React, { useState } from "react";
import { X, Sparkles, Handshake, MapPin, Building2, Sliders, Loader2, ShieldCheck } from "lucide-react";
import { Partner, PartnerType } from "../types";

interface DiscoverPartnersModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPartnersDiscovered: (partners: Partner[]) => void;
}

const PARTNER_TYPE_OPTIONS: { label: string; value: PartnerType }[] = [
  { label: "Digital Marketing & Growth Agency", value: "AGENCY" },
  { label: "Telecom & VoIP Reseller", value: "TELECOM" },
  { label: "Practice / CRM Consultant", value: "CRM_CONSULTANT" },
  { label: "BPO & Call Center Provider", value: "BPO_CALL_CENTER" },
  { label: "Referral & Channel Partner", value: "REFERRAL" },
  { label: "Technology Integration", value: "TECHNOLOGY_INTEGRATION" },
];

const TERRITORY_PRESETS = [
  "United Kingdom",
  "United States",
  "Australia & New Zealand",
  "United Arab Emirates",
  "Canada",
  "Western Europe",
];

export const DiscoverPartnersModal: React.FC<DiscoverPartnersModalProps> = ({
  isOpen,
  onClose,
  onPartnersDiscovered,
}) => {
  const [partnerType, setPartnerType] = useState<PartnerType>("AGENCY");
  const [territory, setTerritory] = useState("United Kingdom");
  const [count, setCount] = useState(4);
  const [loading, setLoading] = useState(false);
  const [stepText, setStepText] = useState("");

  if (!isOpen) return null;

  const handleDiscover = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setStepText("Engaging Gemini AI Channel Partner Specialist...");

    const t1 = setTimeout(() => setStepText("Scanning agency rosters & client profile match..."), 700);
    const t2 = setTimeout(() => setStepText("Structuring recurring rev-share models & collaboration terms..."), 1500);

    try {
      const res = await fetch("/api/partners/batch-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partnerType,
          territory,
          count,
        }),
      });

      if (!res.ok) throw new Error("Failed to discover partners");
      const discoveredPartners: Partner[] = await res.json();
      onPartnersDiscovered(discoveredPartners);
      onClose();
    } catch (error) {
      console.error("Discovery error:", error);
      alert("Failed to discover partners. Please try again.");
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
        <div className="p-6 border-b border-slate-800/80 flex items-center justify-between bg-gradient-to-r from-amber-950/30 to-slate-900">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                AI Channel Partner Discovery
                <span className="text-[11px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded-full">
                  Gemini Smart
                </span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Discover high-leverage agency, reseller, and consultant partners to co-sell
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
          {/* Partner Type & Batch Count */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Handshake className="w-3.5 h-3.5 text-amber-400" />
                Target Partner Type
              </label>
              <select
                value={partnerType}
                onChange={(e) => setPartnerType(e.target.value as PartnerType)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all"
              >
                {PARTNER_TYPE_OPTIONS.map((opt) => (
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
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all"
              >
                <option value={4}>4 New Partners</option>
                <option value={8}>8 New Partners</option>
                <option value={12}>12 New Partners</option>
              </select>
            </div>
          </div>

          {/* Territory */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5 text-amber-400" />
              Target Territory / Country
            </label>
            <input
              type="text"
              value={territory}
              onChange={(e) => setTerritory(e.target.value)}
              placeholder="e.g., United Kingdom, United States, UAE"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all mb-2"
              required
            />
            <div className="flex flex-wrap gap-1.5">
              {TERRITORY_PRESETS.slice(0, 4).map((ter) => (
                <button
                  type="button"
                  key={ter}
                  onClick={() => setTerritory(ter)}
                  className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                    territory === ter
                      ? "bg-amber-500/15 border-amber-500/40 text-amber-300"
                      : "bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-300"
                  }`}
                >
                  {ter}
                </button>
              ))}
            </div>
          </div>

          {/* AI Info Note */}
          <div className="p-3.5 bg-amber-950/20 border border-amber-800/30 rounded-xl flex items-start gap-2.5 text-xs text-amber-300/90 leading-relaxed">
            <ShieldCheck className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <span>
              Partner intelligence matches companies with existing agency client bases in your target verticals and suggests non-competing co-sell bundles with 25-35% revenue share margins.
            </span>
          </div>

          {/* Progress / Step text */}
          {loading && (
            <div className="p-3 bg-slate-950 border border-amber-500/30 rounded-xl flex items-center gap-3 text-xs text-amber-400 animate-pulse">
              <Loader2 className="w-4 h-4 animate-spin text-amber-400 flex-shrink-0" />
              <span>{stepText || "AI Partner Discovery running..."}</span>
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
              className="px-5 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-medium text-xs rounded-xl shadow-lg shadow-amber-900/30 hover:shadow-amber-900/50 transition-all flex items-center gap-2 disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Discovering Partners...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Discover {count} Channel Partners
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
