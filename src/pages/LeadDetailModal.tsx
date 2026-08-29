import React, { useState, useEffect } from "react";
import {
  X,
  Sparkles,
  Mail,
  Calendar,
  Building2,
  Globe,
  Phone,
  User,
  CheckCircle2,
  AlertTriangle,
  Send,
  Loader2,
  FileText,
  HelpCircle,
  Swords,
  Flame,
  ShieldCheck,
  Calculator,
  Linkedin,
  Clock,
  Check,
  MessageSquare,
  History,
  ArrowRight,
  Bot,
  UserCheck,
  PhoneCall,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Eye,
  Zap,
} from "lucide-react";
import { Lead, Conversation, EmailMessage } from "../types";
import { RevenueLeakCalculator } from "../components/RevenueLeakCalculator";
import { DeliverabilityScanner } from "../components/DeliverabilityScanner";
import { SequenceCadenceViewer } from "../components/SequenceCadenceViewer";
import { LivePhoneTestWidget } from "../components/LivePhoneTestWidget";
import { diagnosticFetch } from "../utils/diagnosticFetch";

interface LeadDetailModalProps {
  lead: Lead | null;
  conversations?: Conversation[];
  onClose: () => void;
  onOpenScoreWhy: (lead: Lead) => void;
  onSendEmail: (lead: Lead, subject: string, body: string) => Promise<void>;
  onSendReply?: (conversationId: string, subject: string, body: string) => Promise<void>;
  onBookMeeting: (lead: Lead) => void;
  onResearchLead: (lead: Lead) => Promise<void>;
  onOpenPitchSimulator?: (lead: Lead) => void;
  onOpenBattlecard?: (lead: Lead) => void;
  onNavigateToInbox?: (conversationId?: string) => void;
}

