import { apiFetch } from '../lib/apiFetch';
import React, { useState } from "react";
import { X, TrendingUp, Sparkles, Building, Mail, Globe, Plus, Loader2 } from "lucide-react";
import { Investor, InvestorStage } from "../types";

interface AddInvestorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInvestorCreated: (investor: Investor) => void;
}

export const AddInvestorModal: React.FC<AddInvestorModalProps> = ({
  isOpen,
  onClose,
  onInvestorCreated,
}) => {
  const [name, setName] = useState("");
  const [fundName, setFundName] = useState("");
  const [role, setRole] = useState("General Partner");
  const [email, setEmail] = useState("");
  const [country, setCountry] = useState("United Kingdom");
  const [stage, setStage] = useState<InvestorStage>("SEED");
  const [typicalCheckSize, setTypicalCheckSize] = useState("£250k - £1M");
  const [targetSectors, setTargetSectors] = useState("Applied AI, B2B SaaS, Automation");
  const [thesisMatchReason, setThesisMatchReason] = useState("Invests in generative voice agents and workflow automation startups.");
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !fundName.trim()) return;

    setLoading(true);
    try {
      const res = await apiFetch("/api/investors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          fundName,
          role,
          email,
          country,
          stage,
          typicalCheckSize,
          targetSectors: targetSectors.split(",").map((s) => s.trim()),
          thesisMatchReason,
          recommendedPitchAngle: "Highlight capital efficiency, sticky retention, and unit economics.",
        }),
      });

      if (!res.ok) throw new Error("Failed to add investor");
      const newInvestor = await res.json();
      onInvestorCreated(newInvestor);
      onClose();
      // Reset form
      setName("");
      setFundName("");
      setEmail("");
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-white" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Add Investor Target</h3>
              <p className="text-xs text-slate-400">Track VC funds and angel investors in your fundraising pipeline</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto flex-1 space-y-4 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">
                Partner / Investor Name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Marcus Vance"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-indigo-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">
                Fund / Venture Firm <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Horizon Seed Ventures"
                value={fundName}
                onChange={(e) => setFundName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-indigo-500 outline-hidden"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">Role in Fund</label>
              <input
                type="text"
                placeholder="e.g. Founding Partner / Principal"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-indigo-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Email Address</label>
              <input
                type="email"
                placeholder="e.g. marcus@horizonseed.vc"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-indigo-500 outline-hidden"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">Investment Stage</label>
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value as InvestorStage)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium bg-white focus:ring-2 focus:ring-indigo-500 outline-hidden"
              >
                <option value="PRE_SEED">Pre-Seed</option>
                <option value="SEED">Seed</option>
                <option value="SERIES_A">Series A</option>
                <option value="ANGEL">Angel</option>
              </select>
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Typical Check</label>
              <input
                type="text"
                placeholder="e.g. $500K - $1M"
                value={typicalCheckSize}
                onChange={(e) => setTypicalCheckSize(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-indigo-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">HQ Location</label>
              <input
                type="text"
                placeholder="e.g. London / Singapore"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-indigo-500 outline-hidden"
              />
            </div>
          </div>

          <div>
            <label className="block font-bold text-slate-700 mb-1">Target Sectors (comma-separated)</label>
            <input
              type="text"
              placeholder="e.g. Applied AI, B2B SaaS, Healthcare Tech"
              value={targetSectors}
              onChange={(e) => setTargetSectors(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-indigo-500 outline-hidden"
            />
          </div>

          <div>
            <label className="block font-bold text-slate-700 mb-1">Thesis Match Context</label>
            <input
              type="text"
              placeholder="e.g. Previously backed AI conversational tooling; stated focus on autonomous enterprise workflows."
              value={thesisMatchReason}
              onChange={(e) => setThesisMatchReason(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-indigo-500 outline-hidden"
            />
          </div>

          {/* Footer */}
          <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 font-semibold hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name || !fundName}
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition-colors flex items-center gap-1.5 disabled:opacity-50 shadow-sm"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Adding...</span>
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Investor</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
