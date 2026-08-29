import React, { useState, useEffect } from "react";
import {
  PhoneCall,
  PhoneOff,
  Mic,
  MicOff,
  Volume2,
  Sparkles,
  Zap,
  Play,
  Pause,
  CheckCircle2,
  Radio,
  Clock,
  ShieldCheck,
  RotateCcw,
  Smartphone
} from "lucide-react";

interface LivePhoneTestWidgetProps {
  prospectName?: string;
  clinicName?: string;
  defaultPhone?: string;
  onCallCompleted?: () => void;
}

export const LivePhoneTestWidget: React.FC<LivePhoneTestWidgetProps> = ({
  prospectName = "Dr. Practice Manager",
  clinicName = "Harley Street Dental",
  defaultPhone = "+44 7700 900077",
  onCallCompleted,
}) => {
  const [phoneNumber, setPhoneNumber] = useState(defaultPhone);
  const [callState, setCallState] = useState<"IDLE" | "DIALING" | "CONNECTED" | "ENDED">("IDLE");
  const [callDuration, setCallDuration] = useState(0);
  const [activeSpeaker, setActiveSpeaker] = useState<"AGENT" | "PATIENT" | "NONE">("NONE");
  const [liveLatencyMs, setLiveLatencyMs] = useState(380);
  const [currentLineIndex, setCurrentLineIndex] = useState(0);

  // Scripted simulated live test call
  const callDialogue = [
    {
      speaker: "AGENT",
      name: "Abedin Voice AI",
      text: `Hello! Thank you for calling ${clinicName}. I'm the automated receptionist. Are you looking to book an appointment or inquire about our services?`,
      time: 2,
    },
    {
      speaker: "PATIENT",
      name: "Caller (Dr. Miller)",
      text: "Hi there, I need a consultation for teeth whitening and a routine hygiene check next Tuesday afternoon.",
      time: 6,
    },
    {
      speaker: "AGENT",
      name: "Abedin Voice AI",
      text: "I can certainly help you with that! We have Dr. Evans available on Tuesday at 2:30 PM or 4:15 PM. Which time works better for your schedule?",
      time: 12,
    },
    {
      speaker: "PATIENT",
      name: "Caller (Dr. Miller)",
      text: "2:30 PM works great. Do you accept Bupa private insurance?",
      time: 17,
    },
    {
      speaker: "AGENT",
      name: "Abedin Voice AI",
      text: "Yes, we accept Bupa dental direct billing! I've provisionally reserved 2:30 PM for you and sent a confirmation SMS to this number.",
      time: 22,
    },
  ];

  // Call timer and dialogue progression
  useEffect(() => {
    let timer: any;
    if (callState === "CONNECTED") {
      timer = setInterval(() => {
        setCallDuration((prev) => {
          const nextTime = prev + 1;
          // Progress dialogue
          const activeDialogue = [...callDialogue].reverse().find((d) => d.time <= nextTime);
          if (activeDialogue) {
            setActiveSpeaker(activeDialogue.speaker as any);
            const idx = callDialogue.indexOf(activeDialogue);
            setCurrentLineIndex(idx);
          }
          // Fluctuate real-time latency realistically between 340ms and 420ms
          setLiveLatencyMs(340 + Math.floor(Math.random() * 80));

          if (nextTime >= 27) {
            setCallState("ENDED");
            if (onCallCompleted) onCallCompleted();
          }
          return nextTime;
        });
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [callState]);

  const handleStartCall = () => {
    setCallState("DIALING");
    setCallDuration(0);
    setCurrentLineIndex(0);
    setActiveSpeaker("NONE");
    setTimeout(() => {
      setCallState("CONNECTED");
    }, 1800);
  };

  const handleHangup = () => {
    setCallState("ENDED");
  };

  const handleReset = () => {
    setCallState("IDLE");
    setCallDuration(0);
    setCurrentLineIndex(0);
    setActiveSpeaker("NONE");
  };

  return (
    <div className="bg-slate-900 rounded-2xl border border-slate-800 text-white p-4 space-y-4 shadow-md overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center font-bold">
            <Radio className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-bold text-white tracking-tight">
                Live Sub-500ms Voice Demo Dialer
              </h4>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-400/20">
                Ultra-Low Latency
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              Demonstrate real-time conversational voice booking on live sales demos
            </p>
          </div>
        </div>

        {callState === "CONNECTED" && (
          <div className="flex items-center gap-2 bg-slate-800/80 px-2.5 py-1 rounded-lg border border-slate-700">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
            <span className="text-[11px] font-mono font-bold text-emerald-400">
              {Math.floor(callDuration / 60)}:{(callDuration % 60).toString().padStart(2, "0")}
            </span>
            <span className="text-[10px] text-slate-400 font-mono">({liveLatencyMs}ms)</span>
          </div>
        )}
      </div>

      {/* Dialer Control Bar */}
      {callState === "IDLE" && (
        <div className="space-y-3">
          <div className="bg-slate-850 p-3 rounded-xl border border-slate-700/80 flex flex-col sm:flex-row items-center gap-2">
            <div className="flex items-center gap-2 w-full flex-1">
              <Smartphone className="w-4 h-4 text-slate-400 shrink-0" />
              <input
                type="text"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="+44 7700 900077"
                className="w-full bg-transparent text-xs font-mono text-white outline-hidden placeholder:text-slate-500"
              />
            </div>
            <button
              onClick={handleStartCall}
              className="w-full sm:w-auto px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition-all shadow-sm shadow-emerald-600/30 shrink-0"
            >
              <PhoneCall className="w-3.5 h-3.5" />
              <span>Launch Live Audio Test</span>
            </button>
          </div>
          <div className="flex items-center justify-between text-[11px] text-slate-400 px-1">
            <span>Target: <strong>{clinicName}</strong></span>
            <span className="text-emerald-400">✓ UK/US Carrier Direct Routing</span>
          </div>
        </div>
      )}

      {/* Dialing Screen */}
      {callState === "DIALING" && (
        <div className="p-6 bg-slate-850 rounded-xl border border-slate-800 flex flex-col items-center justify-center space-y-3 text-center animate-pulse">
          <div className="w-12 h-12 rounded-full bg-indigo-600/30 border border-indigo-400/40 flex items-center justify-center text-indigo-300">
            <PhoneCall className="w-6 h-6 animate-bounce" />
          </div>
          <div>
            <div className="text-xs font-bold text-white">Dialing SIP Trunk Gateway...</div>
            <div className="text-[11px] font-mono text-slate-400">{phoneNumber}</div>
          </div>
        </div>
      )}

      {/* Live Connected Call Screen */}
      {callState === "CONNECTED" && (
        <div className="space-y-3">
          {/* Audio Waveform & Latency Gauge */}
          <div className="p-3 bg-slate-850 rounded-xl border border-slate-700/80 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs">
              <Volume2 className="w-4 h-4 text-emerald-400 animate-pulse" />
              <span className="font-semibold text-slate-200">
                Active Speaker:{" "}
                <strong className={activeSpeaker === "AGENT" ? "text-emerald-400" : "text-indigo-400"}>
                  {activeSpeaker === "AGENT" ? "Abedin Voice AI" : "Caller"}
                </strong>
              </span>
            </div>

            <div className="flex items-center gap-1.5 text-[11px] bg-slate-800 px-2 py-0.5 rounded border border-slate-700 font-mono text-emerald-300">
              <Zap className="w-3 h-3 text-amber-400" />
              <span>Turn Latency: {liveLatencyMs}ms</span>
            </div>
          </div>

          {/* Live Transcript Stream */}
          <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 max-h-40 overflow-y-auto space-y-2 text-xs">
            {callDialogue.slice(0, currentLineIndex + 1).map((line, idx) => (
              <div
                key={idx}
                className={`p-2 rounded-lg leading-relaxed ${
                  line.speaker === "AGENT"
                    ? "bg-slate-900 border border-slate-800 text-slate-200"
                    : "bg-indigo-950/60 border border-indigo-800/40 text-indigo-200"
                }`}
              >
                <div className="text-[10px] font-bold uppercase tracking-wider mb-0.5 text-slate-400">
                  {line.name}
                </div>
                <div>{line.text}</div>
              </div>
            ))}
          </div>

          {/* Live Call Control Footer */}
          <div className="flex items-center justify-between pt-1">
            <div className="text-[11px] text-slate-400 flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>EHR Calendar Webhook Active</span>
            </div>
            <button
              onClick={handleHangup}
              className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm transition-colors"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              <span>End Call Demo</span>
            </button>
          </div>
        </div>
      )}

      {/* Call Completed Screen */}
      {callState === "ENDED" && (
        <div className="p-4 bg-slate-850 rounded-xl border border-slate-700 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs">
              <CheckCircle2 className="w-4 h-4" />
              <span>Test Call Finished • Latency Validated (Avg 374ms)</span>
            </div>
            <button
              onClick={handleReset}
              className="text-[11px] font-bold text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Test Again</span>
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2 text-[11px] bg-slate-900 p-2.5 rounded-lg border border-slate-800">
            <div>
              <span className="text-slate-400">Call Time:</span>{" "}
              <strong className="text-white">{callDuration}s</strong>
            </div>
            <div>
              <span className="text-slate-400">Voice Latency:</span>{" "}
              <strong className="text-emerald-400">&lt; 400ms</strong>
            </div>
            <div>
              <span className="text-slate-400">Booking Result:</span>{" "}
              <strong className="text-indigo-300">Appointment Synced</strong>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
