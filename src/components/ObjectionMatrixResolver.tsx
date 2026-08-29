import React from "react";
import {
  Sparkles,
  Zap,
  ShieldCheck,
  DollarSign,
  PhoneCall,
  Clock,
  CheckCircle2,
  Lock,
  ArrowRight
} from "lucide-react";
import { Conversation, CompanyBrain } from "../types";

interface ObjectionMatrixResolverProps {
  conversation: Conversation;
  onApplyReply: (draftSubject: string, draftBody: string) => void;
  companyBrain?: CompanyBrain | null;
}

interface ObjectionOption {
  id: string;
  category: "PRICING" | "SECURITY_HIPAA" | "CURRENT_RECEPTIONIST" | "BOT_LATENCY" | "SETUP_FRICTION" | "FOLLOW_UP_LATER";
  label: string;
  badge: string;
  description: string;
  suggestedSubject: string;
  suggestedBody: string;
}

export const ObjectionMatrixResolver: React.FC<ObjectionMatrixResolverProps> = ({
  conversation,
  onApplyReply,
  companyBrain,
}) => {
  const firstName = conversation.contactName.split(" ")[0] || "there";
  const company = conversation.companyName || "your clinic";

  const OBJECTION_PRESETS: ObjectionOption[] = [
    {
      id: "obj-receptionist",
      category: "CURRENT_RECEPTIONIST",
      label: "We already have front desk staff",
      badge: "Staffing Defense",
      description: "De-escalates fear of replacing people; positions AI for peak lunch rush & after-5PM triage.",
      suggestedSubject: `Re: ${conversation.subject} - Supporting your front-desk during peak rush`,
      suggestedBody: `Hi ${firstName},

Completely understand — your front-desk team is essential for in-person patient hospitality.

We actually don't replace receptionists; we protect them. During busy lunch hours or after 5 PM, front-desk staff miss ~20-30% of incoming booking calls while checking in patients. Abedin Voice AI acts as the instantaneous safety net so you never drop an appointment.

Could I send a 2-minute mobile demo link to show how it seamlessly forwards back to your staff?

Best,
Nayem`,
    },
    {
      id: "obj-price",
      category: "PRICING",
      label: "Too expensive / What is the cost?",
      badge: "ROI & Unit Economics",
      description: "Frames the starter plan (£299/mo) against a single recovered private appointment (£140).",
      suggestedSubject: `Re: ${conversation.subject} - Abedin Voice AI pricing & ROI breakdown`,
      suggestedBody: `Hi ${firstName},

Our starter clinic tier is £299/month flat (inclusive of all inbound minutes and calendar booking sync).

To put that in perspective: with average appointment fees at £120–£200, recovering just 2 after-hours missed calls per month pays for the entire system, with every subsequent booking being pure practice profit.

Happy to set up a 14-day zero-risk trial on your secondary line so you can measure recovered bookings directly?

Best,
Nayem`,
    },
    {
      id: "obj-latency",
      category: "BOT_LATENCY",
      label: "AI voice sounds robotic / slow",
      badge: "Sub-500ms Voice Proof",
      description: "Directly highlights the ultra-fast sub-500ms speech layer and offers a live telephone demo.",
      suggestedSubject: `Re: ${conversation.subject} - Sub-500ms voice speed (live test)`,
      suggestedBody: `Hi ${firstName},

That is the #1 valid hesitation with older IVR bots.

We built our voice pipeline with sub-500ms conversational turn-around — it pauses when interrupted, handles accents naturally, and responds as quickly as a live human receptionist.

What is the best mobile number to trigger a 30-second live test call so you can test the voice yourself?

Best,
Nayem`,
    },
    {
      id: "obj-security",
      category: "SECURITY_HIPAA",
      label: "Patient data & GDPR / HIPAA compliance",
      badge: "Security Guardrails",
      description: "Assures zero clinical hallucination, end-to-end encryption, and standard EHR integrations.",
      suggestedSubject: `Re: ${conversation.subject} - Patient confidentiality & GDPR safeguards`,
      suggestedBody: `Hi ${firstName},

Patient privacy is built into the architecture:

1. Zero Hallucination: The agent is restricted strictly to scheduling, FAQs, and emergency transfer protocols.
2. Compliance: Fully GDPR & HIPAA compliant with UK/EU data residency and automated PII redaction.
3. Direct EHR/Calendar Sync: Appointments sync directly into your scheduling software without storing raw patient records on third-party servers.

Would you like me to send over our 1-page Security & Compliance Overview whitepaper?

Best,
Nayem`,
    },
  ];

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3 shadow-2xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-amber-500/10 text-amber-600 border border-amber-500/20 flex items-center justify-center font-bold">
            <Zap className="w-3.5 h-3.5" />
          </div>
          <div>
            <h4 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
              <span>1-Click Objection Resolvers</span>
              <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-slate-100 text-slate-600 font-semibold">
                Company Brain Grounded
              </span>
            </h4>
            <p className="text-[10px] text-slate-500">
              Select any prospect hesitation to load the mathematically verified rebuttal
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {OBJECTION_PRESETS.map((preset) => (
          <div
            key={preset.id}
            onClick={() => onApplyReply(preset.suggestedSubject, preset.suggestedBody)}
            className="p-2.5 rounded-lg border border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 cursor-pointer transition-all flex flex-col justify-between group"
          >
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-900 group-hover:text-blue-700">
                  {preset.label}
                </span>
                <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-slate-100 text-slate-700">
                  {preset.badge}
                </span>
              </div>
              <p className="text-[10px] text-slate-500 leading-snug line-clamp-2">
                {preset.description}
              </p>
            </div>

            <div className="flex items-center gap-1 text-[10px] font-bold text-blue-600 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <span>Inject Response</span>
              <ArrowRight className="w-3 h-3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
