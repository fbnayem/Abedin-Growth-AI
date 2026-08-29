import React, { useState, useEffect } from "react";
import {
  X,
  Sparkles,
  PhoneCall,
  Volume2,
  Mic,
  Calendar,
  CheckCircle2,
  FileText,
  CreditCard,
  Lock,
  ArrowRight,
  Download,
  Clock,
  ShieldCheck,
  Zap,
  Activity,
  Play,
  Pause,
  RotateCcw,
  Check,
  ExternalLink,
} from "lucide-react";
import { Meeting } from "../types";
import { diagnosticFetch } from "../utils/diagnosticFetch";

interface LiveMeetingRoomModalProps {
  meeting: Meeting;
  onClose: () => void;
  onUpdateMeeting: (updated: Meeting) => void;
}

export const LiveMeetingRoomModal: React.FC<LiveMeetingRoomModalProps> = ({
  meeting,
  onClose,
  onUpdateMeeting,
}) => {
  const [activeStep, setActiveStep] = useState<1 | 2 | 3>(
    meeting.firstPaymentPaid ? 3 : meeting.contractSigned ? 3 : 1
  );

  // --- Step 1: Live Voice AI Demo State ---
  const [callStatus, setCallStatus] = useState<"IDLE" | "CONNECTING" | "ACTIVE" | "COMPLETED">("IDLE");
  const [activeScenario, setActiveScenario] = useState<"EMERGENCY" | "RESCHEDULE" | "PRICING">("EMERGENCY");
  const [currentTurn, setCurrentTurn] = useState<number>(0);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [latencyMs, setLatencyMs] = useState(420);

  const demoScenarios = {
    EMERGENCY: [
      {
        speaker: "PATIENT",
        name: "Caller (Patient)",
        text: "Hi, I have an agonizing toothache that flared up two hours ago. Do you have any emergency morning slots available tomorrow?",
        duration: "0:04",
      },
      {
        speaker: "AI",
        name: "Abedin Voice AI (Receptionist)",
        text: `Hello, thank you for calling ${meeting.companyName}! I'm so sorry you're in pain. Let me prioritize an urgent appointment for you right away. I have an emergency slot tomorrow morning with Dr. Vance at 9:30 AM or 11:15 AM. Would 9:30 AM work best?`,
        duration: "0:06",
        latency: "395ms",
        calendarAction: `Queried Google Calendar API in 48ms: 2 open slots found`,
      },
      {
        speaker: "PATIENT",
        name: "Caller (Patient)",
        text: "9:30 AM is perfect, thank you so much.",
        duration: "0:02",
      },
      {
        speaker: "AI",
        name: "Abedin Voice AI (Receptionist)",
        text: `You are all confirmed for tomorrow at 9:30 AM at ${meeting.companyName}. I have sent an instant SMS confirmation to your mobile with clinic directions and parking info. Please arrive 5 minutes early. Take care!`,
        duration: "0:07",
        latency: "410ms",
        calendarAction: `Reserved 9:30 AM on Google Calendar • Sent SMS triage confirmation to patient`,
      },
    ],
    RESCHEDULE: [
      {
        speaker: "PATIENT",
        name: "Caller (Patient)",
        text: "Hello, I need to reschedule my dental hygiene appointment from Thursday afternoon to Friday morning.",
        duration: "0:04",
      },
      {
        speaker: "AI",
        name: "Abedin Voice AI (Receptionist)",
        text: `Of course! I can help you with that right now. Looking at your records for Friday, we have a hygiene opening at 10:00 AM or 11:30 AM. Which would you prefer?`,
        duration: "0:05",
        latency: "420ms",
        calendarAction: `2-way Google Calendar updated in 82ms • Released Thursday slot`,
      },
    ],
    PRICING: [
      {
        speaker: "PATIENT",
        name: "Caller (Patient)",
        text: "Hi, how much does an initial consultation for Invisalign clear aligners cost at your surgery?",
        duration: "0:04",
      },
      {
        speaker: "AI",
        name: "Abedin Voice AI (Receptionist)",
        text: `Our comprehensive Invisalign consultation is £45 and includes a 3D digital iTero scan with the specialist dentist. If you proceed with treatment, the £45 fee is fully credited toward your plan. Would you like to book a scan this week?`,
        duration: "0:07",
        latency: "405ms",
        calendarAction: `Clinical guardrail policy: Accurate pricing delivered with 0% hallucination`,
      },
    ],
  };

  const activeTranscript = demoScenarios[activeScenario];

  const handleStartCall = () => {
    setCallStatus("CONNECTING");
    setTimeout(() => {
      setCallStatus("ACTIVE");
      setCurrentTurn(0);
      setIsPlayingAudio(true);
    }, 900);
  };

  const handleNextTurn = () => {
    if (currentTurn < activeTranscript.length - 1) {
      setCurrentTurn((prev) => prev + 1);
      setLatencyMs(380 + Math.floor(Math.random() * 80));
    } else {
      setCallStatus("COMPLETED");
      setIsPlayingAudio(false);
    }
  };

  // --- Step 2: Digital Agreement State ---
  const [clientSignerName, setClientSignerName] = useState(
    meeting.signedBy || meeting.prospectName || "Dr. Practice Principal"
  );
  const [practiceName, setPracticeName] = useState(meeting.companyName);
  const [agreedTerms, setAgreedTerms] = useState(true);
  const [signingContract, setSigningContract] = useState(false);
  const [contractSignedSuccess, setContractSignedSuccess] = useState(Boolean(meeting.contractSigned));

  const handleSignContract = async () => {
    setSigningContract(true);
    try {
      const res = await diagnosticFetch(`/api/meetings/${meeting.id}/sign-contract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSignerName,
          practiceName,
          agreedTerms,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setContractSignedSuccess(true);
        onUpdateMeeting(data.meeting);
        setActiveStep(3);
      }
    } catch (e) {
      console.error("Failed to sign contract:", e);
    } finally {
      setSigningContract(false);
    }
  };

  // --- Step 3: First Payment State ---
  const [processingPayment, setProcessingPayment] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState(Boolean(meeting.firstPaymentPaid));
  const [txId, setTxId] = useState(meeting.firstPaymentTxId || "");

  const handleProcessPayment = async () => {
    setProcessingPayment(true);
    try {
      const res = await diagnosticFetch(`/api/meetings/${meeting.id}/process-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: 499,
          paymentMethod: "CARD_ONLINE",
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setPaymentSuccess(true);
        setTxId(data.result.txId);
        onUpdateMeeting(data.meeting);
      }
    } catch (e) {
      console.error("Failed to process first payment:", e);
    } finally {
      setProcessingPayment(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center font-bold text-white shadow-inner">
              <PhoneCall className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white tracking-tight">
                  Live Meeting & Closing Room
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/20 text-blue-300 border border-blue-400/30">
                  Google Meet Active
                </span>
              </div>
              <p className="text-xs text-slate-400">
                {meeting.prospectName} • {meeting.companyName}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Step Navigation Pill */}
            <div className="hidden sm:flex items-center bg-slate-800 rounded-lg p-1 text-xs">
              <button
                onClick={() => setActiveStep(1)}
                className={`px-3 py-1 rounded-md font-semibold transition-all flex items-center gap-1.5 ${
                  activeStep === 1
                    ? "bg-blue-600 text-white"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <span>1. Live Voice AI Demo</span>
              </button>

              <button
                onClick={() => setActiveStep(2)}
                className={`px-3 py-1 rounded-md font-semibold transition-all flex items-center gap-1.5 ${
                  activeStep === 2
                    ? "bg-blue-600 text-white"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <span>2. Sign Agreement</span>
                {contractSignedSuccess && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
              </button>

              <button
                onClick={() => setActiveStep(3)}
                className={`px-3 py-1 rounded-md font-semibold transition-all flex items-center gap-1.5 ${
                  activeStep === 3
                    ? "bg-blue-600 text-white"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <span>3. First Payment</span>
                {paymentSuccess && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
              </button>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {/* STEP 1: LIVE VOICE AI DEMO */}
          {activeStep === 1 && (
            <div className="space-y-6">
              {/* Context Banner */}
              <div className="bg-blue-50/80 rounded-xl p-4 border border-blue-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-blue-600" />
                    <span>Interactive Abedin Voice AI Telephony Simulation</span>
                  </div>
                  <p className="text-xs text-blue-700">
                    Demonstrate sub-500ms voice speed and direct 2-way Google Calendar booking live to {meeting.prospectName}.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono font-bold bg-white px-2.5 py-1 rounded-lg border border-blue-200 text-blue-800 flex items-center gap-1 shadow-2xs">
                    <Zap className="w-3.5 h-3.5 text-amber-500" />
                    <span>Response Latency: {latencyMs}ms</span>
                  </span>
                </div>
              </div>

              {/* Scenario Selector */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                  Test Scenario:
                </span>
                <div className="flex gap-1.5">
                  {[
                    { id: "EMERGENCY", label: "Emergency Toothache Triage" },
                    { id: "RESCHEDULE", label: "Calendar Reschedule" },
                    { id: "PRICING", label: "Treatment Price Inquiry" },
                  ].map((sc) => (
                    <button
                      key={sc.id}
                      onClick={() => {
                        setActiveScenario(sc.id as any);
                        setCurrentTurn(0);
                        setCallStatus("IDLE");
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                        activeScenario === sc.id
                          ? "bg-slate-900 text-white shadow-2xs"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      }`}
                    >
                      {sc.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Telephony Simulator Console */}
              <div className="bg-slate-950 rounded-2xl p-5 text-white space-y-4 border border-slate-800 shadow-lg">
                {/* Status Bar */}
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-3 h-3 rounded-full ${
                        callStatus === "ACTIVE"
                          ? "bg-emerald-500 animate-pulse"
                          : callStatus === "CONNECTING"
                          ? "bg-amber-500 animate-ping"
                          : "bg-slate-600"
                      }`}
                    />
                    <span className="text-xs font-mono font-bold text-slate-300">
                      {callStatus === "IDLE"
                        ? "PHONE LINE READY (+44 20 7946 0991)"
                        : callStatus === "CONNECTING"
                        ? "SIP TRUNK ESTABLISHING..."
                        : callStatus === "ACTIVE"
                        ? "CALL IN PROGRESS • 24/7 AI RECEPTIONIST ACTIVE"
                        : "CALL COMPLETED & LOGGED TO CRM"}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-xs font-mono text-slate-400">
                    <span className="flex items-center gap-1">
                      <Activity className="w-3.5 h-3.5 text-blue-400" />
                      <span>WebRTC SIP HD</span>
                    </span>
                    <span>Direct: {meeting.companyName}</span>
                  </div>
                </div>

                {/* Call Transcript Area */}
                <div className="min-h-[180px] max-h-[260px] overflow-y-auto space-y-3 py-2 pr-2">
                  {callStatus === "IDLE" ? (
                    <div className="h-full flex flex-col items-center justify-center py-8 text-center space-y-2 text-slate-400">
                      <PhoneCall className="w-8 h-8 text-slate-600 animate-bounce" />
                      <p className="text-xs font-medium">
                        Click "Simulate Live Phone Call" below to run the sub-500ms voice dialogue with {meeting.companyName}'s virtual receptionist.
                      </p>
                    </div>
                  ) : (
                    activeTranscript.slice(0, currentTurn + 1).map((msg, idx) => (
                      <div
                        key={idx}
                        className={`p-3.5 rounded-xl text-xs space-y-1 transition-all ${
                          msg.speaker === "AI"
                            ? "bg-blue-950/80 border border-blue-800 text-blue-100 ml-4"
                            : "bg-slate-800 border border-slate-700 text-slate-100 mr-4"
                        }`}
                      >
                        <div className="flex items-center justify-between text-[11px] font-bold text-slate-400">
                          <span className={msg.speaker === "AI" ? "text-blue-400" : "text-slate-300"}>
                            {msg.name}
                          </span>
                          {msg.latency && (
                            <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-800">
                              ⚡ Latency: {msg.latency}
                            </span>
                          )}
                        </div>

                        <p className="text-xs leading-relaxed font-medium">{msg.text}</p>

                        {msg.calendarAction && (
                          <div className="mt-1 pt-1.5 border-t border-blue-900/60 flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                            <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                            <span>{msg.calendarAction}</span>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>

                {/* Controls */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800">
                  <div className="flex items-center gap-2">
                    {callStatus === "IDLE" ? (
                      <button
                        onClick={handleStartCall}
                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold flex items-center gap-2 shadow-sm transition-all"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Simulate Live Phone Call</span>
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={handleNextTurn}
                          disabled={callStatus === "COMPLETED"}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold flex items-center gap-2 disabled:opacity-50 transition-all"
                        >
                          <Volume2 className="w-3.5 h-3.5" />
                          <span>{currentTurn < activeTranscript.length - 1 ? "Next Dialogue Turn" : "Complete Call"}</span>
                        </button>

                        <button
                          onClick={() => {
                            setCallStatus("IDLE");
                            setCurrentTurn(0);
                          }}
                          className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>Reset</span>
                        </button>
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setActiveStep(2)}
                      className="px-4 py-2 bg-slate-100 hover:bg-white text-slate-900 rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm transition-all"
                    >
                      <span>Proceed to Agreement Signing</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: DIGITAL AGREEMENT SIGNING */}
          {activeStep === 2 && (
            <div className="space-y-6">
              <div className="bg-emerald-50/80 rounded-xl p-4 border border-emerald-200/80 flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="text-xs font-bold text-emerald-900 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-600" />
                    <span>Master Software & Voice AI Services Agreement</span>
                  </div>
                  <p className="text-xs text-emerald-700">
                    Executing official agreement between Abedin Tech and {meeting.companyName}.
                  </p>
                </div>

                <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
                  £499/mo • 14-Day Guarantee
                </span>
              </div>

              {/* Agreement Document Card */}
              <div className="bg-slate-50 rounded-2xl p-5 border border-slate-200 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">
                      Standard Practice Pilot & Subscription Agreement
                    </h3>
                    <p className="text-[11px] text-slate-500 font-mono">
                      Ref: AGR-ABN-{meeting.id.toUpperCase()}
                    </p>
                  </div>

                  <div className="text-xs font-mono font-bold text-slate-600">
                    SLA: 99.9% 24/7 Voice Uptime
                  </div>
                </div>

                <div className="space-y-3 text-xs text-slate-700 leading-relaxed bg-white p-4 rounded-xl border border-slate-200">
                  <p>
                    <strong>1. Service Scope:</strong> Abedin Tech provides {meeting.companyName} with proprietary 24/7 conversational voice AI receptionist software, sub-500ms response telephony routing, and real-time 2-way Google Calendar scheduling integration.
                  </p>
                  <p>
                    <strong>2. Commercial Terms:</strong> Standard monthly software subscription of <strong>£499.00 GBP</strong> per month, billed monthly. Includes unlimited after-hours patient telephone answering, SMS confirmations, and HIPAA/UK GDPR compliant data handling.
                  </p>
                  <p>
                    <strong>3. 30-Day Money-Back Guarantee:</strong> If the practice is not 100% satisfied within the first 30 days of active telephony deployment, Abedin Tech will refund the full subscription fee with no questions asked.
                  </p>
                  <p>
                    <strong>4. Data Security:</strong> Patient records and call transcripts are encrypted in transit and at rest adhering to UK Data Protection Act 2018 and NHS standard cryptographic specifications.
                  </p>
                </div>

                {/* Signature Form */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-700">
                      Authorized Practice Signatory Name
                    </label>
                    <input
                      type="text"
                      value={clientSignerName}
                      onChange={(e) => setClientSignerName(e.target.value)}
                      className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-700">
                      Practice / Clinic Legal Entity
                    </label>
                    <input
                      type="text"
                      value={practiceName}
                      onChange={(e) => setPracticeName(e.target.value)}
                      className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                {/* Digital Signature Confirmation */}
                <div className="flex items-center gap-2 pt-2">
                  <input
                    type="checkbox"
                    id="termsAgree"
                    checked={agreedTerms}
                    onChange={(e) => setAgreedTerms(e.target.checked)}
                    className="w-4 h-4 rounded-sm text-blue-600 border-slate-300 focus:ring-blue-500"
                  />
                  <label htmlFor="termsAgree" className="text-xs text-slate-700 font-medium">
                    I confirm that I am authorized to execute this agreement on behalf of {practiceName} and accept the terms of service.
                  </label>
                </div>

                {/* Sign Button */}
                <div className="flex items-center justify-between pt-3 border-t border-slate-200">
                  <button
                    onClick={() => setActiveStep(1)}
                    className="px-3.5 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800"
                  >
                    Back to Live Demo
                  </button>

                  <button
                    onClick={handleSignContract}
                    disabled={signingContract || !agreedTerms || !clientSignerName}
                    className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold shadow-sm transition-all flex items-center gap-2 disabled:opacity-50"
                  >
                    <Check className="w-4 h-4" />
                    <span>{contractSignedSuccess ? "Agreement Executed • Proceed to Payment" : "Sign Agreement & Proceed"}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: FIRST PAYMENT COLLECTION */}
          {activeStep === 3 && (
            <div className="space-y-6">
              <div className="bg-blue-50/80 rounded-xl p-4 border border-blue-200/80 flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                    <CreditCard className="w-4 h-4 text-blue-600" />
                    <span>First Month Deposit & Practice Activation</span>
                  </div>
                  <p className="text-xs text-blue-700">
                    Process initial subscription payment of £499.00 to activate live clinic phone routing.
                  </p>
                </div>

                <span className="text-xs font-bold font-mono px-3 py-1 rounded-full bg-blue-100 text-blue-800 border border-blue-300">
                  £499.00 GBP
                </span>
              </div>

              {paymentSuccess ? (
                <div className="p-8 bg-emerald-50/70 rounded-2xl border border-emerald-200 text-center space-y-4 animate-in fade-in zoom-in-95">
                  <div className="w-14 h-14 rounded-full bg-emerald-600 text-white mx-auto flex items-center justify-center shadow-md">
                    <CheckCircle2 className="w-8 h-8" />
                  </div>

                  <div className="space-y-1">
                    <h3 className="text-base font-bold text-emerald-950">
                      🎉 Payment Confirmed & Deal Closed Won!
                    </h3>
                    <p className="text-xs text-emerald-800 max-w-md mx-auto">
                      First payment of £499.00 GBP successfully settled. Practice phone onboarding for <strong>{meeting.companyName}</strong> is now live.
                    </p>
                  </div>

                  <div className="bg-white rounded-xl p-4 border border-emerald-200 max-w-md mx-auto text-left text-xs space-y-1.5 font-mono">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Transaction ID:</span>
                      <span className="font-bold text-slate-800">{txId || "tx_abn_492019"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Plan:</span>
                      <span className="font-bold text-slate-800">Growth Tier (£499/mo)</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Client Signatory:</span>
                      <span className="font-bold text-slate-800">{clientSignerName}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Settlement Status:</span>
                      <span className="font-bold text-emerald-600">PAID & SETTLED</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-center gap-3 pt-2">
                    <button
                      onClick={onClose}
                      className="px-5 py-2.5 bg-slate-900 hover:bg-black text-white text-xs font-bold rounded-xl shadow-sm transition-all"
                    >
                      Close Meeting Room
                    </button>
                  </div>
                </div>
              ) : (
                <div className="bg-slate-50 rounded-2xl p-5 border border-slate-200 space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                    <div>
                      <h4 className="text-xs font-bold text-slate-900">
                        Secure Stripe & BACS Checkout Terminal
                      </h4>
                      <p className="text-[11px] text-slate-500">
                        Authorized payment collection for {meeting.companyName}
                      </p>
                    </div>

                    <div className="flex items-center gap-1 text-xs text-slate-600">
                      <Lock className="w-3.5 h-3.5 text-emerald-600" />
                      <span>256-bit Encrypted</span>
                    </div>
                  </div>

                  {/* Payment Breakdown Card */}
                  <div className="bg-white rounded-xl p-4 border border-slate-200 space-y-2 text-xs">
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span className="text-slate-600">Abedin Voice AI Practice License (Month 1):</span>
                      <span className="font-bold text-slate-900">£499.00</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span className="text-slate-600">Turnkey Phone Onboarding & Calendar Integration:</span>
                      <span className="font-bold text-emerald-600">FREE (Waived £350 setup)</span>
                    </div>
                    <div className="flex justify-between py-1 pt-2 font-bold text-slate-900 text-sm">
                      <span>Total First Month Charge:</span>
                      <span>£499.00 GBP</span>
                    </div>
                  </div>

                  {/* Process Button */}
                  <div className="flex items-center justify-between pt-3 border-t border-slate-200">
                    <button
                      onClick={() => setActiveStep(2)}
                      className="px-3.5 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800"
                    >
                      Back to Agreement
                    </button>

                    <button
                      onClick={handleProcessPayment}
                      disabled={processingPayment}
                      className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold shadow-sm transition-all flex items-center gap-2 disabled:opacity-50"
                    >
                      <CreditCard className="w-4 h-4" />
                      <span>{processingPayment ? "Processing Settlement..." : "Process First Payment (£499.00 GBP)"}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
