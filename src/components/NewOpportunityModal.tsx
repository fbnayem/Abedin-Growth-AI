import React, { useState } from "react";
import { X, DollarSign, Sparkles, Building, User, Mail, Plus, Loader2 } from "lucide-react";
import { Opportunity, PipelineStage, EngineType } from "../types";

interface NewOpportunityModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpportunityCreated: (opp: Opportunity) => void;
}

export const NewOpportunityModal: React.FC<NewOpportunityModalProps> = ({
  isOpen,
  onClose,
  onOpportunityCreated,
}) => {
  const [title, setTitle] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [category, setCategory] = useState<EngineType>("CUSTOMER");
  const [stage, setStage] = useState<PipelineStage>("QUALIFIED");
  const [estimatedValue, setEstimatedValue] = useState<number>(12000);
  const [probability, setProbability] = useState<number>(50);
  const [nextStep, setNextStep] = useState("Schedule product discovery & voice demo");
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !companyName.trim()) return;

    setLoading(true);
    try {
      const res = await fetch("/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          companyName,
          contactName: contactName || "Decision Maker",
          contactEmail,
          category,
          stage,
          estimatedValue: Number(estimatedValue) || 10000,
          currency: "£",
          probability: Number(probability) || 50,
          nextStep: nextStep || "Follow up on initial demonstration",
        }),
      });

      if (!res.ok) throw new Error("Failed to create opportunity");
      const newOpp = await res.json();
      onOpportunityCreated(newOpp);
      onClose();
      // Reset form
      setTitle("");
      setCompanyName("");
      setContactName("");
      setContactEmail("");
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
            <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center">
              <DollarSign className="w-4 h-4 text-white" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Create New Opportunity</h3>
              <p className="text-xs text-slate-400">Add a new deal to your revenue pipeline</p>
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
          <div>
            <label className="block font-bold text-slate-700 mb-1">
              Opportunity / Deal Title <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Mayfair Cosmetic Dental - 5-Seat Voice AI License"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">
                Company / Organization <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Mayfair Dental Clinic"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Deal Type</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as EngineType)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium bg-white focus:ring-2 focus:ring-blue-500 outline-hidden"
              >
                <option value="CUSTOMER">Customer License</option>
                <option value="INVESTOR">Investment Round</option>
                <option value="PARTNER">Agency Rev-Share Partner</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">Contact Person</label>
              <input
                type="text"
                placeholder="e.g. Dr. James Sterling"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Contact Email</label>
              <input
                type="email"
                placeholder="e.g. james@mayfairdental.co.uk"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">Pipeline Stage</label>
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value as PipelineStage)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium bg-white focus:ring-2 focus:ring-blue-500 outline-hidden"
              >
                <option value="QUALIFIED">Qualified</option>
                <option value="MEETING_SCHEDULED">Meeting Scheduled</option>
                <option value="DEMO_COMPLETED">Demo Completed</option>
                <option value="PROPOSAL_SENT">Proposal Sent</option>
                <option value="WON">Closed Won</option>
              </select>
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Value (£ GBP)</label>
              <input
                type="number"
                min="0"
                step="500"
                value={estimatedValue}
                onChange={(e) => setEstimatedValue(Number(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Win Probability (%)</label>
              <input
                type="number"
                min="0"
                max="100"
                value={probability}
                onChange={(e) => setProbability(Number(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
              />
            </div>
          </div>

          <div>
            <label className="block font-bold text-slate-700 mb-1">Next Action Step</label>
            <input
              type="text"
              placeholder="e.g. Present live audio receptionist demo"
              value={nextStep}
              onChange={(e) => setNextStep(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
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
              disabled={loading || !title || !companyName}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold transition-colors flex items-center gap-1.5 disabled:opacity-50 shadow-sm"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Opportunity</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
