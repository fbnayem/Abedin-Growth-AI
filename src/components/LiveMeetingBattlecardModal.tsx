import React, { useState } from "react";
import {
  FileText,
  Printer,
  X,
  Sparkles,
  ShieldCheck,
  Building2,
  Calendar,
  DollarSign,
  AlertOctagon,
  Swords,
  Clock,
  CheckCircle2,
  HelpCircle,
  Copy,
  Check,
  Send
} from "lucide-react";
import { Lead, Investor, CompanyBrain } from "../types";
import { LivePhoneTestWidget } from "./LivePhoneTestWidget";

interface LiveMeetingBattlecardModalProps {
  isOpen: boolean;
  onClose: () => void;
  entity: Lead | Investor;
  type: "CUSTOMER" | "INVESTOR";
  companyBrain?: CompanyBrain | null;
  onScheduleCall?: () => void;
}

export const LiveMeetingBattlecardModal: React.FC<LiveMeetingBattlecardModalProps> = ({
  isOpen,
  onClose,
  entity,
  type,
  companyBrain,
  onScheduleCall,
}) => {
  const [copied, setCopied] = useState(false);
  const isCustomer = type === "CUSTOMER";
  const lead = isCustomer ? (entity as Lead) : null;
  const investor = !isCustomer ? (entity as Investor) : null;

  if (!isOpen) return null;

  const title = isCustomer
    ? `${lead?.name} (${lead?.title})`
    : `${investor?.name} (${investor?.role})`;

  const organization = isCustomer ? lead?.companyName : investor?.fundName;

  const handlePrint = () => {
    window.print();
  };

  const handleCopySummary = () => {
    const text = isCustomer
      ? `MEETING DOSSIER: ${lead?.name} - ${lead?.companyName}
Industry: ${lead?.industry} | Location: ${lead?.country}
Phone Volume: High | Expected Pain: Receptionist overhead & missed patient bookings.
Target Deal: £299/mo Starter Voice Plan + CRM Calendar Sync.
Key Defensibility: Sub-500ms voice response, 15-minute SIP setup, zero hallucination guardrails.`
      : `INVESTOR DOSSIER: ${investor?.name} - ${investor?.fundName}
Stage: ${investor?.stage} | Check: ${investor?.typicalCheckSize} | Sectors: ${investor?.targetSectors?.join(", ")}
Thesis: ${investor?.thesisMatchReason}
Moat: Vertical integration, clinic workflow lock-in, proprietary conversation tuning.`;

    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-xs z-50 flex items-center justify-center p-3 sm:p-4 print:p-0 print:bg-white">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-3xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[92vh] print:max-h-none print:shadow-none print:border-none">
        
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-slate-900 via-slate-850 to-indigo-950 text-white flex items-center justify-between print:bg-none print:text-black print:border-b">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-bold shadow-md shadow-indigo-500/20">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white tracking-tight print:text-black">
                  1-Page Live Call Battlecard
                </h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/30 text-emerald-300 border border-emerald-400/30 font-bold uppercase tracking-wider">
                  Pre-Flight Dossier
                </span>
              </div>
              <p className="text-xs text-slate-300 print:text-slate-600 mt-0.5">
                Target: <strong className="text-white print:text-black">{title}</strong> at <strong className="text-white print:text-black">{organization}</strong>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 print:hidden">
            <button
              onClick={handleCopySummary}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1.5 transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? "Copied" : "Copy Brief"}</span>
            </button>

            <button
              onClick={handlePrint}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              title="Print Dossier"
            >
              <Printer className="w-4 h-4" />
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-4 text-xs">
          {/* Quick Stats Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200/90">
            <div>
              <div className="text-[10px] font-bold text-slate-400 uppercase">Target Entity</div>
              <div className="font-bold text-slate-900 truncate">{organization}</div>
            </div>
            <div>
              <div className="text-[10px] font-bold text-slate-400 uppercase">
                {isCustomer ? "Industry / Focus" : "Stage & Check"}
              </div>
              <div className="font-bold text-slate-900 truncate">
                {isCustomer ? lead?.industry : `${investor?.stage} (${investor?.typicalCheckSize})`}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold text-slate-400 uppercase">Location</div>
              <div className="font-bold text-slate-900 truncate">{entity.country}</div>
            </div>
            <div>
              <div className="text-[10px] font-bold text-slate-400 uppercase">AI Fit Rating</div>
              <div className="font-black text-indigo-700">
                {isCustomer ? `${lead?.aiScore}/100 ICP` : `${investor?.investorFitScore}/100 Match`}
              </div>
            </div>
          </div>

          {/* Section 1: Top 3 Pain Points & Buying Psychology */}
          <div className="space-y-2">
            <h4 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
              1. Prospect Psychology & What Keeps Them Awake
            </h4>
            <div className="p-3 rounded-xl bg-indigo-50/70 border border-indigo-100 space-y-1.5 text-slate-800 leading-relaxed">
              {isCustomer ? (
                <>
                  <p>
                    • <strong>Staffing Burnout:</strong> Receptionists are overwhelmed by repeat inquiries (&quot;What are your hours?&quot;, &quot;Do you take my insurance?&quot;) causing missed high-ticket booking calls.
                  </p>
                  <p>
                    • <strong>After-Hours Revenue Leak:</strong> 25-30% of patient inquiries happen after 5 PM or over the weekend and get lost to competitor clinics.
                  </p>
                  <p>
                    • <strong>Fear of Bot Errors:</strong> Sceptical of AI answering calls inaccurately or hallucinating clinical advice.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    • <strong>Moat Skepticism:</strong> Wondering if raw LLMs or foundation models (OpenAI/Twilio) will make application wrappers obsolete.
                  </p>
                  <p>
                    • <strong>Unit Economics:</strong> Focused on CAC/LTV, monthly telephony margin, and gross margins after ElevenLabs/telephony transit costs.
                  </p>
                  <p>
                    • <strong>Speed to Scale:</strong> Interested in repeatable agency partner channels and enterprise dental/medical clinic rollouts.
                  </p>
                </>
              )}
            </div>
          </div>

          {/* Section 2: Recommended 3-Step Live Call Agenda & Interactive Audio Demo */}
          <div className="space-y-3">
            <h4 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-blue-600" />
              2. Recommended 15-Minute Call Flow & Live Demo
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
                <div className="font-bold text-slate-900 text-[11px]">Min 0-3: The Diagnostic Hook</div>
                <p className="text-[11px] text-slate-600">
                  {isCustomer
                    ? `"How many calls does your front desk drop during peak lunch rush or after 5 PM?"`
                    : `"We built the sub-500ms voice layer specifically for healthcare and high-volume local B2B."`}
                </p>
              </div>

              <div className="p-3 bg-blue-50/60 rounded-xl border border-blue-200 space-y-1">
                <div className="font-bold text-blue-950 text-[11px]">Min 3-8: The Live Audio Proof</div>
                <p className="text-[11px] text-slate-700">
                  {isCustomer
                    ? `Trigger a 30-second live test call directly to their phone to demonstrate human-level latency.`
                    : `Show real clinic dashboard retention metrics, low 0.2% drop-off rate, and 85% gross margin.`}
                </p>
              </div>

              <div className="p-3 bg-emerald-50/60 rounded-xl border border-emerald-200 space-y-1">
                <div className="font-bold text-emerald-950 text-[11px]">Min 8-15: Closing Offer</div>
                <p className="text-[11px] text-slate-700">
                  {isCustomer
                    ? `Propose a 14-day risk-free pilot: forward after-hours calls with zero changes to existing phone numbers.`
                    : `Invite to review the investor data room and schedule partner meeting with lead syndicate.`}
                </p>
              </div>
            </div>

            {/* Embedded Live Phone Tester directly on Battlecard */}
            {isCustomer && (
              <div className="pt-1">
                <LivePhoneTestWidget
                  prospectName={lead?.name}
                  clinicName={lead?.companyName}
                  defaultPhone={lead?.phone || "+44 7700 900077"}
                />
              </div>
            )}
          </div>

          {/* Section 3: Instant Competitor & Objection Landmines */}
          <div className="space-y-2">
            <h4 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-1.5">
              <AlertOctagon className="w-3.5 h-3.5 text-rose-600" />
              3. Landmines & How to Kill Top Objections
            </h4>
            <div className="p-3 rounded-xl bg-rose-50/60 border border-rose-200/80 space-y-2 text-[11px] text-rose-950">
              <div className="flex items-start gap-2">
                <strong className="text-rose-900 shrink-0">Objection: &quot;We already have a receptionist&quot;</strong>
                <span className="text-slate-700">
                  $\rightarrow$ Counter: &quot;We don&apos;t replace your staff; we protect them from repeat FAQs and take over after 5 PM so you never lose high-value weekend bookings.&quot;
                </span>
              </div>
              <div className="flex items-start gap-2">
                <strong className="text-rose-900 shrink-0">Objection: &quot;Is it hard to install?&quot;</strong>
                <span className="text-slate-700">
                  $\rightarrow$ Counter: &quot;Takes under 15 minutes. It is a standard phone forward rule on your existing carrier (BT, RingCentral, Vodafone).&quot;
                </span>
              </div>
            </div>
          </div>

          {/* Section 4: Recommended Target Pricing & Terms */}
          <div className="p-3.5 rounded-xl bg-slate-900 text-white flex items-center justify-between">
            <div>
              <div className="text-[10px] uppercase font-bold text-slate-400">Target Close Deal Structure</div>
              <div className="text-sm font-bold text-emerald-400">
                {isCustomer ? "£299/mo Starter + £0.12/min Overcharge (14-Day Pilot)" : `${investor?.typicalCheckSize} Safe / Priced Seed Round`}
              </div>
            </div>
            {onScheduleCall && (
              <button
                onClick={onScheduleCall}
                className="px-3.5 py-1.5 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs transition-colors"
              >
                Schedule Calendar
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
