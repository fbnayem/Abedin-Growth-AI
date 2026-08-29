import React, { useState } from "react";
import {
  Sparkles,
  Building2,
  Target,
  Globe2,
  Mail,
  Calendar,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Check,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { CompanyBrain } from "../types";

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialBrain?: CompanyBrain;
  onSaveBrain: (brain: CompanyBrain) => void;
}

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  onClose,
  initialBrain,
  onSaveBrain,
}) => {
  const [step, setStep] = useState(1);
  const [companyName, setCompanyName] = useState(initialBrain?.companyName || "Abedin Tech");
  const [productName, setProductName] = useState(initialBrain?.productName || "Abedin Voice AI");
  const [companyUrl, setCompanyUrl] = useState(initialBrain?.companyUrl || "https://abedintech.com/voice-ai/");
  const [productUrl, setProductUrl] = useState(initialBrain?.productUrl || "https://abedintech.com/voice-ai/");
  
  const [objectives, setObjectives] = useState<string[]>([
    "Get Customers",
    "Find Investors",
    "Find Partners",
  ]);

  const [targetMarkets, setTargetMarkets] = useState<string[]>([
    "United Kingdom",
    "United States",
    "UAE",
    "Singapore",
  ]);

  const [gmailConnected, setGmailConnected] = useState(true);
  const [calendarConnected, setCalendarConnected] = useState(true);

  const [analyzing, setAnalyzing] = useState(false);
  const [generatedBrain, setGeneratedBrain] = useState<CompanyBrain | null>(initialBrain || null);

  if (!isOpen) return null;

  const toggleObjective = (obj: string) => {
    if (objectives.includes(obj)) {
      setObjectives(objectives.filter((o) => o !== obj));
    } else {
      setObjectives([...objectives, obj]);
    }
  };

  const toggleMarket = (market: string) => {
    if (targetMarkets.includes(market)) {
      setTargetMarkets(targetMarkets.filter((m) => m !== market));
    } else {
      setTargetMarkets([...targetMarkets, market]);
    }
  };

  const handleRunAnalysis = async () => {
    setAnalyzing(true);
    setStep(5);

    try {
      const res = await fetch("/api/company-brain/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName,
          companyUrl,
          productName,
          productUrl,
          targetMarkets,
          primaryObjectives: objectives,
        }),
      });

      if (!res.ok) throw new Error("Failed to generate company brain");
      const data = await res.json();
      setGeneratedBrain(data);
    } catch (err) {
      console.error(err);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleComplete = () => {
    if (generatedBrain) {
      onSaveBrain(generatedBrain);
    }
    onClose();
  };

  const availableMarkets = [
    "United Kingdom",
    "United States",
    "UAE",
    "Saudi Arabia",
    "Qatar",
    "Singapore",
    "Malaysia",
    "Europe",
    "Global",
  ];

  return (
    <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[90vh]">
        {/* Header with Progress Steps */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">
                {step === 5 && !analyzing ? "We built your Growth Strategy" : "What would you like AI to accomplish?"}
              </h2>
              <p className="text-xs text-slate-400">Step {step} of 5 — Abedin Growth AI Setup</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className={`w-2 h-2 rounded-full transition-all ${
                  step === i
                    ? "w-5 bg-blue-500"
                    : step > i
                    ? "bg-emerald-500"
                    : "bg-slate-700"
                }`}
              />
            ))}
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {/* STEP 1: Business Info */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-slate-900">Step 1 — Business & Product Details</h3>
                <p className="text-xs text-slate-600">
                  Tell Gemini about your company so it can build your customized Company Brain.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Company Name</label>
                  <input
                    type="text"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-blue-500 outline-hidden font-medium"
                    placeholder="e.g. Abedin Tech"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Product Name</label>
                  <input
                    type="text"
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-blue-500 outline-hidden font-medium"
                    placeholder="e.g. Abedin Voice AI"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Product Website URL</label>
                  <input
                    type="url"
                    value={productUrl}
                    onChange={(e) => {
                      setProductUrl(e.target.value);
                      setCompanyUrl(e.target.value);
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-blue-500 outline-hidden font-medium"
                    placeholder="https://abedintech.com/voice-ai/"
                  />
                </div>
              </div>

              <div className="p-3 bg-blue-50/80 rounded-xl border border-blue-100 flex items-start gap-2.5 text-xs text-blue-950">
                <Zap className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                <span>
                  Gemini will analyze your site and configure specialized sales agents, objection answers, and pitch angles automatically.
                </span>
              </div>
            </div>
          )}

          {/* STEP 2: Objectives */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-slate-900">Step 2 — Growth Objectives</h3>
                <p className="text-xs text-slate-600">Select which autonomous engines to activate:</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  {
                    id: "Get Customers",
                    title: "Get Customers",
                    desc: "Find appointment-based businesses & decision-makers who need 24/7 Voice AI receptionists.",
                    icon: Target,
                    color: "blue",
                  },
                  {
                    id: "Find Investors",
                    title: "Find Investors",
                    desc: "Discover venture capital & angel funds aligned with AI infrastructure and seed stage.",
                    icon: Sparkles,
                    color: "indigo",
                  },
                  {
                    id: "Find Partners",
                    title: "Find Partners",
                    desc: "Recruit agencies, telecom resellers, and CRM consultants for recurring rev-share.",
                    icon: Building2,
                    color: "emerald",
                  },
                  {
                    id: "Run Everything",
                    title: "Run Everything",
                    desc: "Build full customer, investor, and partnership pipelines simultaneously.",
                    icon: Zap,
                    color: "purple",
                  },
                ].map((item) => {
                  const Icon = item.icon;
                  const selected = objectives.includes(item.id);
                  return (
                    <div
                      key={item.id}
                      onClick={() => toggleObjective(item.id)}
                      className={`p-4 rounded-xl border cursor-pointer transition-all ${
                        selected
                          ? "bg-blue-50/60 border-blue-500 shadow-xs ring-1 ring-blue-500"
                          : "bg-slate-50/60 border-slate-200 hover:border-slate-300"
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <div className={`p-1.5 rounded-lg bg-blue-100 text-blue-700`}>
                            <Icon className="w-4 h-4" />
                          </div>
                          <span className="text-sm font-bold text-slate-900">{item.title}</span>
                        </div>
                        <div
                          className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                            selected
                              ? "bg-blue-600 border-blue-600 text-white"
                              : "border-slate-300"
                          }`}
                        >
                          {selected && <Check className="w-3 h-3" />}
                        </div>
                      </div>
                      <p className="text-xs text-slate-600 mt-2 leading-relaxed">{item.desc}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* STEP 3: Target Markets */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-slate-900">Step 3 — Target Geographic Markets</h3>
                <p className="text-xs text-slate-600">Select countries and regions for AI prospecting:</p>
              </div>

              <div className="flex flex-wrap gap-2">
                {availableMarkets.map((m) => {
                  const selected = targetMarkets.includes(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => toggleMarket(m)}
                      className={`px-3 py-2 rounded-xl text-xs font-semibold border flex items-center gap-1.5 transition-all ${
                        selected
                          ? "bg-blue-600 text-white border-blue-600 shadow-xs"
                          : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
                      }`}
                    >
                      <Globe2 className="w-3.5 h-3.5" />
                      <span>{m}</span>
                      {selected && <Check className="w-3 h-3 ml-1" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* STEP 4: Connect Accounts */}
          {step === 4 && (
            <div className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-slate-900">Step 4 — Connect Google Workspace</h3>
                <p className="text-xs text-slate-600">
                  Connect your accounts to enable automated email drafting, reply classification, and calendar booking.
                </p>
              </div>

              <div className="space-y-3">
                {/* Gmail Card */}
                <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-red-100 text-red-600 flex items-center justify-center">
                      <Mail className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="text-sm font-bold text-slate-900">Gmail Integration</div>
                      <div className="text-xs text-slate-500">Read replies & send approved campaign emails</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setGmailConnected(!gmailConnected)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      gmailConnected
                        ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                        : "bg-blue-600 text-white hover:bg-blue-700"
                    }`}
                  >
                    {gmailConnected ? "Connected (nayem@abedintech.com)" : "Connect Gmail"}
                  </button>
                </div>

                {/* Calendar Card */}
                <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
                      <Calendar className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="text-sm font-bold text-slate-900">Google Calendar</div>
                      <div className="text-xs text-slate-500">Check availability & book demos automatically</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCalendarConnected(!calendarConnected)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      calendarConnected
                        ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                        : "bg-blue-600 text-white hover:bg-blue-700"
                    }`}
                  >
                    {calendarConnected ? "Connected (Work Calendar)" : "Connect Calendar"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* STEP 5: Gemini Analysis & Review */}
          {step === 5 && (
            <div className="space-y-4">
              {analyzing ? (
                <div className="py-12 text-center space-y-4">
                  <Loader2 className="w-10 h-10 text-blue-600 animate-spin mx-auto" />
                  <div className="space-y-1">
                    <h3 className="text-base font-bold text-slate-900">Gemini is Analyzing Your Business...</h3>
                    <p className="text-xs text-slate-500 max-w-sm mx-auto">
                      Synthesizing target personas, customer pain points, objection handling, and investor narratives for {productName}.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="p-4 bg-emerald-50 rounded-xl border border-emerald-200 flex items-start gap-3">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                    <div className="text-xs text-emerald-950 space-y-1">
                      <div className="font-bold text-sm">Company Brain Generated Successfully</div>
                      <p>
                        Gemini built a complete strategic profile for <strong>{productName}</strong>. You can review and refine this at any time in the Knowledge hub.
                      </p>
                    </div>
                  </div>

                  {generatedBrain && (
                    <div className="space-y-3 p-4 bg-slate-50 rounded-xl border border-slate-200 text-xs">
                      <div>
                        <span className="font-bold text-slate-900">Tagline: </span>
                        <span className="text-slate-700">{generatedBrain.tagline}</span>
                      </div>
                      <div>
                        <span className="font-bold text-slate-900">Target Industries: </span>
                        <span className="text-slate-700">{generatedBrain.targetIndustries?.join(", ")}</span>
                      </div>
                      <div>
                        <span className="font-bold text-slate-900">Core Benefits: </span>
                        <ul className="list-disc pl-4 mt-1 space-y-0.5 text-slate-600">
                          {generatedBrain.primaryBenefits?.slice(0, 3).map((b, i) => (
                            <li key={i}>{b}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <span className="font-bold text-slate-900">Investor Vision: </span>
                        <span className="text-slate-700">{generatedBrain.investorNarrative?.vision}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Navigation */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
          {step > 1 && step < 5 ? (
            <button
              onClick={() => setStep(step - 1)}
              className="px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-200 rounded-lg transition-colors flex items-center gap-1"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back</span>
            </button>
          ) : (
            <div />
          )}

          {step < 4 && (
            <button
              onClick={() => setStep(step + 1)}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm shadow-blue-500/20 transition-colors flex items-center gap-1.5"
            >
              <span>Next</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}

          {step === 4 && (
            <button
              onClick={handleRunAnalysis}
              className="px-5 py-2 text-xs font-semibold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 rounded-lg shadow-sm shadow-blue-500/20 transition-all flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Generate Company Brain</span>
            </button>
          )}

          {step === 5 && !analyzing && (
            <button
              onClick={handleComplete}
              className="px-6 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow-sm shadow-emerald-500/20 transition-colors flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              <span>Activate Growth Engine & Launch</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
