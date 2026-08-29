import React, { useState } from "react";
import {
  Calendar,
  Sparkles,
  Clock,
  Video,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  ShieldAlert,
  Loader2,
  Plus,
  PhoneCall,
  RotateCcw,
  Bell,
  FileCheck,
  CreditCard,
  Send,
} from "lucide-react";
import { Meeting } from "../types";
import { LiveMeetingRoomModal } from "../components/LiveMeetingRoomModal";
import { MissedMeetingRecoveryModal } from "../components/MissedMeetingRecoveryModal";
import { diagnosticFetch } from "../utils/diagnosticFetch";

interface MeetingsViewProps {
  meetings: Meeting[];
  onGenerateBrief: (meeting: Meeting) => Promise<void>;
  onScheduleNew: () => void;
  onRefreshMeetings?: () => void;
}

export const MeetingsView: React.FC<MeetingsViewProps> = ({
  meetings,
  onGenerateBrief,
  onScheduleNew,
  onRefreshMeetings,
}) => {
  const [selectedMeetingId, setSelectedMeetingId] = useState<string>(
    meetings[0]?.id || ""
  );
  const [loadingBrief, setLoadingBrief] = useState(false);
  const [showLiveRoom, setShowLiveRoom] = useState(false);
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [sendingReminder, setSendingReminder] = useState<string | null>(null);

  const activeMeeting = meetings.find((m) => m.id === selectedMeetingId) || meetings[0];

  const handleRunBrief = async () => {
    if (!activeMeeting) return;
    setLoadingBrief(true);
    try {
      await onGenerateBrief(activeMeeting);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingBrief(false);
    }
  };

  const handleSendReminder = async (meetingId: string, type: "24H" | "1H") => {
    setSendingReminder(`${meetingId}_${type}`);
    try {
      const res = await diagnosticFetch(`/api/meetings/${meetingId}/send-reminder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      if (res.ok && onRefreshMeetings) {
        onRefreshMeetings();
      }
    } catch (e) {
      console.error("Failed to send reminder:", e);
    } finally {
      setSendingReminder(null);
    }
  };

  const handleUpdateMeeting = (updated: Meeting) => {
    if (onRefreshMeetings) {
      onRefreshMeetings();
    }
  };

  return (
    <div className="space-y-5">
      {/* Title & Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Calendar & Meetings</h1>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold">
              {meetings.length} Scheduled Calls
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Full autonomous lifecycle: Pre-meeting 24H/1H reminders, Live Voice AI demo room, agreement signing, payment collection, and missed meeting recovery.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onScheduleNew}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-sm transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Schedule Demo Call</span>
          </button>
        </div>
      </div>

      {/* Meeting Selector & Brief Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left Column: Scheduled Calls List (4 cols) */}
        <div className="lg:col-span-4 space-y-3">
          <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-400">
            <span>Scheduled Calls</span>
            <span className="text-[10px] text-slate-500 font-normal">Auto-Reminders Active</span>
          </div>

          <div className="space-y-2.5">
            {meetings.map((m) => {
              const isSelected = activeMeeting?.id === m.id;
              const dateObj = new Date(m.scheduledTime);
              return (
                <div
                  key={m.id}
                  onClick={() => setSelectedMeetingId(m.id)}
                  className={`p-4 rounded-2xl border transition-all cursor-pointer space-y-2.5 ${
                    isSelected
                      ? "bg-blue-50/80 border-blue-500 shadow-xs ring-1 ring-blue-400/40"
                      : "bg-white border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${
                        m.status === "MISSED"
                          ? "bg-rose-100 text-rose-800 border border-rose-200"
                          : m.firstPaymentPaid
                          ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                          : m.contractSigned
                          ? "bg-purple-100 text-purple-800 border border-purple-200"
                          : "bg-blue-100 text-blue-800 border border-blue-200"
                      }`}
                    >
                      {m.status === "MISSED"
                        ? "MISSED / NO-SHOW"
                        : m.firstPaymentPaid
                        ? "CLOSED WON (£499)"
                        : m.contractSigned
                        ? "AGREEMENT SIGNED"
                        : m.category}
                    </span>

                    <span className="text-xs font-mono text-slate-500 font-semibold flex items-center gap-1">
                      <Clock className="w-3 h-3 text-slate-400" />
                      {dateObj.toLocaleDateString([], { month: "short", day: "numeric" })},{" "}
                      {dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>

                  <div>
                    <h3 className="text-xs font-bold text-slate-900">{m.title}</h3>
                    <div className="text-xs text-slate-600 mt-0.5">
                      {m.prospectName} • {m.companyName}
                    </div>
                  </div>

                  {/* Lifecycle Tags */}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {m.reminders?.reminder24hSent && (
                      <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200 flex items-center gap-1">
                        <CheckCircle2 className="w-2.5 h-2.5 text-emerald-600" />
                        <span>24h Reminder Sent</span>
                      </span>
                    )}
                    {m.reminders?.reminder1hSent && (
                      <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200 flex items-center gap-1">
                        <CheckCircle2 className="w-2.5 h-2.5 text-emerald-600" />
                        <span>1h Reminder Sent</span>
                      </span>
                    )}
                    {m.missedRecoveryStage && (
                      <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1">
                        <RotateCcw className="w-2.5 h-2.5 text-amber-600" />
                        <span>Recovery Stage {m.missedRecoveryStage}</span>
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: AI Pre-Meeting Brief & Live Room Launcher (8 cols) */}
        {activeMeeting ? (
          <div className="lg:col-span-8 bg-white rounded-2xl border border-slate-200 shadow-2xs p-6 space-y-6">
            {/* Brief Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-blue-600" />
                  <h2 className="text-base font-bold text-slate-900">Meeting & Deal Closing Console</h2>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Prepared for call with <strong>{activeMeeting.prospectName}</strong> ({activeMeeting.companyName})
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={handleRunBrief}
                  disabled={loadingBrief}
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {loadingBrief ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Generating...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>AI Brief</span>
                    </>
                  )}
                </button>

                <button
                  onClick={() => setShowLiveRoom(true)}
                  className="px-3.5 py-1.5 rounded-xl text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-sm transition-colors flex items-center gap-1.5"
                >
                  <PhoneCall className="w-3.5 h-3.5" />
                  <span>Launch Live Closing Room</span>
                </button>
              </div>
            </div>

            {/* Quick Action Toolbar: Reminders, Contract, Missed Recovery */}
            <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                  Automations:
                </span>

                <button
                  onClick={() => handleSendReminder(activeMeeting.id, "24H")}
                  disabled={sendingReminder === `${activeMeeting.id}_24H`}
                  className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 flex items-center gap-1.5 transition-colors"
                >
                  <Bell className="w-3 h-3 text-blue-600" />
                  <span>{activeMeeting.reminders?.reminder24hSent ? "Resend 24H Reminder" : "Send 24H Reminder"}</span>
                </button>

                <button
                  onClick={() => handleSendReminder(activeMeeting.id, "1H")}
                  disabled={sendingReminder === `${activeMeeting.id}_1H`}
                  className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 flex items-center gap-1.5 transition-colors"
                >
                  <Clock className="w-3 h-3 text-amber-600" />
                  <span>{activeMeeting.reminders?.reminder1hSent ? "Resend 1H Reminder" : "Send 1H Reminder"}</span>
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowRecoveryModal(true)}
                  className="px-2.5 py-1 text-xs font-bold rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300 flex items-center gap-1.5 transition-colors"
                >
                  <RotateCcw className="w-3 h-3 text-amber-700" />
                  <span>Missed Call Recovery</span>
                </button>
              </div>
            </div>

            {/* Deal Status Card (Agreement & First Payment) */}
            {(activeMeeting.contractSigned || activeMeeting.firstPaymentPaid) && (
              <div className="p-4 bg-emerald-50 rounded-xl border border-emerald-200 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-emerald-950 flex items-center gap-1.5">
                    <FileCheck className="w-4 h-4 text-emerald-700" />
                    <span>Agreement & Deal Conversion Status</span>
                  </span>
                  <span className="text-[11px] font-mono font-bold text-emerald-800">
                    {activeMeeting.firstPaymentPaid ? "PAID & CLOSED WON" : "AGREEMENT EXECUTED"}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-emerald-900 font-mono">
                  <div>
                    Signatory: <strong>{activeMeeting.signedBy || activeMeeting.prospectName}</strong>
                  </div>
                  <div>
                    First Payment: <strong>{activeMeeting.firstPaymentPaid ? `£${activeMeeting.firstPaymentAmount || 499}.00 GBP (Settled)` : "Pending settlement"}</strong>
                  </div>
                </div>
              </div>
            )}

            {/* Brief Sections */}
            {activeMeeting.aiBrief ? (
              <div className="space-y-5">
                {/* Key Goals */}
                {(activeMeeting.aiBrief.keyGoals || (activeMeeting.aiBrief as any).summary) && (
                  <div className="p-4 bg-blue-50/70 rounded-xl border border-blue-100 space-y-2">
                    <div className="text-xs font-bold uppercase tracking-wider text-blue-900 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                      <span>Key Meeting Objectives</span>
                    </div>
                    {(activeMeeting.aiBrief as any).summary && (
                      <p className="text-xs text-slate-700 leading-relaxed font-medium">
                        {(activeMeeting.aiBrief as any).summary}
                      </p>
                    )}
                    {activeMeeting.aiBrief.keyGoals && activeMeeting.aiBrief.keyGoals.length > 0 && (
                      <ul className="space-y-1">
                        {activeMeeting.aiBrief.keyGoals.map((goal, i) => (
                          <li key={i} className="text-xs text-slate-700 flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0" />
                            <span>{goal}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* Key Pain Points */}
                <div className="space-y-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Primary Operational Pain Points
                  </div>
                  <ul className="space-y-1.5">
                    {(
                      activeMeeting.aiBrief.potentialPains ||
                      (activeMeeting.aiBrief as any).keyPainPoints ||
                      []
                    ).map((pain: string, i: number) => (
                      <li
                        key={i}
                        className="text-xs text-slate-700 flex items-start gap-2 bg-slate-50 p-2.5 rounded-lg border border-slate-200/60"
                      >
                        <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                        <span>{pain}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Recommended Demo Flow */}
                <div className="space-y-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Recommended 20-Minute Demo Flow
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {(activeMeeting.aiBrief.recommendedDemoFlow || []).map((step, i) => (
                      <div
                        key={i}
                        className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs text-slate-800 space-y-1"
                      >
                        <div className="font-bold text-blue-600">Step {i + 1}</div>
                        <p>{step}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Objections to Anticipate */}
                {activeMeeting.aiBrief.objectionsToAnticipate && activeMeeting.aiBrief.objectionsToAnticipate.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
                      Objections To Anticipate
                    </div>
                    <ul className="space-y-1.5">
                      {activeMeeting.aiBrief.objectionsToAnticipate.map((obj, i) => (
                        <li
                          key={i}
                          className="text-xs text-slate-700 flex items-start gap-2 bg-amber-50/50 p-2.5 rounded-lg border border-amber-100"
                        >
                          <HelpCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                          <span>{obj}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Questions to Ask */}
                <div className="space-y-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    High-Impact Discovery Questions
                  </div>
                  <ul className="space-y-1.5">
                    {(activeMeeting.aiBrief.questionsToAsk || []).map((q, i) => (
                      <li
                        key={i}
                        className="text-xs text-slate-700 flex items-start gap-2 bg-emerald-50/50 p-2.5 rounded-lg border border-emerald-100"
                      >
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                        <span>{q}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="py-12 text-center space-y-3">
                <Sparkles className="w-10 h-10 text-blue-500 mx-auto" />
                <div className="space-y-1">
                  <h3 className="text-sm font-bold text-slate-800">Generate Brief with Gemini</h3>
                  <p className="text-xs text-slate-500 max-w-sm mx-auto">
                    Synthesize background intelligence, discovery questions, and demo agenda for this meeting.
                  </p>
                </div>
                <button
                  onClick={handleRunBrief}
                  disabled={loadingBrief}
                  className="px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm transition-colors"
                >
                  Generate AI Brief Now
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="lg:col-span-8 flex items-center justify-center p-12 text-slate-400">
            No meetings selected
          </div>
        )}
      </div>

      {/* Live Meeting Room Modal */}
      {showLiveRoom && activeMeeting && (
        <LiveMeetingRoomModal
          meeting={activeMeeting}
          onClose={() => setShowLiveRoom(false)}
          onUpdateMeeting={handleUpdateMeeting}
        />
      )}

      {/* Missed Meeting Recovery Modal */}
      {showRecoveryModal && activeMeeting && (
        <MissedMeetingRecoveryModal
          meeting={activeMeeting}
          onClose={() => setShowRecoveryModal(false)}
          onUpdateMeeting={handleUpdateMeeting}
        />
      )}
    </div>
  );
};

