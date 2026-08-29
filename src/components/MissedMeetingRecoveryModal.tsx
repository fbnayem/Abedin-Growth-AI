import React, { useState } from "react";
import {
  X,
  Send,
  Sparkles,
  AlertTriangle,
  RotateCcw,
  Video,
  TrendingUp,
  PhoneCall,
  CheckCircle2,
  Calendar,
  Clock,
  ArrowRight,
} from "lucide-react";
import { Meeting } from "../types";
import { diagnosticFetch } from "../utils/diagnosticFetch";

interface MissedMeetingRecoveryModalProps {
  meeting: Meeting;
  onClose: () => void;
  onUpdateMeeting: (updated: Meeting) => void;
}

export const MissedMeetingRecoveryModal: React.FC<MissedMeetingRecoveryModalProps> = ({
  meeting,
  onClose,
  onUpdateMeeting,
}) => {
  const [selectedVariation, setSelectedVariation] = useState<1 | 2 | 3 | 4>(
    (meeting.missedRecoveryStage as 1 | 2 | 3 | 4) || 1
  );
  const [sending, setSending] = useState(false);
  const [sendSuccess, setSendSuccess] = useState(false);
  const [lastSentEmail, setLastSentEmail] = useState<any>(null);

  const variations = [
    {
      id: 1 as const,
      name: "Type 1: 15-Min Quick Reconnect",
      badge: "Immediate Re-Book",
      icon: Clock,
      description: "Dispatched 15 minutes post-miss. Assumes a sudden urgent patient emergency at the clinic and provides immediate 1-click reschedule link.",
      subject: `Rescheduling our demo // ${meeting.companyName} x Abedin Voice AI`,
      preview: `Hi ${meeting.prospectName}, I hope everything is okay! I was on our Google Meet but completely understand if an urgent patient or clinic emergency came up. Would later today or tomorrow work best to jump on?`,
    },
    {
      id: 2 as const,
      name: "Type 2: 90-Sec Loom Video Demo",
      badge: "Loom Screen Recording",
      icon: Video,
      description: "Dispatched 24 hours later. Embeds a 90-second customized Loom screen-recording of Abedin Voice AI booking a slot directly on Google Calendar.",
      subject: `90-second video demo recorded for ${meeting.companyName} [Google Calendar Integration]`,
      preview: `Hi ${meeting.prospectName}, since we missed each other yesterday, I recorded a 90-second screen capture showing exactly how Abedin Voice AI answers after-hours patient calls and writes appointments directly into your calendar.`,
    },
    {
      id: 3 as const,
      name: "Type 3: Lost Patient Revenue Audit",
      badge: "Missed Call Revenue",
      icon: TrendingUp,
      description: "Dispatched 3 days later. Calculates £14,400/year estimated lost revenue from unhandled weekend and evening clinic phone calls.",
      subject: `Quick math on missed patient calls for ${meeting.companyName}`,
      preview: `Hi ${meeting.prospectName}, based on average dental clinic metrics, unhandled evening and weekend patient inquiries cost approximately £1,200/month (£14,400/yr) in lost high-ticket treatments. Let's do a 5-min demo.`,
    },
    {
      id: 4 as const,
      name: "Type 4: Live Phone Number Test",
      badge: "Direct Interactive Test",
      icon: PhoneCall,
      description: "Dispatched 5 days later. Invites the practice principal to call a dedicated demo telephone line directly from their mobile right now.",
      subject: `Call this number to test our Voice AI directly: +44 20 7946 0991`,
      preview: `Hi ${meeting.prospectName}, no need to do a full video call if your clinic schedule is packed. Just dial our live demonstration line on +44 20 7946 0991 and try to book an emergency toothache slot.`,
    },
  ];

  const activeVar = variations.find((v) => v.id === selectedVariation) || variations[0];

  const handleSendRecoveryEmail = async () => {
    setSending(true);
    try {
      const res = await diagnosticFetch(`/api/meetings/${meeting.id}/send-recovery-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variation: selectedVariation }),
      });
      if (res.ok) {
        const data = await res.json();
        setSendSuccess(true);
        setLastSentEmail(data.result.emailMessage);
        onUpdateMeeting(data.meeting);
      }
    } catch (e) {
      console.error("Failed to send recovery email:", e);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-600 flex items-center justify-center font-bold text-white shadow-inner">
              <RotateCcw className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white tracking-tight">
                  Missed Meeting Re-Booking & Recovery Engine
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-400/30">
                  Persistent Lead Nurturing
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Target: {meeting.prospectName} ({meeting.companyName})
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {/* Strategy Intro */}
          <div className="bg-amber-50/80 rounded-xl p-4 border border-amber-200/80 space-y-1">
            <div className="text-xs font-bold text-amber-900 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-amber-600" />
              <span>Multi-Touch Missed Meeting Recovery Sequence</span>
            </div>
            <p className="text-xs text-amber-700 leading-relaxed">
              If a lead misses their scheduled Google Meet demo, our autonomous engine contacts them with tailored email variations across 5 days to ensure the meeting happens.
            </p>
          </div>

          {/* Sequence Variation Selector */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
              Select Recovery Touchpoint / Sequence Stage:
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {variations.map((v) => {
                const IconComp = v.icon;
                const isSelected = selectedVariation === v.id;
                return (
                  <button
                    key={v.id}
                    onClick={() => {
                      setSelectedVariation(v.id);
                      setSendSuccess(false);
                    }}
                    className={`p-3.5 rounded-xl border text-left transition-all space-y-1.5 ${
                      isSelected
                        ? "border-amber-500 bg-amber-50/50 ring-2 ring-amber-500/20"
                        : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <IconComp className={`w-4 h-4 ${isSelected ? "text-amber-600" : "text-slate-500"}`} />
                        <span className="text-xs font-bold text-slate-900">{v.name}</span>
                      </div>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
                        {v.badge}
                      </span>
                    </div>

                    <p className="text-[11px] text-slate-600 leading-relaxed">{v.description}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Live Draft Preview */}
          <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2">
              <span className="text-xs font-bold text-slate-700">
                Email Subject: <span className="text-slate-900 font-semibold">{activeVar.subject}</span>
              </span>
              <span className="text-[11px] font-mono text-slate-500">To: {meeting.prospectEmail}</span>
            </div>

            <div className="text-xs text-slate-700 bg-white p-3.5 rounded-lg border border-slate-200 leading-relaxed font-mono whitespace-pre-wrap">
              {activeVar.preview}
              {"\n\n"}
              {`Let's get this rescheduled:\nhttps://cal.com/abedin-growth/demo?guest=${encodeURIComponent(meeting.prospectEmail)}`}
              {"\n\n"}
              {`Best regards,\nNayem Abedin\nFounder, Abedin Tech`}
            </div>
          </div>

          {/* Send Feedback */}
          {sendSuccess && (
            <div className="p-3.5 bg-emerald-50 rounded-xl border border-emerald-200 flex items-center gap-2.5 text-xs text-emerald-800 animate-in fade-in">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>
                <strong>Recovery Email Successfully Dispatched!</strong> Recorded in Outbox and conversation thread.
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800"
          >
            Close
          </button>

          <button
            onClick={handleSendRecoveryEmail}
            disabled={sending}
            className="px-5 py-2.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold shadow-sm transition-all flex items-center gap-2 disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" />
            <span>{sending ? "Dispatching Email..." : `Dispatch Recovery Email (Stage ${selectedVariation})`}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
