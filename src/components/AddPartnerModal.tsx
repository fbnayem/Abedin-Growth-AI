import { apiFetch } from '../lib/apiFetch';
import React, { useState } from "react";
import { X, Handshake, Sparkles, Building, Mail, Globe, Plus, Loader2 } from "lucide-react";
import { Partner, PartnerType } from "../types";

interface AddPartnerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPartnerCreated: (partner: Partner) => void;
}

export const AddPartnerModal: React.FC<AddPartnerModalProps> = ({
  isOpen,
  onClose,
  onPartnerCreated,
}) => {
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [partnerType, setPartnerType] = useState<PartnerType>("AGENCY");
  const [role, setRole] = useState("Managing Director");
  const [email, setEmail] = useState("");
  const [country, setCountry] = useState("United Kingdom");
  const [potentialCollaboration, setPotentialCollaboration] = useState("Offer Abedin Voice AI as a managed receptionist add-on to existing clients.");
  const [revenueModel, setRevenueModel] = useState("30% recurring monthly margin on client subscriptions.");
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !companyName.trim()) return;

    setLoading(true);
    try {
      const res = await apiFetch("/api/partners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          companyName,
          partnerType,
          role,
          email,
          country,
          potentialCollaboration,
          revenueModel,
        }),
      });

      if (!res.ok) throw new Error("Failed to add partner");
      const newPartner = await res.json();
      onPartnerCreated(newPartner);
      onClose();
      // Reset form
      setName("");
      setCompanyName("");
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
            <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center">
              <Handshake className="w-4 h-4 text-white" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Add Channel Partner</h3>
              <p className="text-xs text-slate-400">Recruit marketing agencies, resellers & integrators</p>
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
                Partner Contact Name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Liam Henderson"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-emerald-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">
                Agency / Partner Org <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Apex Clinic Marketing Group"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-emerald-500 outline-hidden"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">Partner Type</label>
              <select
                value={partnerType}
                onChange={(e) => setPartnerType(e.target.value as PartnerType)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium bg-white focus:ring-2 focus:ring-emerald-500 outline-hidden"
              >
                <option value="AGENCY">Marketing & Web Agency</option>
                <option value="TELECOM_RESELLER">Telecom & VoIP Reseller</option>
                <option value="CRM_CONSULTANT">CRM & PMS Consultant</option>
                <option value="BPO_PROVIDER">BPO & Contact Center</option>
              </select>
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Job Role</label>
              <input
                type="text"
                placeholder="e.g. Agency Founder / Partner"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-emerald-500 outline-hidden"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">Email Address</label>
              <input
                type="email"
                placeholder="e.g. liam@apexmarketing.co.uk"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-emerald-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Country / Region</label>
              <input
                type="text"
                placeholder="e.g. United Kingdom"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-emerald-500 outline-hidden"
              />
            </div>
          </div>

          <div>
            <label className="block font-bold text-slate-700 mb-1">Proposed Collaboration</label>
            <input
              type="text"
              placeholder="e.g. Bundle AI voice agent with clinic website packages."
              value={potentialCollaboration}
              onChange={(e) => setPotentialCollaboration(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-emerald-500 outline-hidden"
            />
          </div>

          <div>
            <label className="block font-bold text-slate-700 mb-1">Revenue Share Model</label>
            <input
              type="text"
              placeholder="e.g. 25-35% monthly recurring commission."
              value={revenueModel}
              onChange={(e) => setRevenueModel(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-emerald-500 outline-hidden"
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
              disabled={loading || !name || !companyName}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold transition-colors flex items-center gap-1.5 disabled:opacity-50 shadow-sm"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Adding...</span>
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Partner</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
