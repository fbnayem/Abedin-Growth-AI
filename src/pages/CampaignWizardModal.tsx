import { apiFetch } from '../lib/apiFetch';
import React, { useState } from "react";
import {
  Sparkles,
  X,
  Target,
  Globe,
  Layers,
  Send,
  Loader2,
  CheckCircle2,
  Clock,
  Mail,
  Linkedin,
  Phone,
} from "lucide-react";
import { Campaign, EngineType, CampaignStep } from "../types";

interface CampaignWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCampaignCreated: (campaign: Campaign) => void;
}

export const CampaignWizardModal: React.FC<CampaignWizardModalProps> = ({
  isOpen,
  onClose,
  onCampaignCreated,
}) => {
  const [engineType, setEngineType] = useState<EngineType>("CUSTOMER");
  const [name, setName] = useState("UK Dental Practice Reception Recovery");
  const [targetAudience, setTargetAudience] = useState("Dental Practice Managers & Owners");
  const [industries, setIndustries] = useState("Dental & Healthcare Clinics");
  const [locations, setLocations] = useState("United Kingdom");
  const [enrolledCount, setEnrolledCount] = useState(25);

  const [generating, setGenerating] = useState(false);
  const [previewSteps, setPreviewSteps] = useState<CampaignStep[] | null>(null);
  const [strategySummary, setStrategySummary] = useState<string>("");

  if (!isOpen) return null;

  const handleGenerateStrategy = async () => {
    setGenerating(true);
    try {
      const res = await apiFetch("/api/campaigns/generate-strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          engineType,
          targetAudience,
          targetIndustries: industries.split(",").map((s) => s.trim()),
          targetLocations: locations.split(",").map((s) => s.trim()),
          enrolledCount,
        }),
      });

      if (!res.ok) throw new Error("Failed to generate campaign strategy");
      const createdCampaign: Campaign = await res.json();
      setPreviewSteps(createdCampaign.steps);
      setStrategySummary(createdCampaign.aiStrategySummary || "");
      onCampaignCreated(createdCampaign);
    } catch (err) {
      console.error(err);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Create AI Growth Campaign</h3>
              <p className="text-xs text-slate-400">
                Gemini will architect a 4-step sequence with personalized angles
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-4">
          {!previewSteps ? (
            <div className="space-y-4">
              {/* Campaign Type Selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Growth Target Engine
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: "CUSTOMER", label: "Customer Acquisition" },
                    { id: "INVESTOR", label: "Investor Outreach" },
                    { id: "PARTNER", label: "Partner Recruitment" },
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        setEngineType(t.id as EngineType);
                        if (t.id === "CUSTOMER") {
                          setName("UK Dental Practice Reception Recovery");
                          setTargetAudience("Practice Managers & Owners");
                          setIndustries("Dental & Healthcare Clinics");
                        } else if (t.id === "INVESTOR") {
                          setName("Seed AI Infrastructure Outreach");
                          setTargetAudience("Seed & Pre-Seed Venture Partners");
                          setIndustries("Applied AI, B2B SaaS, Seed Funds");
                        } else {
                          setName("Agency & Telecom Reseller Program");
                          setTargetAudience("Managing Partners & Agency Founders");
                          setIndustries("Digital Marketing, BPO, Telecom");
                        }
                      }}
                      className={`py-2 px-3 rounded-lg text-xs font-bold border transition-all text-center ${
                        engineType === t.id
                          ? "bg-blue-50 border-blue-600 text-blue-700 shadow-2xs"
                          : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Campaign Name */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Campaign Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
                />
              </div>

              {/* Target Audience */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Target Persona</label>
                  <input
                    type="text"
                    value={targetAudience}
                    onChange={(e) => setTargetAudience(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Target Location</label>
                  <input
                    type="text"
                    value={locations}
                    onChange={(e) => setLocations(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
                  />
                </div>
              </div>

              {/* Industries */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Industry Segments</label>
                <input
                  type="text"
                  value={industries}
                  onChange={(e) => setIndustries(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden"
                />
              </div>

              {/* Enrolled Prospects Count */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Initial Enrolled Prospects ({enrolledCount})
                </label>
                <input
                  type="range"
                  min="5"
                  max="100"
                  step="5"
                  value={enrolledCount}
                  onChange={(e) => setEnrolledCount(Number(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
          ) : (
            /* Strategy Preview Generated */
            <div className="space-y-4">
              <div className="p-3.5 bg-emerald-50 rounded-xl border border-emerald-200 text-xs text-emerald-950 space-y-1">
                <div className="font-bold text-emerald-900 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>Campaign Architecture Ready</span>
                </div>
                <p className="text-slate-700">{strategySummary}</p>
              </div>

              <div className="space-y-2.5">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  4-Step Sequence Timeline
                </div>

                {previewSteps.map((step) => (
                  <div
                    key={step.stepNumber}
                    className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1.5"
                  >
                    <div className="flex items-center justify-between text-xs font-bold text-slate-900">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px]">
                          {step.stepNumber}
                        </span>
                        <span>{step.title}</span>
                      </div>
                      <span className="text-[11px] font-semibold text-slate-500 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {step.delayDays === 0 ? "Day 0 (Instant)" : `Day +${step.delayDays}`}
                      </span>
                    </div>

                    <div className="text-xs text-slate-600 font-mono bg-white p-2 rounded border border-slate-100">
                      Subject: {step.subjectTemplate}
                    </div>

                    <div className="text-xs text-slate-700 font-sans leading-relaxed line-clamp-3 bg-white p-2 rounded border border-slate-100">
                      {step.bodyTemplate}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 bg-white border border-slate-200 rounded-lg transition-colors"
          >
            Cancel
          </button>

          {!previewSteps ? (
            <button
              onClick={handleGenerateStrategy}
              disabled={generating}
              className="px-5 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm shadow-blue-500/20 transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              {generating ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Gemini Building Sequence...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Generate AI Strategy</span>
                </>
              )}
            </button>
          ) : (
            <button
              onClick={onClose}
              className="px-5 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow-sm transition-colors flex items-center gap-1.5"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Launch Campaign</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
