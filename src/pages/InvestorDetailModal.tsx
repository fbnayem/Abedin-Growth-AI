import React, { useState } from "react";
import {
  X,
  Sparkles,
  Mail,
  Calendar,
  Building2,
  DollarSign,
  User,
  CheckCircle2,
  Send,
  Loader2,
  FileText,
  HelpCircle,
  Swords,
  Linkedin,
  Clock,
  Check,
  MessageSquare,
  History,
  TrendingUp,
  ExternalLink,
} from "lucide-react";
import { Investor, Conversation, EmailMessage } from "../types";
import { diagnosticFetch } from "../utils/diagnosticFetch";

interface InvestorDetailModalProps {
  investor: Investor | null;
  conversations?: Conversation[];
  onClose: () => void;
  onOpenScoreWhy?: (investor: Investor) => void;
  onBookMeeting: (investor: Investor) => void;
  onOpenPitchSimulator?: (investor: Investor) => void;
  onOpenBattlecard?: (investor: Investor) => void;
  onSendReply?: (convId: string, subject: string, body: string) => Promise<void>;
}

export const InvestorDetailModal: React.FC<InvestorDetailModalProps> = ({
  investor,
  conversations = [],
  onClose,
  onOpenScoreWhy,
  onBookMeeting,
  onOpenPitchSimulator,
  onOpenBattlecard,
  onSendReply,
}) => {
  if (!investor) return null;

  // Match conversation
  const conversation = conversations.find(
    (c) =>
      (c.contactEmail && c.contactEmail.toLowerCase() === investor.email?.toLowerCase()) ||
      (c.companyName && c.companyName.toLowerCase() === investor.fundName?.toLowerCase())
  );

  const [activeTab, setActiveTab] = useState<"conversation" | "timeline" | "thesis" | "reply">(
    conversation ? "conversation" : "thesis"
  );

  const [replySubject, setReplySubject] = useState(
    conversation?.subject?.startsWith("Re:")
      ? conversation.subject
      : `Re: ${conversation?.subject || `Abedin AI - Voice Receptionist for Dental Clinics (${investor.fundName})`}`
  );
  const [replyBody, setReplyBody] = useState(
    conversation?.proposedAiDraft?.body ||
      `Hi ${investor.name.split(" ")[0]},\n\nThanks for your response! Attached is our 10-slide Seed Pitch Deck and 2-minute live voice latency demo recording.\n\nWould you have 15 minutes Tuesday afternoon for a brief partner intro call?\n\nBest regards,\nNayem Abedin\nFounder & CEO | Abedin Tech`
  );
  const [sendingReply, setSendingReply] = useState(false);
  const [replySuccess, setReplySuccess] = useState(false);

  const handleSendReply = async () => {
    if (!conversation) return;
    setSendingReply(true);
    try {
      if (onSendReply) {
        await onSendReply(conversation.id, replySubject, replyBody);
      } else {
        await diagnosticFetch(`/api/inbox/${conversation.id}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: replySubject, body: replyBody }),
        });
      }
      setReplySuccess(true);
      setTimeout(() => setReplySuccess(false), 3000);
    } catch (e) {
      console.error(e);
    } finally {
      setSendingReply(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-3xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[90vh] my-auto">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center font-black text-base text-white shadow-sm">
              {investor.investorFitScore}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white">{investor.name}</h3>
                <span className="text-xs px-2.5 py-0.5 rounded-full font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  {investor.status}
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
                  Check: {investor.typicalCheck}
                </span>
              </div>
              <div className="text-xs text-slate-300 flex items-center gap-2 mt-0.5">
                <span>{investor.title}</span>
                <span>•</span>
                <span className="font-semibold text-white">{investor.fundName}</span>
                <span>•</span>
                <span className="text-slate-400">{investor.stage} ({investor.geography})</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onOpenBattlecard && (
              <button
                onClick={() => onOpenBattlecard(investor)}
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs transition-colors"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>1-Page Brief</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-1 px-6 bg-slate-100/80 border-b border-slate-200 text-xs shrink-0 py-1.5 overflow-x-auto">
          {conversation && (
            <button
              onClick={() => setActiveTab("conversation")}
              className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
                activeTab === "conversation" ? "bg-white text-indigo-700 shadow-2xs" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              <span>Conversation & Replies</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-black bg-indigo-600 text-white">
                Active
              </span>
            </button>
          )}

          <button
            onClick={() => setActiveTab("timeline")}
            className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              activeTab === "timeline" ? "bg-white text-indigo-700 shadow-2xs" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>Interaction History</span>
          </button>

          <button
            onClick={() => setActiveTab("thesis")}
            className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              activeTab === "thesis" ? "bg-white text-indigo-700 shadow-2xs" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <TrendingUp className="w-3.5 h-3.5" />
            <span>Fund Thesis & Fit</span>
          </button>
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-5">
          {activeTab === "conversation" && conversation && (
            <div className="space-y-4">
              {/* Intent banner */}
              <div className="p-4 rounded-xl bg-indigo-50 border border-indigo-200 space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
                  <span className="font-bold text-indigo-950 flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-indigo-600" />
                    Investor Intent: <strong>{conversation.lastReplyIntent || "PITCH_INTEREST"}</strong>
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-indigo-200 text-indigo-800 text-[11px] font-bold">
                    Confidence: 99%
                  </span>
                </div>
                {conversation.aiSummary && (
                  <p className="text-xs text-indigo-900 leading-relaxed font-medium bg-white/80 p-2.5 rounded-lg border border-indigo-200/50">
                    <strong>AI Extraction: </strong>{conversation.aiSummary}
                  </p>
                )}
              </div>

              {/* Message thread */}
              <div className="space-y-3">
                {conversation.thread?.map((msg: EmailMessage, idx: number) => {
                  const isAgent = msg.sender === "AGENT" || msg.sender === "USER";
                  return (
                    <div
                      key={msg.id || idx}
                      className={`p-4 rounded-xl border text-xs space-y-2 ${
                        isAgent ? "bg-slate-50 border-slate-200 ml-6" : "bg-indigo-50/70 border-indigo-200 mr-6 shadow-xs"
                      }`}
                    >
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-bold text-slate-900">
                          {isAgent ? "Nayem Abedin (Founder & CEO)" : msg.senderName || investor.name}
                        </span>
                        <span className="text-slate-400">
                          {msg.sentAt ? new Date(msg.sentAt).toLocaleString() : "Recent"}
                        </span>
                      </div>
                      <div className="text-slate-800 font-mono text-[11px] whitespace-pre-wrap bg-white/80 p-2.5 rounded border border-slate-200/50">
                        {msg.bodyText}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Quick Reply Form */}
              <div className="p-4 bg-white rounded-xl border border-slate-200 space-y-3">
                <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                  <Send className="w-3.5 h-3.5 text-indigo-600" />
                  <span>Send Follow-Up to {investor.name}</span>
                </div>

                {replySuccess && (
                  <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900 font-bold flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span>Follow-up sent successfully!</span>
                  </div>
                )}

                <textarea
                  rows={4}
                  value={replyBody}
                  onChange={(e) => setReplyBody(e.target.value)}
                  className="w-full p-2.5 text-xs rounded-xl border border-slate-300 focus:ring-2 focus:ring-indigo-500 font-mono"
                />

                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-slate-500">
                    Sending to <strong>{investor.email}</strong>
                  </span>
                  <button
                    onClick={handleSendReply}
                    disabled={sendingReply || !replyBody.trim()}
                    className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-2xs transition-colors disabled:opacity-50"
                  >
                    {sendingReply ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    <span>Send Investor Reply</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === "timeline" && (
            <div className="space-y-4">
              <div className="text-xs font-bold text-slate-900">
                Outreach & Interaction Journey for {investor.fundName}
              </div>
              <div className="relative border-l-2 border-slate-200 ml-4 space-y-5 pl-6 py-2">
                <div className="relative">
                  <div className="absolute -left-[31px] top-0 w-4 h-4 rounded-full bg-indigo-600 border-2 border-white shadow-xs" />
                  <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-1 text-xs">
                    <div className="font-bold text-slate-900">1. Fund Research & Partner Matching</div>
                    <p className="text-slate-600">
                      Matched thesis: {investor.thesisMatch || "Voice AI and vertical healthcare SaaS applications"}.
                    </p>
                  </div>
                </div>

                <div className="relative">
                  <div className="absolute -left-[31px] top-0 w-4 h-4 rounded-full bg-emerald-600 border-2 border-white shadow-xs" />
                  <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-1 text-xs">
                    <div className="font-bold text-slate-900">2. Personalized Cold Inbound Sent</div>
                    <p className="text-slate-600">
                      Dispatched personalized pitch email highlighting unit economics and customer pipeline.
                    </p>
                  </div>
                </div>

                {conversation && (
                  <div className="relative">
                    <div className="absolute -left-[31px] top-0 w-4 h-4 rounded-full bg-purple-600 border-2 border-white shadow-xs" />
                    <div className="p-3.5 bg-purple-50 rounded-xl border border-purple-200 space-y-1 text-xs">
                      <div className="font-bold text-purple-950">3. Partner Reply Received</div>
                      <p className="text-purple-900">
                        {investor.name} requested 10-slide deck and offered 15-min intro slot.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === "thesis" && (
            <div className="space-y-4 text-xs">
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <div className="font-bold text-slate-900">Investment Thesis Alignment</div>
                <p className="text-slate-700 leading-relaxed">
                  {investor.thesisMatch || "Invests in Seed-stage AI infrastructure, vertical voice agents, and high gross-margin B2B SaaS."}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-1">
                  <div className="text-[11px] text-slate-400 font-bold uppercase">Target Stage</div>
                  <div className="font-bold text-slate-900">{investor.stage}</div>
                </div>

                <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-1">
                  <div className="text-[11px] text-slate-400 font-bold uppercase">Check Size</div>
                  <div className="font-bold text-slate-900">{investor.typicalCheck}</div>
                </div>
              </div>

              {investor.portfolioCompanies && investor.portfolioCompanies.length > 0 && (
                <div className="p-4 bg-white rounded-xl border border-slate-200 space-y-2">
                  <div className="font-bold text-slate-900">Notable Portfolio Companies</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {investor.portfolioCompanies.map((c) => (
                      <span key={c} className="px-2 py-1 rounded-md bg-slate-100 font-semibold text-slate-700">
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-bold text-slate-600 hover:text-slate-900 transition-colors"
          >
            Close
          </button>

          <div className="flex items-center gap-2">
            {onOpenPitchSimulator && (
              <button
                onClick={() => onOpenPitchSimulator(investor)}
                className="px-3.5 py-2 rounded-xl text-xs font-bold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 transition-colors flex items-center gap-1.5"
              >
                <Swords className="w-3.5 h-3.5" />
                <span>Pitch War Room</span>
              </button>
            )}
            <button
              onClick={() => onBookMeeting(investor)}
              className="px-4 py-2 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-700 text-white transition-colors flex items-center gap-1.5 shadow-2xs"
            >
              <Calendar className="w-3.5 h-3.5" />
              <span>Schedule Partner Call</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
