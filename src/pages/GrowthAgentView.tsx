import React, { useState, useRef, useEffect } from "react";
import {
  Sparkles,
  Send,
  Loader2,
  Bot,
  User,
  CheckCircle2,
  Play,
  ArrowRight,
  ShieldCheck,
  Zap,
  HelpCircle,
} from "lucide-react";
import { AICommandResult } from "../../server/agents/growthCommandAgent";

interface ChatMessage {
  id: string;
  sender: "USER" | "AGENT";
  text: string;
  timestamp: string;
  planResult?: AICommandResult;
}

interface GrowthAgentViewProps {
  onExecutePlan: (plan: AICommandResult) => void;
  onNavigateTab: (tab: any) => void;
}

export const GrowthAgentView: React.FC<GrowthAgentViewProps> = ({
  onExecutePlan,
  onNavigateTab,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "msg_init",
      sender: "AGENT",
      text: "Hello Nayem! I am your autonomous AI Growth Officer for Abedin Voice AI. I can discover targeted clinic leads, find seed AI investors, recruit agency partners, or compose replies. What growth milestone shall we conquer today?",
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  const quickPrompts = [
    "Find 50 UK dental clinics and prepare outreach sequence",
    "Find Seed AI venture investors in Singapore with $500k+ check size",
    "Which conversations need my reply today?",
    "Summarize our pipeline performance this week",
  ];

  const handleSend = async (customPrompt?: string) => {
    const text = customPrompt || input;
    if (!text.trim() || loading) return;

    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      sender: "USER",
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/growth-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: text }),
      });

      if (!res.ok) throw new Error("Failed to execute growth command");
      const result: AICommandResult = await res.json();

      const agentMsg: ChatMessage = {
        id: `agent_${Date.now()}`,
        sender: "AGENT",
        text: result.responseSummary,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        planResult: result,
      };

      setMessages((prev) => [...prev, agentMsg]);
    } catch (e: any) {
      console.error(e);
      setMessages((prev) => [
        ...prev,
        {
          id: `agent_err_${Date.now()}`,
          sender: "AGENT",
          text: "I encountered an error processing that growth command. Please check server logs.",
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-[calc(100vh-120px)] flex flex-col space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">AI Growth Agent</h1>
            <p className="text-xs text-slate-500">
              Command-driven growth engine with visible plan confirmation and policy controls.
            </p>
          </div>
        </div>
      </div>

      {/* Main Chat Container */}
      <div className="flex-1 bg-white rounded-2xl border border-slate-200 shadow-2xs flex flex-col overflow-hidden min-h-0">
        {/* Messages Scroll Area */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
          {messages.map((msg) => {
            const isAgent = msg.sender === "AGENT";
            return (
              <div
                key={msg.id}
                className={`flex gap-3 max-w-2xl ${isAgent ? "mr-auto" : "ml-auto flex-row-reverse"}`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold ${
                    isAgent
                      ? "bg-slate-900 text-white shadow-xs"
                      : "bg-blue-600 text-white shadow-xs"
                  }`}
                >
                  {isAgent ? <Bot className="w-4 h-4" /> : "NA"}
                </div>

                <div className="space-y-2">
                  <div
                    className={`p-4 rounded-2xl text-xs leading-relaxed ${
                      isAgent
                        ? "bg-slate-50 text-slate-800 border border-slate-200/80 rounded-tl-xs"
                        : "bg-blue-600 text-white rounded-tr-xs"
                    }`}
                  >
                    <div className="whitespace-pre-wrap font-sans">{msg.text}</div>
                  </div>

                  {/* If the message returned an AI Plan */}
                  {msg.planResult?.requiresPlanApproval && msg.planResult.planSteps && (
                    <div className="p-4 bg-blue-50/80 rounded-xl border border-blue-200/80 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                          Generated Workflow Plan ({msg.planResult.planSteps.length} Steps)
                        </span>
                      </div>

                      <div className="space-y-1.5">
                        {msg.planResult.planSteps.map((step) => (
                          <div
                            key={step.stepNumber}
                            className="p-2 rounded bg-white border border-blue-100 flex items-start gap-2 text-xs"
                          >
                            <span className="w-4 h-4 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                              {step.stepNumber}
                            </span>
                            <div className="min-w-0">
                              <span className="font-bold text-slate-900">{step.title}: </span>
                              <span className="text-slate-600">{step.description}</span>
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="pt-1 flex items-center gap-2">
                        <button
                          onClick={() => onExecutePlan(msg.planResult!)}
                          className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>Review & Execute Plan</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Recommendation action link */}
                  {msg.planResult?.actionRecommendation?.targetTab && (
                    <button
                      onClick={() => onNavigateTab(msg.planResult!.actionRecommendation!.targetTab)}
                      className="inline-flex items-center gap-1 text-xs font-bold text-blue-600 hover:text-blue-700 bg-blue-50 px-2.5 py-1 rounded-lg border border-blue-200 transition-colors"
                    >
                      <span>{msg.planResult.actionRecommendation.label}</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <div
                    className={`text-[10px] text-slate-400 px-1 ${
                      isAgent ? "text-left" : "text-right"
                    }`}
                  >
                    {msg.timestamp}
                  </div>
                </div>
              </div>
            );
          })}

          {loading && (
            <div className="flex gap-3 mr-auto max-w-md">
              <div className="w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs">
                <Bot className="w-4 h-4" />
              </div>
              <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200 text-xs text-slate-600 flex items-center gap-2">
                <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
                <span>Gemini is formulating strategy & evaluating safety policies...</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Quick Prompts Bar */}
        <div className="px-4 py-2 border-t border-slate-100 bg-slate-50/70 overflow-x-auto flex gap-1.5">
          {quickPrompts.map((qp, idx) => (
            <button
              key={idx}
              onClick={() => handleSend(qp)}
              className="px-2.5 py-1 rounded-full bg-white hover:bg-blue-50 text-slate-700 hover:text-blue-700 text-[11px] font-medium border border-slate-200 whitespace-nowrap transition-colors shadow-2xs"
            >
              {qp}
            </button>
          ))}
        </div>

        {/* Input Bar */}
        <div className="p-3 border-t border-slate-200 bg-white flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSend();
            }}
            placeholder="Command your AI Growth Team (e.g. 'Find 20 clinic directors in London')..."
            className="flex-1 px-3.5 py-2 rounded-xl border border-slate-300 text-xs font-medium focus:ring-2 focus:ring-blue-500 outline-hidden bg-slate-50 focus:bg-white"
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || loading}
            className="p-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 transition-colors shadow-sm"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
