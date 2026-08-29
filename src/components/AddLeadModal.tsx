import React, { useState } from "react";
import { X, UserPlus, Sparkles, Building2, Mail, Phone, Globe, Plus, Loader2 } from "lucide-react";
import { Lead } from "../types";

interface AddLeadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLeadCreated: (lead: Lead) => void;
}

export const AddLeadModal: React.FC<AddLeadModalProps> = ({
  isOpen,
  onClose,
  onLeadCreated,
}) => {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("Managing Director");
  const [companyName, setCompanyName] = useState("");
  const [companyWebsite, setCompanyWebsite] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [industry, setIndustry] = useState("Healthcare & Dental Clinics");
  const [country, setCountry] = useState("United Kingdom");
  const [employeeCount, setEmployeeCount] = useState("10-50");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !companyName.trim()) return;

    setLoading(true);
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          title,
          companyName,
          companyWebsite,
          email,
          phone,
          industry,
          country,
          employeeCount,
          recommendedPitch: notes || "24/7 missed appointment recovery with AI receptionist.",
        }),
      });

      if (!res.ok) throw new Error("Failed to add lead");
      const newLead = await res.json();
      onLeadCreated(newLead);
      onClose();
      // Reset form
      setName("");
      setCompanyName("");
      setEmail("");
      setPhone("");
      setCompanyWebsite("");
      setNotes("");
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
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <UserPlus className="w-4 h-4 text-white" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Add Customer Prospect</h3>
              <p className="text-xs text-slate-400">Enroll a prospect for AI scoring & outreach</p>
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
                Prospect Full Name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Dr. Sarah Jenkins"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Job Title</label>
              <input
                type="text"
                placeholder="e.g. Practice Owner / Director"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">
                Company / Clinic Name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Harley Medical Centre"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Company Website</label>
              <input
                type="text"
                placeholder="e.g. https://harleymedical.co.uk"
                value={companyWebsite}
                onChange={(e) => setCompanyWebsite(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">Email Address</label>
              <input
                type="email"
                placeholder="e.g. sarah@harleymedical.co.uk"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Phone Number</label>
              <input
                type="tel"
                placeholder="e.g. +44 20 7946 0912"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">Industry</label>
              <select
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium bg-white focus:ring-2 focus:ring-blue-500 outline-hidden"
              >
                <option value="Healthcare & Dental Clinics">Healthcare & Dental Clinics</option>
                <option value="Legal & Law Firms">Legal & Law Firms</option>
                <option value="Real Estate & Property">Real Estate & Property</option>
                <option value="Automotive & Dealerships">Automotive & Dealerships</option>
                <option value="B2B Professional Services">B2B Professional Services</option>
                <option value="Hospitality & Restaurants">Hospitality & Restaurants</option>
              </select>
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Country / Region</label>
              <input
                type="text"
                placeholder="e.g. United Kingdom"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Team Size</label>
              <select
                value={employeeCount}
                onChange={(e) => setEmployeeCount(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium bg-white focus:ring-2 focus:ring-blue-500 outline-hidden"
              >
                <option value="1-10">1-10 staff</option>
                <option value="10-50">10-50 staff</option>
                <option value="50-200">50-200 staff</option>
                <option value="200+">200+ staff</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block font-bold text-slate-700 mb-1">Context / Specific Angle</label>
            <input
              type="text"
              placeholder="e.g. Experiencing high receptionist turnover; wants automated appointment bookings."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
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
              disabled={loading || !name || !companyName}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold transition-colors flex items-center gap-1.5 disabled:opacity-50 shadow-sm"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Adding...</span>
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Lead</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
