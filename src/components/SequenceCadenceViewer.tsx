import React, { useState } from "react";
import {
  Calendar,
  Clock,
  Send,
  Sparkles,
  CheckCircle2,
  Copy,
  Check,
  ShieldCheck,
  ChevronRight,
  Flame,
  ArrowRight,
  TrendingDown
} from "lucide-react";
import { Lead } from "../types";
import { DeliverabilityScanner } from "./DeliverabilityScanner";

interface SequenceCadenceViewerProps {
  lead: Lead;
  onEnrollSequence?: (lead: Lead) => void;
  onSendStep?: (lead: Lead, stepNumber: number, subject: string, body: string) => void;
}

export const SequenceCadenceViewer: React.FC<SequenceCadenceViewerProps> = ({
  lead,
  onEnrollSequence,
  onSendStep,
}) => {
  const [selectedStep, setSelectedStep] = useState<number>(1);
  const [copiedStep, setCopiedStep] = useState<number | null>(null);

  const firstName = lead.name.split(" ")[0] || "there";
  const clinic = lead.companyName || "your clinic";

  const sequenceSteps = [
    {
      step: 1,
      day: "Day 1",
      timing: "Immediate Dispatch",
      title: "The Financial Proof & After-Hours Leak Hook",
      badge: "Revenue Proof",
      badgeColor: "bg-rose-100 text-rose-800 border-rose-200",
      subject: `Quick calculation regarding ${clinic}'s after-hours call volume`,
      body: `Hi ${firstName},

I noticed ${clinic} handles strong patient volume across ${lead.country || "the UK"}.

Based on standard clinic volume (~40 calls/day), practices typically miss 20–25% of patient calls during peak lunch hours and after 5 PM. That represents approximately ~£4,800/month in dropped private consultations.

We built Abedin Voice AI to act as a 24/7 sub-500ms safety net that answers after-hours calls and books appointments directly into your calendar.

Would you be open to a 2-minute test call on your mobile this week to hear how natural the voice speed is?

Best regards,
Nayem
Founder, Abedin Growth AI`,
    },
    {
      step: 2,
      day: "Day 3",
      timing: "3 Days Later",
      title: "The 30-Second Audio Proof & Zero Staff Replacement",
      badge: "Sound Proof & Staff Protection",
      badgeColor: "bg-blue-100 text-blue-800 border-blue-200",
      subject: `Re: Quick calculation regarding ${clinic}'s after-hours call volume`,
      body: `Hi ${firstName},

Following up briefly on my note regarding after-hours booking.

One hesitation clinic managers often have is: "Will the voice sound robotic?"

We tuned our voice layer with sub-500ms conversational turn-around — it pauses when interrupted and transfers emergency cases directly to your on-call clinician.

What is the best direct number to trigger a 30-second live test call for you to test today?

Best,
Nayem`,
    },
    {
      step: 3,
      day: "Day 7",
      timing: "7 Days Later",
      title: "The 14-Day Zero-Risk Trial & Pilot Offer",
      badge: "Breakup / Zero-Risk Pilot",
      badgeColor: "bg-emerald-100 text-emerald-800 border-emerald-200",
      subject: `Permission to set up a 14-day trial on ${clinic}'s secondary line?`,
      body: `Hi ${firstName},

I know you are exceptionally busy managing patient care at ${clinic}.

If improving after-hours patient intake isn't a priority this quarter, no problem at all.

However, if you'd like to test recovering dropped appointments, we offer a 14-day zero-risk trial: we assign a dedicated phone forwarding line, with zero IT installation and zero changes to your existing phone carrier.

Let me know if you'd like me to send over the 1-page setup guide.

Best regards,
Nayem`,
    },
  ];

  const currentStepData = sequenceSteps.find((s) => s.step === selectedStep) || sequenceSteps[0];

  const handleCopy = (text: string, stepNum: number) => {
    navigator.clipboard.writeText(text);
    setCopiedStep(stepNum);
    setTimeout(() => setCopiedStep(null), 2000);
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-4 shadow-xs">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-bold text-slate-900 tracking-tight flex items-center gap-1.5">
              <span>3-Step Automated Follow-Up Cadence</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-700 font-bold border border-indigo-200">
                Healthcare Optimized
              </span>
            </h3>
          </div>
          <p className="text-[11px] text-slate-500">
            Over 68% of booked clinic demos convert on Step 2 or 3 follow-ups
          </p>
        </div>

        {onEnrollSequence && (
          <button
            onClick={() => onEnrollSequence(lead)}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-2xs transition-colors shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Enroll in 3-Step Sequence</span>
          </button>
        )}
      </div>

      {/* Step Selector Horizontal Timeline */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {sequenceSteps.map((s) => {
          const isActive = selectedStep === s.step;
          return (
            <div
              key={s.step}
              onClick={() => setSelectedStep(s.step)}
              className={`p-3 rounded-xl border cursor-pointer transition-all ${
                isActive
                  ? "bg-indigo-50/70 border-indigo-400 shadow-2xs ring-1 ring-indigo-400/50"
                  : "bg-slate-50/60 border-slate-200 hover:bg-slate-100/80"
              }`}
            >
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="font-extrabold text-slate-900">{s.day}</span>
                <span className={`text-[9px] font-bold px-1.5 py-0.2 rounded border ${s.badgeColor}`}>
                  {s.badge}
                </span>
              </div>
              <div className="text-[11px] font-bold text-slate-800 truncate">{s.title}</div>
              <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-1">
                <Clock className="w-3 h-3 text-slate-400" />
                <span>{s.timing}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Active Step Content Preview */}
      <div className="space-y-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200/90 text-xs">
        <div className="flex items-center justify-between">
          <div className="font-bold text-slate-900 flex items-center gap-1.5">
            <span className="w-5 h-5 rounded-full bg-slate-900 text-white text-[10px] flex items-center justify-center font-bold">
              {currentStepData.step}
            </span>
            <span>Subject: {currentStepData.subject}</span>
          </div>

          <button
            onClick={() =>
              handleCopy(`Subject: ${currentStepData.subject}\n\n${currentStepData.body}`, currentStepData.step)
            }
            className="px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg flex items-center gap-1 transition-colors"
          >
            {copiedStep === currentStepData.step ? (
              <>
                <Check className="w-3 h-3 text-emerald-600" />
                <span className="text-emerald-700">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>Copy Step</span>
              </>
            )}
          </button>
        </div>

        <div className="p-3 bg-white rounded-lg border border-slate-200 font-mono text-[11px] text-slate-800 whitespace-pre-wrap leading-relaxed">
          {currentStepData.body}
        </div>

        {/* Deliverability & Pre-flight Scanner for this step */}
        <DeliverabilityScanner
          subject={currentStepData.subject}
          body={currentStepData.body}
        />
      </div>
    </div>
  );
};
