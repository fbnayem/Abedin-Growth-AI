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
  Handshake,
  Linkedin,
  Clock,
  Check,
  MessageSquare,
  History,
  TrendingUp,
} from "lucide-react";
import { Partner, Conversation, EmailMessage } from "../types";
import { diagnosticFetch } from "../utils/diagnosticFetch";

interface PartnerDetailModalProps {
  partner: Partner | null;
  conversations?: Conversation[];
  onClose: () => void;
  onOpenScoreWhy?: (partner: Partner) => void;
  onBookMeeting: (partner: Partner) => void;
  onSendReply?: (convId: string, subject: string, body: string) => Promise<void>;
}

export const PartnerDetailModal: React.FC<PartnerDetailModalProps> = ({
  partner,
  conversations = [],
  onClose,
  onOpenScoreWhy,
  onBookMeeting,
  onSendReply,
}) => {
  if (!partner) return null;

  // Match conversation
  const conversation = conversations.find(
    (c) =>
      (c.contactEmail && c.contactEmail.toLowerCase() === partner.email?.toLowerCase()) ||
      (c.companyName && c.companyName.toLowerCase() === partner.name?.toLowerCase()) ||
      (c.companyName && c.companyName.toLowerCase() === partner.companyName?.toLowerCase())
  );

  const [activeTab, setActiveTab] = useState<"conversation" | "timeline" | "model">(
    conversation ? "conversation" : "model"
  );

  const [replyBody, setReplyBody] = useState(
    conversation?.proposedAiDraft?.body ||
      `Hi ${partner.contactName?.split(" ")[0] || "there"},\n\nThanks for your interest in our Partner Revenue Share program. We offer 30% recurring margin for each clinic onboarded with Abedin Voice AI.\n\nCould we set up a 15-minute walkthrough to show you how our agency dashboard and white-label tools work?\n\nBest regards,\nNayem Abedin\nFounder & CEO | Abedin Tech`
  );
  const [sendingReply, setSendingReply] = useState(false);
  const [replySuccess, setReplySuccess] = useState(false);

  const handleSendReply = async () => {
    if (!conversation) return;
    setSendingReply(true);
    try {
      if (onSendReply) {
        await onSendReply(conversation.id, `Re: ${conversation.subject}`, replyBody);
      } else {
        await diagnosticFetch(`/api/inbox/${conversation.id}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: `Re: ${conversation.subject}`, body: replyBody }),
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
            <div className="w-10 h-10 rounded-xl bg-emerald-600 flex items-center justify-center font-black text-base text-white shadow-sm">
              {partner.partnerFitScore}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white">{partner.name}</h3>
                <span className="text-xs px-2.5 py-0.5 rounded-full font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  {partner.status}
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
                  {partner.revenueShareModel}
                </span>
              </div>
              <div className="text-xs text-slate-300 flex items-center gap-2 mt-0.5">
                <span>{partner.contactName} ({partner.title})</span>
                <span>•</span>
                <span className="text-slate-400">{partner.partnerType}</span>
                <span>•</span>
                <span className="text-slate-400">{partner.location}</span>
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-1 px-6 bg-slate-100/80 border-b border-slate-200 text-xs shrink-0 py-1.5 overflow-x-auto">
          {conversation && (
            <button
              onClick={() => setActiveTab("conversation")}
              className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
                activeTab === "conversation" ? "bg-white text-emerald-700 shadow-2xs" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              <span>Conversation & Thread</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-black bg-emerald-600 text-white">
                Active
              </span>
            </button>
          )}

          <button
            onClick={() => setActiveTab("timeline")}
            className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              activeTab === "timeline" ? "bg-white text-emerald-700 shadow-2xs" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>Interaction History</span>
          </button>

          <button
            onClick={() => setActiveTab("model")}
            className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              activeTab === "model" ? "bg-white text-emerald-700 shadow-2xs" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Handshake className="w-3.5 h-3.5" />
            <span>Partnership Model</span>
          </button>
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-5">
          {activeTab === "conversation" && conversation && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-emerald-950 flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-emerald-600" />
                    Partner Interest Intent: <strong>{conversation.lastReplyIntent || "PARTNERSHIP_INQUIRY"}</strong>
                  </span>
                </div>
                {conversation.aiSummary && (
                  <p className="text-xs text-emerald-900 leading-relaxed font-medium bg-white/80 p-2.5 rounded-lg border border-emerald-200/50">
                    <strong>AI Extraction: </strong>{conversation.aiSummary}
                  </p>
                )}
              </div>

              <div className="space-y-3">
                {conversation.thread?.map((msg: EmailMessage, idx: number) => {
                  const isAgent = msg.sender === "AGENT" || msg.sender === "USER";
                  return (
                    <div
                      key={msg.id || idx}
                      className={`p-4 rounded-xl border text-xs space-y-2 ${
                        isAgent ? "bg-slate-50 border-slate-200 ml-6" : "bg-emerald-50/70 border-emerald-200 mr-6 shadow-xs"
                      }`}
                    >
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-bold text-slate-900">
                          {isAgent ? "Nayem Abedin (Founder & CEO)" : msg.senderName || partner.contactName}
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

              {/* Quick reply */}
              <div className="p-4 bg-white rounded-xl border border-slate-200 space-y-3">
                <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                  <Send className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Send Follow-Up to {partner.contactName}</span>
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
                  className="w-full p-2.5 text-xs rounded-xl border border-slate-300 focus:ring-2 focus:ring-emerald-500 font-mono"
                />

                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-slate-500">
                    Sending to <strong>{partner.email}</strong>
                  </span>
                  <button
                    onClick={handleSendReply}
                    disabled={sendingReply || !replyBody.trim()}
                    className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-2xs transition-colors disabled:opacity-50"
                  >
                    {sendingReply ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    <span>Send Partner Reply</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === "timeline" && (
            <div className="space-y-4">
              <div className="text-xs font-bold text-slate-900">
                Outreach History for {partner.name}
              </div>
              <div className="relative border-l-2 border-slate-200 ml-4 space-y-5 pl-6 py-2">
                <div className="relative">
                  <div className="absolute -left-[31px] top-0 w-4 h-4 rounded-full bg-emerald-600 border-2 border-white shadow-xs" />
                  <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-1 text-xs">
                    <div className="font-bold text-slate-900">1. Partner Identification</div>
                    <p className="text-slate-600">
                      Identified {partner.name} as a high-synergy {partner.partnerType} partner.
                    </p>
                  </div>
                </div>

                <div className="relative">
                  <div className="absolute -left-[31px] top-0 w-4 h-4 rounded-full bg-blue-600 border-2 border-white shadow-xs" />
                  <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-1 text-xs">
                    <div className="font-bold text-slate-900">2. Revenue Share Proposal Dispatched</div>
                    <p className="text-slate-600">
                      Sent partnership proposal detailing 30% recurring margin and white-label capabilities.
                    </p>
                  </div>
                </div>

                {conversation && (
                  <div className="relative">
                    <div className="absolute -left-[31px] top-0 w-4 h-4 rounded-full bg-purple-600 border-2 border-white shadow-xs" />
                    <div className="p-3.5 bg-purple-50 rounded-xl border border-purple-200 space-y-1 text-xs">
                      <div className="font-bold text-purple-950">3. Partner Reply Received</div>
                      <p className="text-purple-900">
                        {partner.contactName} replied to schedule a partner agreement review.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === "model" && (
            <div className="space-y-4 text-xs">
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <div className="font-bold text-slate-900">Commercial Alignment & Model</div>
                <p className="text-slate-700 leading-relaxed">
                  {partner.notes || "High-volume dental agency managing marketing and booking for 20+ private dental practices."}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-1">
                  <div className="text-[11px] text-slate-400 font-bold uppercase">Partner Type</div>
                  <div className="font-bold text-slate-900">{partner.partnerType}</div>
                </div>

                <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-1">
                  <div className="text-[11px] text-slate-400 font-bold uppercase">Rev Share Model</div>
                  <div className="font-bold text-slate-900">{partner.revenueShareModel}</div>
                </div>
              </div>
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

          <button
            onClick={() => onBookMeeting(partner)}
            className="px-4 py-2 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors flex items-center gap-1.5 shadow-2xs"
          >
            <Calendar className="w-3.5 h-3.5" />
            <span>Schedule Partner Call</span>
          </button>
        </div>
      </div>
    </div>
  );
};