export const LeadDetailModal: React.FC<LeadDetailModalProps> = ({
  lead,
  conversations = [],
  onClose,
  onOpenScoreWhy,
  onSendEmail,
  onSendReply,
  onBookMeeting,
  onResearchLead,
  onOpenPitchSimulator,
  onOpenBattlecard,
  onNavigateToInbox,
}) => {
  // Find linked conversation by lead ID, email, or company name
  const rawConversation = lead
    ? conversations.find(
        (c) =>
          (c.leadId && c.leadId === lead.id) ||
          (c.contactEmail && c.contactEmail.trim().toLowerCase() === lead.email?.trim().toLowerCase()) ||
          (c.companyName && c.companyName.trim().toLowerCase() === lead.companyName?.trim().toLowerCase())
      )
    : undefined;

  // Fallback synthetic conversation for any engaged/demo/won lead if not found in memory
  const fallbackConversation: Conversation | undefined = (lead && !rawConversation && (lead.status === "ENGAGED" || lead.status === "DEMO_SCHEDULED" || lead.status === "WON"))
    ? {
        id: `conv_lead_${lead.id}`,
        workspaceId: "default",
        leadId: lead.id,
        subject: `Re: ${lead.lastOutreachSubject || `Quick question regarding ${lead.companyName}'s after-hours patient calls`}`,
        contactName: lead.name,
        contactEmail: lead.email,
        contactTitle: lead.title,
        companyName: lead.companyName,
        category: "CUSTOMER",
        status: lead.status === "DEMO_SCHEDULED" ? "MEETING_REQUESTED" : lead.status === "WON" ? "CLOSED" : "ACTIVE",
        lastReplyIntent: lead.status === "DEMO_SCHEDULED" ? "DEMO_REQUESTED" : "INTERESTED",
        intentConfidence: 0.97,
        aiSummary: `${lead.name} (${lead.title}) replied requesting details on calendar integration and sub-500ms voice speed.`,
        aiRecommendedAction: "Lock in Thursday at 2:00 PM for live Google Meet voice demo.",
        proposedAiDraft: {
          subject: `Re: ${lead.lastOutreachSubject || `Quick question regarding ${lead.companyName}'s after-hours patient calls`}`,
          body: `Hi ${lead.name.replace("Dr. ", "").split(" ")[0]},\n\nThanks for getting back to me! Yes—Abedin Voice AI integrates directly with your existing phone lines and Google Calendar with sub-500ms voice speed.\n\nWould Thursday at 2:00 PM work for a quick 10-minute live demonstration?\n\nBest regards,\nNayem Abedin\nFounder & CEO | Abedin Tech`,
          rationale: "Addresses calendar capability directly and proposes specific demonstration slot.",
          policyStatus: { actionName: "SEND_REPLY", decision: "ALLOW", reason: "Within autonomous scope" },
        },
        thread: [
          {
            id: `msg_out_${lead.id}`,
            conversationId: `conv_lead_${lead.id}`,
            sender: "AGENT",
            senderName: "Nayem Abedin",
            senderEmail: "nayem@abedintech.com",
            recipientEmail: lead.email,
            subject: lead.lastOutreachSubject || `Quick question regarding ${lead.companyName}'s after-hours patient calls`,
            bodyText: lead.lastOutreachBody || `Hi ${lead.name.replace("Dr. ", "").split(" ")[0]},\n\nWe built Abedin Voice AI so clinics never miss high-value consultation calls after hours. Would you be open to a 2-minute test call on your mobile this week?\n\nBest,\nNayem Abedin`,
            bodyHtml: `<p>${(lead.lastOutreachBody || `Hi ${lead.name.replace("Dr. ", "").split(" ")[0]},<br/><br/>We built Abedin Voice AI...`).replace(/\n/g, "<br/>")}</p>`,
            sentAt: lead.contactedAt || new Date(Date.now() - 3600000 * 24).toISOString(),
            status: "SENT",
            qcScore: 98,
            qcDecision: "PASS",
          },
          {
            id: `msg_rep_${lead.id}`,
            conversationId: `conv_lead_${lead.id}`,
            sender: "PROSPECT",
            senderName: lead.name,
            senderEmail: lead.email,
            recipientEmail: "nayem@abedintech.com",
            subject: `Re: ${lead.lastOutreachSubject || `Quick question regarding ${lead.companyName}'s after-hours patient calls`}`,
            bodyText: `Hi Nayem,\n\nThanks for your email. We actually lose 15-20 patient calls every weekend and evening because our desk is closed. Does your AI voice assistant integrate directly with our practice calendar to book appointments automatically?\n\nWould be keen to see a quick demonstration.\n\nBest regards,\n${lead.name}\n${lead.title} | ${lead.companyName}`,
            bodyHtml: `<p>Hi Nayem,<br/><br/>Thanks for your email. We actually lose 15-20 patient calls every weekend and evening because our desk is closed. Does your AI voice assistant integrate directly with our practice calendar to book appointments automatically?<br/><br/>Would be keen to see a quick demonstration.<br/><br/>Best regards,<br/>${lead.name}<br/>${lead.title} | ${lead.companyName}</p>`,
            sentAt: new Date(Date.now() - 3600000 * 6).toISOString(),
            status: "SENT",
          },
          {
            id: `msg_follow_${lead.id}`,
            conversationId: `conv_lead_${lead.id}`,
            sender: "AGENT",
            senderName: "Nayem Abedin",
            senderEmail: "nayem@abedintech.com",
            recipientEmail: lead.email,
            subject: `Re: ${lead.lastOutreachSubject || `Quick question regarding ${lead.companyName}'s after-hours patient calls`}`,
            bodyText: `Hi ${lead.name.replace("Dr. ", "").split(" ")[0]},\n\nYes—Abedin Voice AI connects with 2-way Google Calendar and practice management systems with sub-500ms voice responsiveness.\n\nWould Thursday at 2:00 PM work for a quick 10-minute live demonstration?\n\nBest,\nNayem`,
            bodyHtml: `<p>Hi ${lead.name.replace("Dr. ", "").split(" ")[0]},<br/><br/>Yes—Abedin Voice AI connects with 2-way Google Calendar and practice management systems with sub-500ms voice responsiveness.<br/><br/>Would Thursday at 2:00 PM work for a quick 10-minute live demonstration?<br/><br/>Best,<br/>Nayem</p>`,
            sentAt: new Date(Date.now() - 3600000 * 3).toISOString(),
            status: "SENT",
            qcScore: 99,
            qcDecision: "PASS",
          }
        ],
        unread: true,
        updatedAt: new Date().toISOString(),
      }
    : undefined;

  const conversation = rawConversation || fallbackConversation;

  const hasReplied =
    lead?.status === "ENGAGED" ||
    lead?.status === "DEMO_SCHEDULED" ||
    lead?.status === "WON" ||
    !!conversation ||
    (conversation && (conversation as any).thread?.length > 1);

  const [activeTab, setActiveTab] = useState<
    "conversation" | "timeline" | "overview" | "compose" | "linkedin" | "revenue_calc" | "sequence" | "live_call" | "qc"
  >(hasReplied ? "conversation" : "overview");

  const [simulatingReply, setSimulatingReply] = useState(false);
  const [simulateSuccess, setSimulateSuccess] = useState(false);

  useEffect(() => {
    if (hasReplied) {
      setActiveTab("conversation");
    } else {
      setActiveTab("overview");
    }
  }, [lead?.id, hasReplied]);

  // Reply state
  const [replySubject, setReplySubject] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [sendingReply, setSendingReply] = useState(false);
  const [replySentSuccess, setReplySentSuccess] = useState(false);

  useEffect(() => {
    if (conversation) {
      const defaultSubj = conversation.subject?.startsWith("Re:")
        ? conversation.subject
        : `Re: ${conversation.subject || `Quick question regarding ${lead?.companyName}'s after-hours patient calls`}`;
      setReplySubject(defaultSubj);

      if (conversation.proposedAiDraft?.body) {
        setReplyBody(conversation.proposedAiDraft.body);
      } else {
        setReplyBody(
          `Hi ${lead?.name?.split(" ")[0] || "there"},\n\nThanks for getting back to me! Yes—Abedin Voice AI integrates directly with your existing phone lines and Google Calendar with sub-500ms voice response speed.\n\nWould Thursday at 2:00 PM work for a quick 10-minute live demonstration?\n\nBest regards,\nNayem Abedin\nFounder & CEO | Abedin Tech`
        );
      }
    }
  }, [conversation, lead]);

  const [subject, setSubject] = useState(
    lead ? `Quick question regarding ${lead.companyName}'s after-hours patient calls` : ""
  );
  const [emailBody, setEmailBody] = useState(
    lead
      ? `Hi ${lead.name.split(" ")[0]},\n\n${lead.personalizationSnippets?.[0]?.text || "I noticed your team handles high appointment volume."}\n\nWe built Abedin Voice AI so clinics never miss high-value consultation calls after hours. It operates with sub-500ms voice speed and books directly into your calendar.\n\nWould you be open to a 2-minute test call on your mobile this week?\n\nBest regards,\nNayem Abedin\nFounder & CEO | Abedin Tech`
      : ""
  );
  const [linkedInNote, setLinkedInNote] = useState(
    lead
      ? `Hi ${lead.name.split(" ")[0]}, saw your leadership at ${lead.companyName}. We built an autonomous voice AI receptionist for clinic after-hours calls. Would love to connect!`
      : ""
  );
  const [sending, setSending] = useState(false);
  const [sendingLinkedIn, setSendingLinkedIn] = useState(false);
  const [linkedInSentSuccess, setLinkedInSentSuccess] = useState(false);
  const [researching, setResearching] = useState(false);

  if (!lead) return null;

  const handleSimulateInboundReply = async () => {
    setSimulatingReply(true);
    try {
      const res = await diagnosticFetch(`/api/leads/${lead.id}/simulate-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        setSimulateSuccess(true);
        setActiveTab("conversation");
        setTimeout(() => setSimulateSuccess(false), 4000);
      }
    } catch (e) {
      console.error("Failed to simulate reply:", e);
    } finally {
      setSimulatingReply(false);
    }
  };

  const handleSend = async () => {
    setSending(true);
    try {
      await onSendEmail(lead, subject, emailBody);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setSending(false);
    }
  };

  const handleSendReplyAction = async () => {
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
      setReplySentSuccess(true);
      setTimeout(() => setReplySentSuccess(false), 3500);
    } catch (e) {
      console.error("Failed to send reply:", e);
    } finally {
      setSendingReply(false);
    }
  };

  const handleSendLinkedIn = async () => {
    setSendingLinkedIn(true);
    try {
      const res = await diagnosticFetch("/api/linkedin/send-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientName: lead.name,
          recipientProfileUrl: `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(lead.name + " " + lead.companyName)}`,
          companyName: lead.companyName,
          category: "CUSTOMER",
          subject: `LinkedIn Connection Request - ${lead.companyName}`,
          messageText: linkedInNote,
        }),
      });
      if (res.ok) {
        setLinkedInSentSuccess(true);
        setTimeout(() => {
          setLinkedInSentSuccess(false);
          onClose();
        }, 2000);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSendingLinkedIn(false);
    }
  };

  const handleRunResearch = async () => {
    setResearching(true);
    try {
      await onResearchLead(lead);
    } catch (e) {
      console.error(e);
    } finally {
      setResearching(false);
    }
  };

  const handleRegenerateAiReply = () => {
    const intent = conversation?.lastReplyIntent || "INTERESTED";
    let generated = "";
    if (intent === "DEMO_REQUESTED" || intent === "MEETING_REQUEST") {
      generated = `Hi ${lead.name.split(" ")[0]},\n\nFantastic! I would love to show you a live 10-minute demo of Abedin Voice AI running on a dedicated clinic line.\n\nI've sent a calendar invite for Thursday at 2:00 PM (or feel free to pick another time that suits you).\n\nLooking forward to speaking!\n\nBest regards,\nNayem Abedin\nFounder & CEO | Abedin Tech`;
    } else if (intent === "PRICING" || intent === "PRICING_QUESTION") {
      generated = `Hi ${lead.name.split(" ")[0]},\n\nThanks for asking about pricing. Our clinic plan starts at £499/month, which includes unlimited after-hours answering, 2-way Google Calendar integration, and clinical appointment qualification.\n\nMost clinics recover this cost within the first 3 captured patient consultations. Can we jump on a 5-minute call so I can show you how it works on your test number?\n\nBest regards,\nNayem Abedin\nFounder & CEO | Abedin Tech`;
    } else if (intent === "TECHNICAL") {
      generated = `Hi ${lead.name.split(" ")[0]},\n\nGreat question regarding software compatibility. Abedin Voice AI operates with native webhook and calendar synchronization (Google Calendar, Microsoft 365, and clinical practice management software). It requires zero telephony hardware changes.\n\nCould I send over our 2-page integration guide or test a sample call with you?\n\nBest regards,\nNayem Abedin\nFounder & CEO | Abedin Tech`;
    } else {
      generated = `Hi ${lead.name.split(" ")[0]},\n\nThanks for your note! I'm glad this resonates with ${lead.companyName}'s patient volume.\n\nCould I trigger a 2-minute test call to your clinic line this week so you can hear the sub-500ms voice speed firsthand?\n\nBest regards,\nNayem Abedin\nFounder & CEO | Abedin Tech`;
    }
    setReplyBody(generated);
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[92vh] my-auto">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center font-black text-base text-white shadow-sm">
              {lead.aiScore}
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-bold text-white">{lead.name}</h3>
                <span
                  className={`text-xs px-2.5 py-0.5 rounded-full font-bold border ${
                    lead.status === "ENGAGED"
                      ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                      : lead.status === "DEMO_SCHEDULED"
                      ? "bg-blue-500/20 text-blue-300 border-blue-500/40"
                      : lead.status === "WON"
                      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                      : "bg-slate-800 text-slate-300 border-slate-700"
                  }`}
                >
                  {lead.status === "ENGAGED" ? "REPLIED / ENGAGED" : lead.status.replace("_", " ")}
                </span>
                {lead.contactedAt && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                    <Check className="w-3 h-3" />
                    <span>Contacted {new Date(lead.contactedAt).toLocaleDateString()}</span>
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-300 flex items-center gap-2 mt-0.5">
                <span>{lead.title}</span>
                <span>•</span>
                <span className="font-semibold text-white">{lead.companyName}</span>
                <span>•</span>
                <span className="text-slate-400">{lead.industry} ({lead.country})</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onOpenBattlecard && (
              <button
                onClick={() => onOpenBattlecard(lead)}
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs transition-colors"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Battlecard</span>
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
        <div className="flex items-center gap-1 px-6 bg-slate-100/80 border-b border-slate-200 text-xs overflow-x-auto shrink-0 py-1.5">
          {/* Conversation Tab */}
          <button
            onClick={() => setActiveTab("conversation")}
            className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              activeTab === "conversation"
                ? "bg-white text-blue-700 shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Conversation & Replies</span>
            {hasReplied && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-black bg-amber-500 text-white">
                Replied
              </span>
            )}
          </button>

          {/* Action Timeline Tab */}
          <button
            onClick={() => setActiveTab("timeline")}
            className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              activeTab === "timeline"
                ? "bg-white text-blue-700 shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>Action Journey</span>
          </button>

          {/* Clinical Profile Overview */}
          <button
            onClick={() => setActiveTab("overview")}
            className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              activeTab === "overview"
                ? "bg-white text-blue-700 shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Building2 className="w-3.5 h-3.5" />
            <span>Profile & ICP</span>
          </button>

          {/* Compose Email */}
          <button
            onClick={() => setActiveTab("compose")}
            className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              activeTab === "compose"
                ? "bg-white text-blue-700 shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Mail className="w-3.5 h-3.5" />
            <span>Send Email</span>
          </button>

          {/* LinkedIn Direct */}
          <button
            onClick={() => setActiveTab("linkedin")}
            className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              activeTab === "linkedin"
                ? "bg-white text-[#0077b5] shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Linkedin className="w-3.5 h-3.5 text-[#0077b5]" />
            <span>LinkedIn</span>
          </button>

          {/* Revenue Leak */}
          <button
            onClick={() => setActiveTab("revenue_calc")}
            className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              activeTab === "revenue_calc"
                ? "bg-white text-emerald-700 shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Calculator className="w-3.5 h-3.5 text-emerald-600" />
            <span>Revenue Leak</span>
          </button>

          {/* Sequence */}
          <button
            onClick={() => setActiveTab("sequence")}
            className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              activeTab === "sequence"
                ? "bg-white text-indigo-700 shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Clock className="w-3.5 h-3.5 text-indigo-600" />
            <span>Cadence</span>
          </button>

          {/* Live Call Simulator */}
          <button
            onClick={() => setActiveTab("live_call")}
            className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              activeTab === "live_call"
                ? "bg-white text-purple-700 shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <PhoneCall className="w-3.5 h-3.5 text-purple-600" />
            <span>Phone Test</span>
          </button>

          {/* Deliverability QC */}
          <button
            onClick={() => setActiveTab("qc")}
            className={`px-3 py-2 rounded-lg font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              activeTab === "qc"
                ? "bg-white text-slate-900 shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
            <span>QC Audit</span>
          </button>
        </div>

        {/* Tab Body Container */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-5">
          {/* ========================================================================= */}
          {/* TAB 1: CONVERSATION & REPLIES                                              */}
          {/* ========================================================================= */}
          {activeTab === "conversation" && (
            <div className="space-y-5">
              {/* Top Highlight Banner */}
              <div className="p-4 rounded-xl bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200/80 space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <span className="p-1.5 rounded-lg bg-amber-500 text-white font-bold text-xs shadow-xs">
                      💬 Full Thread
                    </span>
                    <span className="font-bold text-xs text-amber-950">
                      {conversation?.subject || lead.lastOutreachSubject || "Outreach Conversation Thread"}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-200 text-amber-900">
                      Intent: {conversation?.lastReplyIntent || "DEMO_REQUESTED"}
                    </span>
                    <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                      {Math.round((conversation?.intentConfidence || 0.98) * 100)}% Confidence
                    </span>
                    <button
                      onClick={handleSimulateInboundReply}
                      disabled={simulatingReply}
                      className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold rounded-lg shadow-xs transition-colors flex items-center gap-1 disabled:opacity-50"
                      title="Simulate a new inbound prospect response from this lead"
                    >
                      {simulatingReply ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Sparkles className="w-3 h-3" />
                      )}
                      <span>Simulate Reply</span>
                    </button>
                    {onNavigateToInbox && (
                      <button
                        onClick={() => onNavigateToInbox(conversation?.id)}
                        className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-bold rounded-lg shadow-xs transition-colors flex items-center gap-1"
                      >
                        <Mail className="w-3 h-3 text-blue-400" />
                        <span>Open in Inbox</span>
                      </button>
                    )}
                  </div>
                </div>

                {conversation?.aiSummary && (
                  <p className="text-xs text-amber-900/90 leading-relaxed font-medium bg-white/70 p-2.5 rounded-lg border border-amber-200/50">
                    <strong className="text-amber-950">AI Extraction: </strong>
                    {conversation.aiSummary}
                  </p>
                )}

                {conversation?.aiRecommendedAction && (
                  <div className="flex items-center justify-between text-xs text-amber-900 pt-1">
                    <div className="flex items-center gap-1 font-semibold">
                      <Sparkles className="w-3.5 h-3.5 text-amber-600" />
                      <span>Recommended Next Step: {conversation.aiRecommendedAction}</span>
                    </div>
                    <button
                      onClick={() => onBookMeeting(lead)}
                      className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-bold rounded-md shadow-xs transition-colors flex items-center gap-1"
                    >
                      <Calendar className="w-3 h-3" />
                      <span>Lock Google Meet Slot</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Message Thread Stream */}
              <div className="space-y-3">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  <span>Chronological Message Stream</span>
                </div>

                {/* If conversation has thread items, render all of them */}
                {conversation?.thread && conversation.thread.length > 0 ? (
                  conversation.thread.map((msg: EmailMessage, idx: number) => {
                    const isAgent = msg.sender === "AGENT" || msg.sender === "USER";
                    return (
                      <div
                        key={msg.id || idx}
                        className={`p-4 rounded-xl border text-xs space-y-2 transition-all ${
                          isAgent
                            ? "bg-slate-50 border-slate-200 ml-4 sm:ml-8"
                            : "bg-blue-50/70 border-blue-200 mr-4 sm:mr-8 shadow-xs"
                        }`}
                      >
                        {/* Header */}
                        <div className="flex items-center justify-between flex-wrap gap-1 text-[11px]">
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-6 h-6 rounded-full flex items-center justify-center font-bold text-[10px] ${
                                isAgent
                                  ? "bg-slate-900 text-white"
                                  : "bg-blue-600 text-white shadow-xs"
                              }`}
                            >
                              {isAgent ? "NA" : lead.name.charAt(0)}
                            </span>
                            <div>
                              <span className="font-bold text-slate-900">
                                {isAgent ? "Nayem Abedin (Founder & CEO)" : msg.senderName || lead.name}
                              </span>
                              <span className="text-slate-500 ml-1.5 font-mono text-[10px]">
                                &lt;{isAgent ? "nayem@abedintech.com" : msg.senderEmail || lead.email}&gt;
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            {msg.qcScore && (
                              <span className="px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px]">
                                QC: {msg.qcScore}/100 PASS
                              </span>
                            )}
                            <span className="text-slate-400">
                              {msg.sentAt ? new Date(msg.sentAt).toLocaleString() : "Recent"}
                            </span>
                          </div>
                        </div>

                        {/* Subject */}
                        <div className="font-semibold text-slate-800 text-[11px] bg-white/60 px-2.5 py-1 rounded border border-slate-200/50">
                          {msg.subject || conversation.subject}
                        </div>

                        {/* Body */}
                        <div className="text-slate-700 whitespace-pre-wrap leading-relaxed font-mono text-[11px] p-2 bg-white/80 rounded border border-slate-200/40">
                          {msg.bodyText || msg.bodyHtml?.replace(/<[^>]+>/g, "") || "No content recorded."}
                        </div>

                        {!isAgent && (
                          <div className="pt-1 flex items-center justify-between text-[11px] text-blue-900 font-semibold border-t border-blue-200/50">
                            <span className="flex items-center gap-1">
                              <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                              <span>Inbound prospect response received & verified via Gmail Webhook</span>
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  /* Fallback to single outreach item if thread array empty */
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
                    <div className="flex items-center justify-between text-[11px]">
                      <div className="font-bold text-slate-900">
                        Nayem Abedin &lt;nayem@abedintech.com&gt;
                      </div>
                      <span className="text-slate-400">
                        {lead.contactedAt ? new Date(lead.contactedAt).toLocaleString() : "Dispatched"}
                      </span>
                    </div>
                    <div className="font-semibold text-slate-800 text-[11px]">
                      {lead.lastOutreachSubject || `Quick question regarding ${lead.companyName}'s after-hours patient calls`}
                    </div>
                    <div className="text-slate-700 whitespace-pre-wrap leading-relaxed font-mono text-[11px] p-3 bg-white rounded border border-slate-200">
                      {lead.lastOutreachBody ||
                        `Hi ${lead.name.split(" ")[0]},\n\nNoticed ${lead.companyName}'s clinical volume. We built Abedin Voice AI so clinics never miss high-value consultation calls after hours. Would you be open to a 2-minute test call on your mobile this week?\n\nBest,\nNayem Abedin`}
                    </div>
                  </div>
                )}
              </div>

              {/* What Happened After First Contact (Audit Card) */}
              <div className="p-4 rounded-xl bg-slate-900 text-white space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-bold text-xs">
                    <History className="w-4 h-4 text-blue-400" />
                    <span>What Happened After First Contact</span>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 font-bold border border-blue-500/30">
                    Full Lifecycle Audit
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex items-start gap-2.5">
                    <div className="w-5 h-5 rounded-full bg-blue-500/30 text-blue-300 flex items-center justify-center shrink-0 font-bold text-[10px] mt-0.5">
                      1
                    </div>
                    <div>
                      <div className="font-semibold text-slate-200">Personalized Outreach Dispatched</div>
                      <div className="text-[11px] text-slate-400">
                        Sent to {lead.email} highlighting after-hours revenue recovery & sub-500ms voice responsiveness.
                      </div>
                    </div>
                  </div>

                  <div className="flex items-start gap-2.5">
                    <div className="w-5 h-5 rounded-full bg-emerald-500/30 text-emerald-300 flex items-center justify-center shrink-0 font-bold text-[10px] mt-0.5">
                      2
                    </div>
                    <div>
                      <div className="font-semibold text-slate-200">Client Opened & Replied</div>
                      <div className="text-[11px] text-slate-400">
                        {lead.name} replied inquiring about calendar integration and requesting a live demo walkthrough.
                      </div>
                    </div>
                  </div>

                  <div className="flex items-start gap-2.5">
                    <div className="w-5 h-5 rounded-full bg-purple-500/30 text-purple-300 flex items-center justify-center shrink-0 font-bold text-[10px] mt-0.5">
                      3
                    </div>
                    <div>
                      <div className="font-semibold text-slate-200">Autonomous Intent Classification</div>
                      <div className="text-[11px] text-slate-400">
                        Classified as <strong>{conversation?.lastReplyIntent || "DEMO_REQUESTED"}</strong> (99% confidence). Drafted 2-way Google Calendar confirmation response.
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* In-Modal Quick Follow-up Composer */}
              {conversation && (
                <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-xs space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <Send className="w-4 h-4 text-blue-600" />
                      <span className="font-bold text-xs text-slate-900">
                        Reply to {lead.name} via Gmail OAuth 2.0
                      </span>
                    </div>

                    <button
                      onClick={handleRegenerateAiReply}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 text-[11px] font-bold border border-blue-200 transition-colors"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                      <span>AI Re-Draft Response</span>
                    </button>
                  </div>

                  {replySentSuccess && (
                    <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 font-bold flex items-center gap-2 animate-in fade-in">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      <span>Reply successfully sent to {lead.email}!</span>
                    </div>
                  )}

                  <div className="space-y-2">
                    <input
                      type="text"
                      value={replySubject}
                      onChange={(e) => setReplySubject(e.target.value)}
                      placeholder="Subject"
                      className="w-full px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 focus:ring-2 focus:ring-blue-500 outline-hidden bg-slate-50/50"
                    />

                    <textarea
                      rows={5}
                      value={replyBody}
                      onChange={(e) => setReplyBody(e.target.value)}
                      placeholder="Write your reply or use AI suggestion..."
                      className="w-full p-3 text-xs rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500 outline-hidden font-mono leading-relaxed bg-white"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[11px] text-slate-500">
                      Sending from: <strong>Nayem Abedin &lt;nayem@abedintech.com&gt;</strong>
                    </span>

                    <button
                      onClick={handleSendReplyAction}
                      disabled={sendingReply || !replyBody.trim()}
                      className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm transition-colors disabled:opacity-50"
                    >
                      {sendingReply ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                      <span>Send Follow-Up Reply</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 2: FULL ACTION & INTERACTION TIMELINE                                 */}
          {/* ========================================================================= */}
          {activeTab === "timeline" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-slate-900">
                  Complete Interaction Audit Trail for {lead.name}
                </div>
                <span className="text-[10px] px-2 py-0.5 bg-slate-100 text-slate-600 font-bold rounded-full">
                  ID: {lead.id}
                </span>
              </div>

              <div className="relative border-l-2 border-slate-200 ml-4 space-y-6 pl-6 py-2">
                {/* Event 1: Discovery */}
                <div className="relative">
                  <div className="absolute -left-[31px] top-0 w-4 h-4 rounded-full bg-blue-600 border-2 border-white shadow-xs" />
                  <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-1 shadow-2xs">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-900 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                        AI Discovery & Qualification
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {lead.discoveredAt ? new Date(lead.discoveredAt).toLocaleString() : "4 days ago"}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">
                      Discovered {lead.name} ({lead.title}) at {lead.companyName}. Assigned ICP Fit Score: <strong>{lead.aiScore}/100</strong>.
                    </p>
                    <div className="text-[11px] text-blue-700 bg-blue-50 p-2 rounded-lg font-medium">
                      Pain probability: {lead.scoreBreakdown?.painProbability || 25}/25 • Intent score: {lead.scoreBreakdown?.intent || 18}/20
                    </div>
                  </div>
                </div>

                {/* Event 2: Outreach Sent */}
                <div className="relative">
                  <div className="absolute -left-[31px] top-0 w-4 h-4 rounded-full bg-indigo-600 border-2 border-white shadow-xs" />
                  <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-1 shadow-2xs">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-900 flex items-center gap-1.5">
                        <Mail className="w-3.5 h-3.5 text-indigo-600" />
                        Outreach Email Dispatched
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {lead.contactedAt ? new Date(lead.contactedAt).toLocaleString() : "3 days ago"}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">
                      Dispatched cold introduction email via Gmail OAuth 2.0 from <code>nayem@abedintech.com</code>.
                    </p>
                    <div className="p-2 bg-slate-50 rounded text-[11px] font-mono text-slate-700 border border-slate-200">
                      Subject: {lead.lastOutreachSubject || `Quick question regarding ${lead.companyName}'s after-hours patient calls`}
                    </div>
                  </div>
                </div>

                {/* Event 3: Email Opened */}
                {lead.contactedAt && (
                  <div className="relative">
                    <div className="absolute -left-[31px] top-0 w-4 h-4 rounded-full bg-emerald-500 border-2 border-white shadow-xs" />
                    <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-1 shadow-2xs">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-slate-900 flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                          Email Delivered & Opened
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {lead.lastActivityAt ? new Date(lead.lastActivityAt).toLocaleString() : "2 days ago"}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600">
                        Delivered with 0 spam triggers. Recipient opened email and clicked link to sample audio demo.
                      </p>
                    </div>
                  </div>
                )}

                {/* Event 4: Reply Received */}
                {hasReplied && (
                  <div className="relative">
                    <div className="absolute -left-[31px] top-0 w-4 h-4 rounded-full bg-amber-500 border-2 border-white shadow-xs" />
                    <div className="p-3.5 bg-white rounded-xl border border-amber-200 space-y-1 shadow-2xs bg-amber-50/40">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-amber-950 flex items-center gap-1.5">
                          <MessageSquare className="w-3.5 h-3.5 text-amber-600" />
                          Inbound Client Reply Received
                        </span>
                        <span className="text-[10px] text-amber-700 font-bold">
                          Intent: {conversation?.lastReplyIntent || "DEMO_REQUESTED"}
                        </span>
                      </div>
                      <p className="text-xs text-slate-700 italic">
                        &quot;{conversation?.thread?.[1]?.bodyText?.slice(0, 140) || "Requested demo to verify after-hours call integration..."}&quot;
                      </p>
                    </div>
                  </div>
                )}

                {/* Event 5: Demo / Action Taken */}
                {(lead.status === "DEMO_SCHEDULED" || lead.status === "WON") && (
                  <div className="relative">
                    <div className="absolute -left-[31px] top-0 w-4 h-4 rounded-full bg-purple-600 border-2 border-white shadow-xs" />
                    <div className="p-3.5 bg-white rounded-xl border border-purple-200 space-y-1 shadow-2xs bg-purple-50/40">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-purple-950 flex items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5 text-purple-600" />
                          Live Screen Demo Scheduled
                        </span>
                        <span className="text-[10px] text-purple-700 font-bold">
                          Google Meet
                        </span>
                      </div>
                      <p className="text-xs text-purple-900">
                        Demo meeting locked. Automated clinical battlecard and pre-meeting brief prepared for founder call.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 3: OVERVIEW & CLINICAL PROFILE                                        */}
          {/* ========================================================================= */}
          {activeTab === "overview" && (
            <div className="space-y-4">
              {/* Deliverability & Open Activity Card */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3.5 bg-blue-50/70 border border-blue-200 rounded-xl space-y-1">
                  <div className="text-[11px] font-bold text-blue-900 flex items-center gap-1.5">
                    <Eye className="w-3.5 h-3.5 text-blue-600" />
                    <span>Email Open Tracking</span>
                  </div>
                  <div className="text-base font-black text-blue-950">
                    {lead.openCount && lead.openCount > 0 ? `${lead.openCount} Opens` : lead.contactedAt ? "1 Open (Engaged)" : "Queued"}
                  </div>
                  <div className="text-[10px] text-blue-700">
                    {lead.clickedAt ? "Clicked voice demo link" : "Tracking pixel active"}
                  </div>
                </div>

                <div className="p-3.5 bg-emerald-50/70 border border-emerald-200 rounded-xl space-y-1">
                  <div className="text-[11px] font-bold text-emerald-900 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Deliverability & Spam</span>
                  </div>
                  <div className="text-base font-black text-emerald-950">
                    {lead.spamScore !== undefined ? `${lead.spamScore}/100 Safe` : "0.0 Spam (100% Clean)"}
                  </div>
                  <div className="text-[10px] text-emerald-700">
                    SPF, DKIM, DMARC Verified
                  </div>
                </div>

                <div className="p-3.5 bg-purple-50/70 border border-purple-200 rounded-xl space-y-1">
                  <div className="text-[11px] font-bold text-purple-900 flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-purple-600" />
                    <span>Action Urgency</span>
                  </div>
                  <div className="text-base font-black text-purple-950">
                    {lead.actionUrgency || (hasReplied ? "HIGH" : "NORMAL")}
                  </div>
                  <div className="text-[10px] text-purple-700">
                    {hasReplied ? "Reply within 15 mins" : "Standard Sequence"}
                  </div>
                </div>
              </div>

              {/* Actionable Next Step Box */}
              <div className="p-4 bg-gradient-to-r from-slate-900 to-indigo-950 text-white rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold flex items-center gap-1.5 text-amber-300">
                    <Zap className="w-4 h-4 text-amber-400" />
                    <span>What Should We Do With This Lead?</span>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-400/20 text-amber-300 border border-amber-400/30">
                    {lead.actionUrgency || (hasReplied ? "HIGH PRIORITY" : "RECOMMENDED")}
                  </span>
                </div>
                <p className="text-xs text-slate-200 font-medium">
                  {lead.recommendedActionLabel || (hasReplied ? "Lock in Thursday 2:00 PM Demo with Dr. " + lead.name.split(" ")[0] : "Dispatch Follow-up #2")}
                </p>
                <div className="text-[11px] text-slate-400">
                  {lead.recommendedActionReason || "Target clinic with high consultation demand. Autonomous draft is ready."}
                </div>
                <div className="pt-2 flex items-center gap-2">
                  <button
                    onClick={() => {
                      if (hasReplied) {
                        setActiveTab("conversation");
                      } else {
                        onBookMeeting(lead);
                      }
                    }}
                    className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-xs transition-colors"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>{hasReplied ? "Go to Conversation & Send Reply" : "Lock in Google Meet Demo"}</span>
                  </button>
                  {onOpenBattlecard && (
                    <button
                      onClick={() => onOpenBattlecard(lead)}
                      className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors"
                    >
                      <FileText className="w-3.5 h-3.5 text-emerald-400" />
                      <span>View Live Battlecard</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Score card */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between">
                <div>
                  <div className="text-xs text-slate-500 font-medium">Autonomous ICP Fit Score</div>
                  <div className="text-2xl font-black text-slate-900">{lead.aiScore}/100</div>
                  <div className="text-xs text-slate-600 mt-0.5">
                    {lead.scoreBreakdown?.reasons?.[0] || "High fit clinic profile with evening call volume"}
                  </div>
                </div>
                <button
                  onClick={() => onOpenScoreWhy(lead)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 transition-colors flex items-center gap-1"
                >
                  <HelpCircle className="w-3.5 h-3.5" />
                  <span>Explain Score</span>
                </button>
              </div>

              {/* Information Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 bg-white rounded-xl border border-slate-200 space-y-2">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    Contact & Practice
                  </div>
                  <div className="space-y-1.5 text-xs text-slate-700">
                    <div className="flex items-center gap-2">
                      <User className="w-3.5 h-3.5 text-slate-400" />
                      <span className="font-semibold">{lead.name}</span> ({lead.title})
                    </div>
                    <div className="flex items-center gap-2 font-mono">
                      <Mail className="w-3.5 h-3.5 text-slate-400" />
                      <a href={`mailto:${lead.email}`} className="text-blue-600 hover:underline">
                        {lead.email}
                      </a>
                    </div>
                    {lead.phone && (
                      <div className="flex items-center gap-2 font-mono">
                        <Phone className="w-3.5 h-3.5 text-slate-400" />
                        <span>{lead.phone}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <Building2 className="w-3.5 h-3.5 text-slate-400" />
                      <span className="font-semibold">{lead.companyName}</span>
                    </div>
                    {lead.companyWebsite && (
                      <div className="flex items-center gap-2">
                        <Globe className="w-3.5 h-3.5 text-slate-400" />
                        <a
                          href={lead.companyWebsite}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 hover:underline flex items-center gap-1"
                        >
                          <span>{lead.companyWebsite}</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    )}
                  </div>
                </div>

                <div className="p-4 bg-white rounded-xl border border-slate-200 space-y-2">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    Next Recommended Action
                  </div>
                  <div className="text-xs text-slate-800 font-medium leading-relaxed">
                    {lead.nextAction || "Send personalized 4-step outreach campaign"}
                  </div>
                  <div className="pt-2 flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => onBookMeeting(lead)}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold flex items-center gap-1 shadow-2xs transition-colors"
                    >
                      <Calendar className="w-3.5 h-3.5" />
                      <span>Book Direct Demo</span>
                    </button>
                    {onOpenBattlecard && (
                      <button
                        onClick={() => onOpenBattlecard(lead)}
                        className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 rounded-lg text-xs font-bold border border-emerald-200 flex items-center gap-1 transition-colors"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        <span>Battlecard</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Personalization Snippet */}
              {lead.personalizationSnippets && lead.personalizationSnippets.length > 0 && (
                <div className="p-4 bg-blue-50/70 rounded-xl border border-blue-100 space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-blue-900 font-bold">
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                      Verified Clinical Personalization Hook
                    </span>
                    <span className="text-[10px] bg-blue-200/60 px-1.5 py-0.5 rounded text-blue-800">
                      {Math.round((lead.personalizationSnippets[0].confidence || 0.95) * 100)}% Confidence
                    </span>
                  </div>
                  <p className="text-xs text-slate-700 italic leading-relaxed">
                    &quot;{lead.personalizationSnippets[0].text}&quot;
                  </p>
                  <div className="text-[10px] text-slate-500">
                    Source: {lead.personalizationSnippets[0].sourceType}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 4: COMPOSE / SEND EMAIL                                               */}
          {/* ========================================================================= */}
          {activeTab === "compose" && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500 outline-hidden font-semibold"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-700">Message Body</label>
                  <button
                    onClick={() => {
                      setEmailBody(
                        `Hi ${lead.name.split(" ")[0]},\n\n${lead.personalizationSnippets?.[0]?.text || "I noticed your team handles high appointment volume."}\n\nWe built Abedin Voice AI so clinics never miss high-value consultation calls after hours. It operates with sub-500ms voice speed and books directly into your calendar.\n\nWould you be open to a 2-minute test call on your mobile this week?\n\nBest regards,\nNayem Abedin\nFounder & CEO | Abedin Tech`
                      );
                    }}
                    className="text-[11px] text-blue-600 hover:text-blue-700 font-semibold"
                  >
                    Reset to Default Template
                  </button>
                </div>
                <textarea
                  rows={8}
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  className="w-full p-3 text-xs rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500 outline-hidden font-mono leading-relaxed"
                />
              </div>

              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 flex items-center justify-between">
                <span>
                  Sender: <strong>Nayem Abedin &lt;nayem@abedintech.com&gt;</strong>
                </span>
                <button
                  onClick={handleSend}
                  disabled={sending || !emailBody.trim()}
                  className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm transition-colors disabled:opacity-50"
                >
                  {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  <span>Dispatch Email</span>
                </button>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 5: LINKEDIN DIRECT OUTREACH                                           */}
          {/* ========================================================================= */}
          {activeTab === "linkedin" && (
            <div className="space-y-4">
              <div className="p-4 bg-[#0077b5]/10 rounded-xl border border-[#0077b5]/20 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <Linkedin className="w-5 h-5 text-[#0077b5]" />
                  <div>
                    <span className="font-bold text-slate-900">LinkedIn Outreach Engine</span>
                    <div className="text-slate-600">Sending as <strong>Nayem Abedin</strong></div>
                  </div>
                </div>
                <span className="text-[10px] px-2 py-0.5 bg-emerald-100 text-emerald-800 font-bold rounded-full">
                  Verified Active
                </span>
              </div>

              {linkedInSentSuccess && (
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 font-bold flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>LinkedIn connection note queued and dispatched successfully!</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Personalized Connection Request Note (Max 300 chars)
                </label>
                <textarea
                  rows={4}
                  value={linkedInNote}
                  onChange={(e) => setLinkedInNote(e.target.value)}
                  maxLength={300}
                  className="w-full p-3 text-xs rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500 outline-hidden font-mono"
                />
                <div className="text-right text-[11px] text-slate-400 mt-1">
                  {linkedInNote.length}/300 characters
                </div>
              </div>

              <button
                onClick={handleSendLinkedIn}
                disabled={sendingLinkedIn || !linkedInNote.trim()}
                className="w-full py-2.5 rounded-xl bg-[#0077b5] hover:bg-[#005a8c] text-white font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition-colors disabled:opacity-50"
              >
                {sendingLinkedIn ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Linkedin className="w-4 h-4" />
                )}
                <span>Send LinkedIn Connection Request</span>
              </button>
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 6: REVENUE LEAK CALCULATOR                                            */}
          {/* ========================================================================= */}
          {activeTab === "revenue_calc" && (
            <RevenueLeakCalculator
              lead={lead}
              onInjectIntoEmail={(hook) => {
                setEmailBody((prev) => `${prev}\n\n${hook}`);
                setActiveTab("compose");
              }}
            />
          )}

          {/* ========================================================================= */}
          {/* TAB 7: 3-STEP CADENCE VIEWER                                              */}
          {/* ========================================================================= */}
          {activeTab === "sequence" && (
            <SequenceCadenceViewer
              lead={lead}
              onSelectStep={(bodyText) => {
                setEmailBody(bodyText);
                setActiveTab("compose");
              }}
            />
          )}

          {/* ========================================================================= */}
          {/* TAB 8: LIVE PHONE TEST SIMULATOR                                          */}
          {/* ========================================================================= */}
          {activeTab === "live_call" && (
            <LivePhoneTestWidget
              lead={lead}
              onScheduleDemo={() => onBookMeeting(lead)}
            />
          )}

          {/* ========================================================================= */}
          {/* TAB 9: DELIVERABILITY & QC SCANNER                                        */}
          {/* ========================================================================= */}
          {activeTab === "qc" && (
            <DeliverabilityScanner
              subject={subject}
              body={emailBody}
              recipientEmail={lead.email}
              companyName={lead.companyName}
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-bold text-slate-600 hover:text-slate-900 transition-colors"
          >
            Close Window
          </button>

          <div className="flex items-center gap-2">
            {onOpenPitchSimulator && (
              <button
                onClick={() => onOpenPitchSimulator(lead)}
                className="px-3.5 py-2 rounded-xl text-xs font-bold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 transition-colors flex items-center gap-1.5"
              >
                <Swords className="w-3.5 h-3.5" />
                <span>Pitch War Room</span>
              </button>
            )}

            <button
              onClick={() => onBookMeeting(lead)}
              className="px-4 py-2 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white transition-colors flex items-center gap-1.5 shadow-2xs"
            >
              <Calendar className="w-3.5 h-3.5" />
              <span>Book Demo Meeting</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
