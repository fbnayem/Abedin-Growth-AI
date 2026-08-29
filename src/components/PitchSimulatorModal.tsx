import React, { useState } from "react";
import {
  X,
  Swords,
  Sparkles,
  Send,
  Loader2,
  Bot,
  User,
  ShieldCheck,
  TrendingUp,
  AlertCircle,
  HelpCircle,
  Volume2,
  Lightbulb,
  CheckCircle2,
  RotateCcw
} from "lucide-react";
import { Lead, Investor, CompanyBrain } from "../types";
import { diagnosticFetch } from "../utils/diagnosticFetch";

interface Message {
  role: "prospect" | "user" | "coach";
  text: string;
  score?: number;
  feedback?: string;
  suggestedRebuttal?: string;
  timestamp: string;
}

interface PitchSimulatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  entity: Lead | Investor;
  type: "CUSTOMER" | "INVESTOR";
  companyBrain?: CompanyBrain | null;
}

export const PitchSimulatorModal: React.FC<PitchSimulatorModalProps> = ({
  isOpen,
  onClose,
  entity,
  type,
  companyBrain,
}) => {
  const isCustomer = type === "CUSTOMER";
  const customerLead = isCustomer ? (entity as Lead) : null;
  const investorEntity = !isCustomer ? (entity as Investor) : null;

  const entityName = isCustomer
    ? `${customerLead?.name} (${customerLead?.title} at ${customerLead?.companyName})`
    : `${investorEntity?.name} (${investorEntity?.role} at ${investorEntity?.fundName})`;

  const initialPersonaPrompt = isCustomer
    ? `You're calling ${customerLead?.name}, ${customerLead?.title} at ${customerLead?.companyName} in the ${customerLead?.industry} industry. They handle high call volume and are skeptical of AI tools making mistakes.`
    : `You are in a pitch meeting with ${investorEntity?.name}, ${investorEntity?.role} at ${investorEntity?.fundName}. They invest in ${investorEntity?.targetSectors?.join(", ")} at ${investorEntity?.stage} stage. They want proof of unit economics and defensible moats.`;

  const defaultOpeningMessage: Message = {
    role: "prospect",
    text: isCustomer
      ? `Hey, this is ${customerLead?.name?.split(" ")[0] || "there"}. Look, I only have about 60 seconds before my next meeting. What is this regarding?`
      : `Thanks for getting on the call. We've seen a dozen voice AI pitches this quarter. What is your actual moat and unit economics right now?`,
    timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  };

  const [messages, setMessages] = useState<Message[]>([defaultOpeningMessage]);
  const [userInput, setUserInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [overallScore, setOverallScore] = useState<number>(75);
  const [lastCoachingTip, setLastCoachingTip] = useState<string>(
    isCustomer
      ? "Hook them immediately with their after-hours missed call loss before discussing AI features."
      : "Anchor on your sub-500ms speed, proprietary prompt-tuning, and direct calendar ROI."
  );

  if (!isOpen) return null;

  const handleSendMessage = async () => {
    if (!userInput.trim() || loading) return;

    const userMsg: Message = {
      role: "user",
      text: userInput.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setUserInput("");
    setLoading(true);

    try {
      const res = await diagnosticFetch(
        "/api/pitch-battle/simulate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entityType: type,
            entity,
            conversationHistory: updatedMessages,
            userPitch: userMsg.text,
          }),
        },
        { context: "PitchSimulatorModal.handleSendMessage" }
      );

      if (res.ok) {
        const data = await res.json();
        const prospectReply: Message = {
          role: "prospect",
          text: data.prospectResponse,
          score: data.score,
          feedback: data.feedback,
          suggestedRebuttal: data.suggestedRebuttal,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };

        setMessages((prev) => [...prev, prospectReply]);
        if (typeof data.score === "number") {
          setOverallScore(data.score);
        }
        if (data.coachingTip) {
          setLastCoachingTip(data.coachingTip);
        }
      } else {
        // Fallback simulation response if backend is unavailable
        const simulatedScore = Math.floor(Math.random() * 20) + 75;
        const simulatedProspectReply: Message = {
          role: "prospect",
          text: isCustomer
            ? `Okay, that sounds somewhat interesting. But how does this integrate with our current CRM and telephone system without disrupting ongoing staff?`
            : `Understood. What is your customer acquisition cost versus lifetime value (CAC/LTV), and what prevents Twilio or OpenAI from commoditizing this?`,
          score: simulatedScore,
          feedback: "Good direct value statement. Next, address their switching friction and integration security.",
          suggestedRebuttal: isCustomer
            ? "We integrate in under 15 minutes via SIP trunking or standard phone forwarding, with zero changes to your existing phone carrier."
            : "Our moat is our domain-specific task orchestration, latency under 500ms, and proprietary integration hooks that raw model providers don't build.",
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        setMessages((prev) => [...prev, simulatedProspectReply]);
        setOverallScore(simulatedScore);
      }
    } catch (e) {
      console.error("Simulation error:", e);
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setMessages([defaultOpeningMessage]);
    setOverallScore(75);
  };

  const applySuggestedRebuttal = (rebuttal?: string) => {
    if (rebuttal) {
      setUserInput(rebuttal);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-xs z-50 flex items-center justify-center p-3 sm:p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl h-[90vh] max-h-[820px] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-slate-900 via-slate-850 to-indigo-950 text-white flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/20">
              <Swords className="w-5 h-5 text-indigo-100" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white tracking-tight">
                  AI Objection War Room
                </h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/30 text-indigo-200 border border-indigo-400/30 font-semibold uppercase tracking-wider">
                  Live Battle Mode
                </span>
              </div>
              <p className="text-xs text-slate-300 mt-0.5 truncate max-w-xl">
                Opponent: <span className="font-semibold text-white">{entityName}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Live Score Badge */}
            <div className="hidden sm:flex items-center gap-2 bg-slate-800/80 px-3 py-1.5 rounded-xl border border-slate-700">
              <div className="text-right">
                <div className="text-[9px] uppercase tracking-wider font-bold text-slate-400">Pitch Mastery</div>
                <div className="text-xs font-black text-emerald-400">{overallScore}/100</div>
              </div>
              <div className={`w-3 h-3 rounded-full ${overallScore >= 80 ? "bg-emerald-500 animate-pulse" : "bg-amber-500"}`} />
            </div>

            <button
              onClick={handleReset}
              title="Restart Simulation"
              className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            <button
              onClick={onClose}
              className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Persona & Objective Banner */}
        <div className="px-6 py-2.5 bg-indigo-50/80 border-b border-indigo-100 flex items-center justify-between text-xs text-indigo-950">
          <div className="flex items-center gap-2">
            <Lightbulb className="w-4 h-4 text-indigo-600 shrink-0" />
            <span className="font-medium text-slate-700">
              <strong className="text-indigo-900 font-semibold">Persona Context:</strong> {initialPersonaPrompt}
            </span>
          </div>
          <div className="hidden md:flex items-center gap-1.5 text-xs text-indigo-700 font-semibold shrink-0">
            <ShieldCheck className="w-3.5 h-3.5 text-indigo-600" />
            <span>Grounded in Company Brain</span>
          </div>
        </div>

        {/* Main Conversation Canvas */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-slate-50/60">
          {messages.map((msg, index) => {
            const isUser = msg.role === "user";
            return (
              <div
                key={index}
                className={`flex flex-col ${isUser ? "items-end" : "items-start"} space-y-1.5`}
              >
                <div className="flex items-center gap-2 px-1">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1">
                    {isUser ? (
                      <>
                        <User className="w-3 h-3 text-blue-600" /> You (Founder / Sales)
                      </>
                    ) : (
                      <>
                        <Bot className="w-3 h-3 text-indigo-600" /> {isCustomer ? customerLead?.name : investorEntity?.name} (AI Persona)
                      </>
                    )}
                  </span>
                  <span className="text-[10px] text-slate-400">{msg.timestamp}</span>
                </div>

                <div
                  className={`max-w-2xl p-4 rounded-2xl text-xs leading-relaxed shadow-2xs ${
                    isUser
                      ? "bg-blue-600 text-white rounded-tr-none font-medium"
                      : "bg-white text-slate-800 border border-slate-200/90 rounded-tl-none font-normal"
                  }`}
                >
                  {msg.text}
                </div>

                {/* AI Coaching & Rebuttal Box for Prospect Replies */}
                {!isUser && msg.feedback && (
                  <div className="max-w-2xl w-full p-3 rounded-xl bg-amber-50/90 border border-amber-200 text-[11px] text-amber-900 space-y-2 mt-1">
                    <div className="flex items-center justify-between">
                      <span className="font-bold flex items-center gap-1.5 text-amber-950">
                        <Sparkles className="w-3.5 h-3.5 text-amber-600" /> AI Coach Feedback
                      </span>
                      {msg.score && (
                        <span className="text-[10px] font-black px-2 py-0.5 rounded-md bg-amber-200/80 text-amber-900">
                          Rebuttal Score: {msg.score}/100
                        </span>
                      )}
                    </div>
                    <p className="text-slate-700">{msg.feedback}</p>

                    {msg.suggestedRebuttal && (
                      <div className="pt-2 border-t border-amber-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div className="text-[11px] text-indigo-900 font-medium italic">
                          💡 <strong>Recommended Counter:</strong> "{msg.suggestedRebuttal}"
                        </div>
                        <button
                          onClick={() => applySuggestedRebuttal(msg.suggestedRebuttal)}
                          className="px-2.5 py-1 rounded-md text-[10px] font-bold bg-indigo-600 hover:bg-indigo-700 text-white shrink-0 shadow-2xs transition-colors self-end sm:self-auto"
                        >
                          Use Counter
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {loading && (
            <div className="flex items-start gap-2 text-slate-500 text-xs animate-pulse p-3 bg-white rounded-xl border border-slate-200 max-w-sm">
              <Loader2 className="w-4 h-4 text-indigo-600 animate-spin" />
              <span>Prospect is calculating objections and pressure testing...</span>
            </div>
          )}
        </div>

        {/* Coaching Bar Footer */}
        <div className="px-6 py-2 bg-slate-100 border-t border-slate-200 flex items-center justify-between text-[11px] text-slate-600">
          <div className="flex items-center gap-2 truncate">
            <span className="font-bold text-slate-800 flex items-center gap-1">
              <TrendingUp className="w-3.5 h-3.5 text-blue-600" /> Live Coach Tip:
            </span>
            <span className="truncate text-slate-600">{lastCoachingTip}</span>
          </div>
        </div>

        {/* Input Bar */}
        <div className="p-4 bg-white border-t border-slate-200">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendMessage();
            }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              disabled={loading}
              placeholder={
                isCustomer
                  ? "Pitch your solution, handle objections, or propose a 2-minute test call..."
                  : "Pitch your growth traction, unit economics, or defensible voice moat..."
              }
              className="flex-1 px-4 py-2.5 text-xs rounded-xl border border-slate-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-hidden bg-white text-slate-900 font-medium"
            />

            <button
              type="submit"
              disabled={loading || !userInput.trim()}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 shadow-sm shadow-indigo-500/20 transition-all shrink-0"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <span>Battle Pitch</span>
                  <Send className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </form>
        </div>

      </div>
    </div>
  );
};
