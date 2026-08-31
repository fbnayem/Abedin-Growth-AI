import { apiFetch } from '../lib/apiFetch';
import React, { useState } from "react";
import { X, Calendar, Clock, Sparkles, Building, Mail, User, Plus, Loader2 } from "lucide-react";
import { Meeting, EngineType } from "../types";

interface ScheduleMeetingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onMeetingScheduled: (meeting: Meeting) => void;
  initialData?: {
    name?: string;
    companyName?: string;
    email?: string;
    category?: EngineType;
  };
}

export const ScheduleMeetingModal: React.FC<ScheduleMeetingModalProps> = ({
  isOpen,
  onClose,
  onMeetingScheduled,
  initialData,
}) => {
  const [prospectName, setProspectName] = useState(initialData?.name || "");
  const [companyName, setCompanyName] = useState(initialData?.companyName || "");
  const [prospectEmail, setProspectEmail] = useState(initialData?.email || "");
  const [category, setCategory] = useState<EngineType>(initialData?.category || "CUSTOMER");
  
  // Default to tomorrow 14:00
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(14, 0, 0, 0);
  const defaultTimeString = tomorrow.toISOString().slice(0, 16);

  const [scheduledTime, setScheduledTime] = useState(defaultTimeString);
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [loading, setLoading] = useState(false);

  // Update fields if initialData changes
  React.useEffect(() => {
    if (initialData?.name) setProspectName(initialData.name);
    if (initialData?.companyName) setCompanyName(initialData.companyName);
    if (initialData?.email) setProspectEmail(initialData.email);
    if (initialData?.category) setCategory(initialData.category);
  }, [initialData]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prospectName.trim() || !companyName.trim()) return;

    setLoading(true);
    try {
      const res = await apiFetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prospectName,
          prospectEmail: prospectEmail || "prospect@example.com",
          companyName,
          category,
          scheduledTime: new Date(scheduledTime).toISOString(),
          durationMinutes: Number(durationMinutes) || 30,
        }),
      });

      if (!res.ok) throw new Error("Failed to schedule meeting");
      const newMeeting = await res.json();
      onMeetingScheduled(newMeeting);
      onClose();
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
              <Calendar className="w-4 h-4 text-white" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Schedule Call & Generate AI Brief</h3>
              <p className="text-xs text-slate-400">Gemini will prepare tailored talking points & objections</p>
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
                Attendee Name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Dr. Arthur Pendelton"
                value={prospectName}
                onChange={(e) => setProspectName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-emerald-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">
                Organization / Clinic <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Pendelton Health Partners"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-emerald-500 outline-hidden"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">Contact Email</label>
              <input
                type="email"
                placeholder="e.g. arthur@pendeltonhealth.co.uk"
                value={prospectEmail}
                onChange={(e) => setProspectEmail(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-emerald-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Call Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as EngineType)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium bg-white focus:ring-2 focus:ring-emerald-500 outline-hidden"
              >
                <option value="CUSTOMER">Customer Product Demo</option>
                <option value="INVESTOR">Investor Pitch & Diligence</option>
                <option value="PARTNER">Agency Partnership Exploration</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 mb-1">Date & Time</label>
              <input
                type="datetime-local"
                value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium focus:ring-2 focus:ring-emerald-500 outline-hidden"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">Duration</label>
              <select
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium bg-white focus:ring-2 focus:ring-emerald-500 outline-hidden"
              >
                <option value={15}>15 minutes (Quick Screen)</option>
                <option value={30}>30 minutes (Standard Demo)</option>
                <option value={45}>45 minutes (Deep Dive)</option>
                <option value={60}>60 minutes (Technical Strategy)</option>
              </select>
            </div>
          </div>

          {/* AI Pre-Brief Notice */}
          <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 text-blue-900 text-xs flex items-start gap-2">
            <Sparkles className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold">Autonomous Briefing Generator: </span>
              Upon saving, Gemini will synthesize meeting objectives, 3 key discovery questions, and tailored objection answers.
            </div>
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
              disabled={loading || !prospectName || !companyName}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold transition-colors flex items-center gap-1.5 disabled:opacity-50 shadow-sm"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Preparing AI Brief...</span>
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>Confirm & Generate Brief</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
