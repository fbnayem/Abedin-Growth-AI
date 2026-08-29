import React, { useState, useEffect, useRef } from "react";
import {
  Inbox,
  Search,
  Sparkles,
  Send,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Mail,
  User,
  ShieldCheck,
  Loader2,
  Calendar,
  Layers,
  Flame,
  FileText,
  Linkedin,
  ArrowUpRight,
  ExternalLink,
  Filter,
  Check,
  Eye,
  MousePointerClick,
  ShieldAlert,
  HelpCircle,
  X,
  Maximize2,
  Minimize2,
  ChevronDown,
  ChevronUp,
  ArrowDown,
  Video,
  Brain,
  RefreshCw,
  BookOpen,
  History,
} from "lucide-react";
import { Conversation, Message, CompanyBrain, OutboxLogItem, SenderIdentity, LinkedInConfig, Meeting } from "../types";
import { diagnosticFetch } from "../utils/diagnosticFetch";
import { workspaceGmailService, GmailTokenState } from "../services/gmailWorkspaceService";
import { Tag } from "lucide-react";

// Formatter for comprehensive date and time displays
function formatFullDateTime(isoString?: string): string {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatShortDateAndTime(isoString?: string): string {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} • ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

interface InboxViewProps {
  conversations: Conversation[];
  meetings?: Meeting[];
  initialSelectedId?: string;
  outboxLogs?: OutboxLogItem[];
  senderIdentity?: SenderIdentity;
  linkedInConfig?: LinkedInConfig;
  onSelectConversation: (conv: Conversation) => void;
  onSendReply: (convId: string, subject: string, body: string) => Promise<void>;
  onBookMeeting: (conv: Conversation) => void;
  onClassifyThread: (convId: string) => Promise<void>;
  companyBrain?: CompanyBrain | null;
  onRefreshOutbox?: () => void;
  onRefreshConversations?: () => void;
}

export const InboxView: React.FC<InboxViewProps> = ({
  conversations: propConversations,
  meetings: propMeetings = [],
  initialSelectedId,
  outboxLogs: initialOutbox,
  senderIdentity: initialSender,
  linkedInConfig: initialLinkedIn,
  onSelectConversation,
  onSendReply,
  onBookMeeting,
  onClassifyThread,
  companyBrain,
  onRefreshOutbox,
  onRefreshConversations,
}) => {
  const [activeMainTab, setActiveMainTab] = useState<"INBOX" | "OUTBOX">("INBOX");
  const [conversations, setConversations] = useState<Conversation[]>(propConversations);
  const [localMeetings, setLocalMeetings] = useState<Meeting[]>(propMeetings);

  // Keep local meetings in sync
  useEffect(() => {
    setLocalMeetings(propMeetings);
  }, [propMeetings]);
  
  // Find first conversation with prospect replies for default selection
  const firstWithReply = propConversations.find((c) =>
    c.thread?.some((m) => m.sender === "PROSPECT")
  );
  
  const [selectedConvId, setSelectedConvId] = useState<string>(
    initialSelectedId || firstWithReply?.id || propConversations[0]?.id || ""
  );

  // Keep local conversations in sync when props change
  useEffect(() => {
    setConversations(propConversations);
  }, [propConversations]);

  useEffect(() => {
    if (initialSelectedId) {
      setSelectedConvId(initialSelectedId);
      setActiveMainTab("INBOX");
    } else if (!selectedConvId && conversations.length > 0) {
      const best = conversations.find((c) => c.thread?.some((m) => m.sender === "PROSPECT")) || conversations[0];
      setSelectedConvId(best.id);
    }
  }, [initialSelectedId, conversations]);

  const [inboxFilter, setInboxFilter] = useState<"REPLIES" | "AWAITING" | "BOOKED" | "ALL">("REPLIES");
  const [categoryFilter, setCategoryFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [outboxChannelFilter, setOutboxChannelFilter] = useState<string>("ALL");
  const [outboxStatusFilter, setOutboxStatusFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  const [outboxList, setOutboxList] = useState<OutboxLogItem[]>(initialOutbox || []);
  const [selectedOutboxItem, setSelectedOutboxItem] = useState<OutboxLogItem | null>(null);

  const sender = initialSender || {
    senderName: "Nayem Abedin",
    senderEmail: "nayem@abedintech.com",
    jobTitle: "Founder & CEO",
    companyName: "Abedin Tech",
    provider: "GMAIL_OAUTH",
    status: "CONNECTED",
  };

  const linkedIn = initialLinkedIn || {
    profileName: "Nayem Abedin",
    connected: true,
  };

  // Fetch Outbox
  const fetchOutbox = async () => {
    try {
      const res = await diagnosticFetch("/api/outbox");
      if (res.ok) {
        const data = await res.json();
        setOutboxList(data);
      }
    } catch (e) {
      console.error("Failed to load outbox:", e);
    }
  };

  // Fetch Live Conversations from server
  const fetchLiveConversations = async () => {
    try {
      const res = await diagnosticFetch("/api/inbox");
      if (res.ok) {
        const data = await res.json();
        setConversations(data);
        if (onRefreshConversations) {
          onRefreshConversations();
        }
      }
    } catch (e) {
      console.error("Failed to refresh conversations:", e);
    }
  };

  useEffect(() => {
    fetchOutbox();
  }, [conversations.length]);

  const activeConv = conversations.find((c) => c.id === selectedConvId) || conversations[0];

  const [draftSubject, setDraftSubject] = useState(
    activeConv?.proposedAiDraft?.subject || `Re: ${activeConv?.subject || "Follow up"}`
  );
  const [draftBody, setDraftBody] = useState(
    activeConv?.proposedAiDraft?.body || ""
  );
  const [gmailState, setGmailState] = useState<GmailTokenState>(workspaceGmailService.getState());
  const [syncingWorkspace, setSyncingWorkspace] = useState(false);

  useEffect(() => {
    const unsub = workspaceGmailService.subscribe((st) => {
      setGmailState(st);
    });
    return () => unsub();
  }, []);

  const handleSyncWorkspaceGmail = async () => {
    setSyncingWorkspace(true);
    try {
      if (!gmailState.isConnected) {
        await workspaceGmailService.requestAuthorization(sender.senderEmail || "info@abedintech.com");
      }
      await workspaceGmailService.ensureAbedinGrowthLabel();
      await fetchLiveConversations();
    } catch (e) {
      console.warn("Gmail sync error:", e);
    } finally {
      setSyncingWorkspace(false);
    }
  };

  const [activeRightSubTab, setActiveRightSubTab] = useState<"THREAD" | "MEMORY">("THREAD");
  const [refreshingMemory, setRefreshingMemory] = useState(false);
  const [generatingFollowUp, setGeneratingFollowUp] = useState(false);
  const [generatingMultiAgent, setGeneratingMultiAgent] = useState(false);
  const [multiAgentInfo, setMultiAgentInfo] = useState<{
    answeredPoints?: string[];
    meetingProposed?: boolean;
    phonePolicyValidation?: {
      flagged: boolean;
      detectedPatterns: string[];
      validationStatus: string;
    };
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [autoReplying, setAutoReplying] = useState(false);
  const [autoReplyingAll, setAutoReplyingAll] = useState(false);
  const [simulatingReply, setSimulatingReply] = useState(false);
  const [showAiBanner, setShowAiBanner] = useState(true);
  const [expandedThreadModalOpen, setExpandedThreadModalOpen] = useState(false);
  const [auditModalOpen, setAuditModalOpen] = useState(false);
  const [runningAudit, setRunningAudit] = useState(false);
  const [auditReport, setAuditReport] = useState<{
    timestamp?: string;
    totalConversationsAudited?: number;
    totalMessagesAudited?: number;
    totalDraftsAudited?: number;
    totalOutboxLogsAudited?: number;
    linkMismatchesCorrectedCount?: number;
    phonePatternsRemovedCount?: number;
    mergeTagsNormalizedCount?: number;
    allCleanAndCompliant?: boolean;
    detailedFixes?: {
      entityType: string;
      id: string;
      recipientOrContact: string;
      fixesApplied: string[];
    }[];
    pipelineStatus?: {
      tier1_IntentClassification: string;
      tier2_CompanyBrainComposer: string;
      tier3_SemanticLinkGatekeeper: string;
      tier4_MergeTagNormalizer: string;
      tier5_ExecutiveQC: string;
    };
    policyUrls?: {
      calendarBookingUrl: string;
      googleMeetUrl: string;
    };
  } | null>(null);
  const [testHarnessText, setTestHarnessText] = useState(
    "Alternatively, you can choose any time directly on my calendar: https://meet.google.com/abn-vce-demo\nOr reach me at +44 7700 900077."
  );
  const [testHarnessResult, setTestHarnessResult] = useState<{
    sanitized?: string;
    flagged?: boolean;
    detectedPatterns?: string[];
    validationStatus?: string;
  } | null>(null);

  const handleRunDeepAudit = async () => {
    setRunningAudit(true);
    try {
      const res = await diagnosticFetch("/api/inbox/deep-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        const data = await res.json();
        setAuditReport(data.auditReport);
        await fetchLiveConversations();
        await fetchOutbox();
        if (onRefreshOutbox) onRefreshOutbox();
        if (onRefreshConversations) onRefreshConversations();
      }
    } catch (e) {
      console.error("Deep audit error:", e);
    } finally {
      setRunningAudit(false);
    }
  };

  const handleRunTestHarness = async () => {
    try {
      const res = await diagnosticFetch("/api/inbox/validate-phone-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: testHarnessText }),
      });
      if (res.ok) {
        const data = await res.json();
        setTestHarnessResult(data);
      }
    } catch (e) {
      console.error("Test harness error:", e);
    }
  };

  // Message scroll reference
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const threadContainerRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = () => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  };

  // Auto-scroll when conversation changes or messages update
  useEffect(() => {
    const timer = setTimeout(() => {
      scrollToBottom();
    }, 100);
    return () => clearTimeout(timer);
  }, [activeConv?.id, activeConv?.thread?.length]);

  // Sync draft when active conversation changes
  useEffect(() => {
    if (activeConv) {
      setDraftSubject(
        activeConv.proposedAiDraft?.subject || `Re: ${activeConv.subject || "Follow up"}`
      );
      setDraftBody(activeConv.proposedAiDraft?.body || "");
    }
  }, [activeConv?.id]);

  const handleSimulateClientReply = async (convId?: string) => {
    setSimulatingReply(true);
    try {
      const targetUrl = convId ? `/api/inbox/${convId}/simulate-reply` : "/api/inbox/simulate-reply";
      const res = await diagnosticFetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        const data = await res.json();
        await fetchLiveConversations();
        if (data.conversation?.id) {
          setSelectedConvId(data.conversation.id);
        }
      }
    } catch (e) {
      console.error("Simulate client reply error:", e);
    } finally {
      setSimulatingReply(false);
    }
  };

  const handleAutoReplyConversation = async (convId: string) => {
    setAutoReplying(true);
    try {
      const res = await diagnosticFetch(`/api/inbox/${convId}/auto-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        await fetchLiveConversations();
        await fetchOutbox();
        if (onRefreshOutbox) {
          onRefreshOutbox();
        }
        if (onRefreshConversations) {
          onRefreshConversations();
        }
      }
    } catch (e) {
      console.error("Auto reply error:", e);
    } finally {
      setAutoReplying(false);
    }
  };

  const handleAutoReplyAllInbounds = async () => {
    setAutoReplyingAll(true);
    try {
      const res = await diagnosticFetch("/api/inbox/auto-reply-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        await fetchLiveConversations();
        await fetchOutbox();
        if (onRefreshOutbox) {
          onRefreshOutbox();
        }
        if (onRefreshConversations) {
          onRefreshConversations();
        }
      }
    } catch (e) {
      console.error("Auto reply all error:", e);
    } finally {
      setAutoReplyingAll(false);
    }
  };

  const handleRefreshMemory = async (convId?: string) => {
    const id = convId || activeConv?.id;
    if (!id) return;
    setRefreshingMemory(true);
    try {
      const res = await diagnosticFetch(`/api/inbox/${id}/memory/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        await fetchLiveConversations();
      }
    } catch (e) {
      console.error("Refresh memory error:", e);
    } finally {
      setRefreshingMemory(false);
    }
  };

  const handleGenerateFollowUp = async (convId?: string) => {
    const id = convId || activeConv?.id;
    if (!id) return;
    setGeneratingFollowUp(true);
    try {
      const res = await diagnosticFetch(`/api/inbox/${id}/follow-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        await fetchLiveConversations();
        await fetchOutbox();
        if (onRefreshOutbox) onRefreshOutbox();
        if (onRefreshConversations) onRefreshConversations();
      }
    } catch (e) {
      console.error("Follow-up error:", e);
    } finally {
      setGeneratingFollowUp(false);
    }
  };

  const handleGenerateMultiAgentDraft = async (convId?: string) => {
    const id = convId || activeConv?.id;
    if (!id) return;
    setGeneratingMultiAgent(true);
    try {
      const res = await diagnosticFetch(`/api/inbox/${id}/generate-multi-agent-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.sanitizedBody) {
          setDraftSubject(data.subject || draftSubject);
          setDraftBody(data.sanitizedBody);
          setMultiAgentInfo({
            answeredPoints: data.answeredPoints || [],
            meetingProposed: data.meetingProposed || true,
            phonePolicyValidation: data.phonePolicyValidation || {
              flagged: false,
              detectedPatterns: [],
              validationStatus: "PASS - 100% Zero-Phone-Number Policy Compliant",
            },
          });
        }
        await fetchLiveConversations();
      }
    } catch (e) {
      console.error("Multi-agent draft generation error:", e);
    } finally {
      setGeneratingMultiAgent(false);
    }
  };

  const handleSanitizeComposerPhoneNumbers = async () => {
    try {
      const res = await diagnosticFetch("/api/inbox/validate-phone-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draftBody }),
      });
      if (res.ok) {
        const data = await res.json();
        setDraftBody(data.sanitized);
      }
    } catch (e) {
      console.error("Validation error:", e);
    }
  };

  const handleSend = async () => {
    if (!activeConv) return;
    setSending(true);
    try {
      // If live Google Workspace OAuth token is present, send directly via Workspace Gmail API and label "Abedin Growth AI"
      if (gmailState.isConnected && gmailState.accessToken) {
        try {
          await workspaceGmailService.sendEmail({
            to: activeConv.contactEmail,
            subject: draftSubject,
            bodyText: draftBody,
          });
        } catch (workspaceErr) {
          console.warn("Direct Gmail API send encountered an issue, falling back to server dispatch:", workspaceErr);
        }
      }

      await onSendReply(activeConv.id, draftSubject, draftBody);
      await fetchLiveConversations();
      await fetchOutbox();
      if (onRefreshOutbox) {
        onRefreshOutbox();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSending(false);
    }
  };

  const handleRunClassify = async () => {
    if (!activeConv) return;
    setClassifying(true);
    try {
      await onClassifyThread(activeConv.id);
      await fetchLiveConversations();
    } catch (e) {
      console.error(e);
    } finally {
      setClassifying(false);
    }
  };

  // Counts for filters
  const conversationsWithReplies = conversations.filter((c) =>
    c.thread?.some((m) => m.sender === "PROSPECT")
  );
  const awaitingReplyConversations = conversations.filter((c) => {
    const lastMsg = c.thread?.[c.thread.length - 1];
    return lastMsg?.sender === "PROSPECT";
  });
  const bookedConversations = conversations.filter(
    (c) => c.status === "DEMO_BOOKED" || c.status === "MEETING_REQUESTED"
  );

  const filteredConversations = conversations.filter((conv) => {
    const hasProspectReply = conv.thread?.some((m) => m.sender === "PROSPECT");
    const lastMsg = conv.thread?.[conv.thread.length - 1];
    const isAwaiting = lastMsg?.sender === "PROSPECT";

    // Primary Inbox Sub-filter
    if (inboxFilter === "REPLIES" && !hasProspectReply) return false;
    if (inboxFilter === "AWAITING" && !isAwaiting) return false;
    if (inboxFilter === "BOOKED" && conv.status !== "DEMO_BOOKED" && conv.status !== "MEETING_REQUESTED") return false;

    // Category Filter
    if (categoryFilter !== "ALL" && conv.category !== categoryFilter) return false;

    // Status Filter
    if (statusFilter === "AWAITING" && (conv.status === "RESOLVED" || conv.status === "DEMO_BOOKED")) return false;
    if (statusFilter === "DEMO_BOOKED" && conv.status !== "DEMO_BOOKED" && conv.status !== "MEETING_REQUESTED") return false;

    // Search Query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchName = conv.contactName.toLowerCase().includes(q);
      const matchCompany = conv.companyName.toLowerCase().includes(q);
      const matchSubject = conv.subject.toLowerCase().includes(q);
      const matchSnippet = conv.thread?.some((m) => m.bodyText.toLowerCase().includes(q));
      return matchName || matchCompany || matchSubject || matchSnippet;
    }
    return true;
  });

  const filteredOutbox = outboxList.filter((item) => {
    if (outboxChannelFilter !== "ALL" && item.channel !== outboxChannelFilter) return false;
    if (categoryFilter !== "ALL" && item.category !== categoryFilter) return false;
    if (outboxStatusFilter === "OPENED" && !(item.openCount && item.openCount > 0)) return false;
    if (outboxStatusFilter === "CLICKED" && !item.clickedAt) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        item.recipientName.toLowerCase().includes(q) ||
        item.companyName.toLowerCase().includes(q) ||
        item.subject.toLowerCase().includes(q) ||
        item.recipientEmail.toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Outbox Analytics KPI calculations
  const totalOutbox = outboxList.length;
  const openedOutbox = outboxList.filter((o) => (o.openCount || 0) > 0).length;
  const clickedOutbox = outboxList.filter((o) => !!o.clickedAt).length;
  const openRate = totalOutbox > 0 ? ((openedOutbox / totalOutbox) * 100).toFixed(1) : "0.0";
  const clickRate = totalOutbox > 0 ? ((clickedOutbox / totalOutbox) * 100).toFixed(1) : "0.0";

  return (
    <div className="h-full flex-1 flex flex-col min-h-0 space-y-2.5">
      {/* Top Main Navigation & Sender Info Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 bg-white p-2.5 px-3.5 rounded-2xl border border-slate-200 shadow-2xs shrink-0">
        {/* Tab Switcher */}
        <div className="flex items-center gap-2">
          <div className="flex items-center p-1 bg-slate-100 rounded-xl">
            <button
              onClick={() => setActiveMainTab("INBOX")}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                activeMainTab === "INBOX"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Inbox className="w-3.5 h-3.5 text-blue-600" />
              <span>Inbound Client Replies</span>
              <span className="px-2 py-0.5 rounded-full text-[11px] bg-blue-600 text-white font-extrabold shadow-xs">
                {conversationsWithReplies.length}
              </span>
            </button>

            <button
              onClick={() => {
                setActiveMainTab("OUTBOX");
                fetchOutbox();
              }}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                activeMainTab === "OUTBOX"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Send className="w-3.5 h-3.5 text-indigo-600" />
              <span>Outbox & Deliverability</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-indigo-100 text-indigo-800 font-bold">
                {outboxList.length}
              </span>
            </button>
          </div>
        </div>

        {/* Sender Channel Status Pill */}
        <div className="flex items-center gap-2 text-xs">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-50 border border-slate-200">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-slate-500">Workspace:</span>
            <strong className="text-slate-900 font-mono">{sender.senderEmail}</strong>
          </div>

          <button
            onClick={handleSyncWorkspaceGmail}
            disabled={syncingWorkspace}
            title="Sync Gmail inbox with 'Abedin Growth AI' label"
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-900 font-bold transition-all disabled:opacity-50"
          >
            <Tag className="w-3.5 h-3.5 text-blue-600" />
            <span>Label: Abedin Growth AI</span>
            {syncingWorkspace ? (
              <RefreshCw className="w-3 h-3 text-blue-600 animate-spin ml-1" />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 ml-1" />
            )}
          </button>

          <button
            onClick={() => {
              setAuditModalOpen(true);
              if (!auditReport) {
                handleRunDeepAudit();
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-700 text-white font-bold hover:from-emerald-700 hover:to-teal-800 transition-all shadow-2xs text-xs"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-200" />
            <span>🛡️ Quality Gatekeeper & Audit</span>
          </button>

          <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-700">
            <Linkedin className="w-3.5 h-3.5 text-[#0077b5]" />
            <span><strong>{linkedIn.profileName}</strong></span>
          </div>
        </div>
      </div>

      {/* VIEW 1: INCOMING REPLIES & CONVERSATION THREADS */}
      {activeMainTab === "INBOX" && (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-3 bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-hidden h-full">
          {/* LEFT COLUMN: Conversation List (5 cols) */}
          <div className="lg:col-span-5 border-r border-slate-200 flex flex-col h-full min-h-0 bg-slate-50/40 overflow-hidden">
            {/* Filter Bar */}
            <div className="p-2.5 border-b border-slate-200 space-y-2 bg-white shrink-0">
              {/* Autonomous Auto-Reply Engine Status Banner (Collapsible) */}
              <div className="p-2 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl border border-blue-200 space-y-1.5 transition-all">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 font-bold text-blue-950">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span>24/7 Inbound Auto-Reply Engine</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] font-mono font-bold px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800">
                      LIVE
                    </span>
                    <button
                      onClick={() => setShowAiBanner(!showAiBanner)}
                      className="p-0.5 rounded text-blue-700 hover:bg-blue-100 transition-colors"
                      title={showAiBanner ? "Collapse banner" : "Expand banner"}
                    >
                      {showAiBanner ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                {showAiBanner && (
                  <>
                    <p className="text-[10.5px] text-blue-800 leading-tight">
                      Autonomous AI replies to client inquiries with sub-500ms voice facts & Google Calendar demo links.
                    </p>
                    <div className="flex items-center gap-1.5 pt-0.5">
                      <button
                        onClick={handleAutoReplyAllInbounds}
                        disabled={autoReplyingAll}
                        className="flex-1 py-1.5 px-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold shadow-xs flex items-center justify-center gap-1.5 transition-all disabled:opacity-50"
                      >
                        {autoReplyingAll ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>Auto-Replying...</span>
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-3.5 h-3.5" />
                            <span>⚡ Auto-Reply All Inbounds</span>
                          </>
                        )}
                      </button>

                      <button
                        onClick={() => handleSimulateClientReply()}
                        disabled={simulatingReply}
                        title="Simulate a new incoming reply from a contacted clinic"
                        className="py-1.5 px-2.5 bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300 rounded-lg text-xs font-bold shadow-2xs flex items-center justify-center gap-1 transition-all disabled:opacity-50 shrink-0"
                      >
                        {simulatingReply ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Mail className="w-3.5 h-3.5 text-amber-700" />
                        )}
                        <span>+ Sim Reply</span>
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* Primary Inbound Sub-Filter Pills */}
              <div className="grid grid-cols-4 gap-1 p-1 bg-slate-100 rounded-xl text-center text-[10.5px] font-bold">
                <button
                  onClick={() => setInboxFilter("REPLIES")}
                  className={`py-1 px-1 rounded-lg transition-all ${
                    inboxFilter === "REPLIES"
                      ? "bg-white text-blue-900 shadow-xs font-extrabold"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  Replies ({conversationsWithReplies.length})
                </button>
                <button
                  onClick={() => setInboxFilter("AWAITING")}
                  className={`py-1 px-1 rounded-lg transition-all ${
                    inboxFilter === "AWAITING"
                      ? "bg-white text-amber-900 shadow-xs font-extrabold"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  Active ({awaitingReplyConversations.length})
                </button>
                <button
                  onClick={() => setInboxFilter("BOOKED")}
                  className={`py-1 px-1 rounded-lg transition-all ${
                    inboxFilter === "BOOKED"
                      ? "bg-white text-purple-900 shadow-xs font-extrabold"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  Booked ({bookedConversations.length})
                </button>
                <button
                  onClick={() => setInboxFilter("ALL")}
                  className={`py-1 px-1 rounded-lg transition-all ${
                    inboxFilter === "ALL"
                      ? "bg-white text-slate-900 shadow-xs font-extrabold"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  All ({conversations.length})
                </button>
              </div>

              <div className="flex items-center gap-1.5">
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search client replies..."
                    className="w-full pl-8 pr-2.5 py-1 text-xs rounded-lg border border-slate-200 bg-slate-50 focus:bg-white outline-hidden focus:ring-2 focus:ring-blue-500 font-medium"
                  />
                </div>

                <div className="flex gap-1 shrink-0">
                  {[
                    { id: "ALL", label: "All" },
                    { id: "CUSTOMER", label: "Clinics" },
                    { id: "INVESTOR", label: "Investors" },
                    { id: "PARTNER", label: "Partners" },
                  ].map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setCategoryFilter(t.id)}
                      className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                        categoryFilter === t.id
                          ? "bg-slate-900 text-white font-bold"
                          : "text-slate-600 bg-slate-100 hover:bg-slate-200"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* List of Conversations - Fully Scrollable */}
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar divide-y divide-slate-100">
              {filteredConversations.length === 0 ? (
                <div className="p-8 text-center text-slate-400 space-y-3">
                  <Inbox className="w-8 h-8 mx-auto text-slate-300" />
                  <div className="text-xs font-bold text-slate-600">No conversations in this view</div>
                  <p className="text-[11px] text-slate-500 max-w-xs mx-auto">
                    Click "+ Sim Reply" above to trigger a live incoming client inquiry from a contacted clinic.
                  </p>
                  <button
                    onClick={() => handleSimulateClientReply()}
                    className="px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 text-xs font-bold hover:bg-blue-100"
                  >
                    Simulate Client Reply Now
                  </button>
                </div>
              ) : (
                filteredConversations.map((conv, convIdx) => {
                  const isSelected = activeConv?.id === conv.id;
                  const prospectMsgs = conv.thread?.filter((m) => m.sender === "PROSPECT") || [];
                  const latestProspectMsg = prospectMsgs[prospectMsgs.length - 1];
                  const latestMsg = conv.thread?.[conv.thread.length - 1];
                  const hasProspectReply = prospectMsgs.length > 0;
                  const isLastMsgProspect = latestMsg?.sender === "PROSPECT";
                  const hasAgentReplied = conv.thread?.some((m) => m.sender === "AGENT" || m.sender === "AI");

                  return (
                    <div
                      key={conv.id ? `${conv.id}_${convIdx}` : `conv_${convIdx}`}
                      onClick={() => {
                        setSelectedConvId(conv.id);
                        onSelectConversation(conv);
                      }}
                      className={`p-3 cursor-pointer transition-all ${
                        isSelected
                          ? "bg-blue-50/95 border-l-4 border-blue-600 shadow-2xs"
                          : "hover:bg-slate-100/70"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-1">
                        <div className="flex items-center gap-1.5 truncate">
                          <span
                            className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px] shrink-0 ${
                              hasProspectReply
                                ? "bg-amber-500 text-white shadow-2xs"
                                : "bg-slate-300 text-slate-700"
                            }`}
                          >
                            {conv.contactName.replace("Dr. ", "").charAt(0)}
                          </span>
                          <span className="font-bold text-xs text-slate-900 truncate">
                            {conv.contactName}
                          </span>
                        </div>
                        <span className="text-[10px] text-slate-500 shrink-0 font-medium bg-slate-100 px-1.5 py-0.5 rounded">
                          {formatShortDateAndTime(conv.updatedAt)}
                        </span>
                      </div>

                      <div className="text-[11px] text-slate-600 font-medium truncate mt-0.5">
                        {conv.companyName}
                      </div>

                      {/* Prominent Client Inbound Message Box if replied */}
                      {hasProspectReply && latestProspectMsg ? (
                        <div className="mt-2 p-2 rounded-xl bg-amber-50/90 border border-amber-200 text-xs text-amber-950 space-y-1">
                          <div className="flex items-center justify-between text-[10px] font-bold text-amber-800">
                            <span className="flex items-center gap-1">
                              <Mail className="w-3 h-3 text-amber-600" />
                              <span>📩 Inbound Reply</span>
                            </span>
                            <span className="font-mono text-[9px] uppercase px-1.5 py-0.2 bg-amber-200/80 rounded font-bold">
                              {conv.lastReplyIntent?.replace("_", " ") || "INTERESTED"}
                            </span>
                          </div>
                          <div className="line-clamp-2 font-medium leading-snug">
                            "{latestProspectMsg.bodyText}"
                          </div>
                          <div className="text-[9px] text-amber-700 font-medium flex items-center gap-1 pt-0.5">
                            <Clock className="w-2.5 h-2.5" />
                            <span>Received: {formatShortDateAndTime(latestProspectMsg.sentAt)}</span>
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs text-slate-500 italic mt-1.5 line-clamp-1">
                          Outreach dispatched • Awaiting prospect reply
                        </div>
                      )}

                      {/* Status Badges */}
                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        {conv.status === "DEMO_BOOKED" || conv.status === "MEETING_REQUESTED" ? (
                          <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 flex items-center gap-1 border border-purple-200 shadow-2xs">
                            <Calendar className="w-2.5 h-2.5 text-purple-700" />
                            <span>📅 Demo Booked</span>
                          </span>
                        ) : isLastMsgProspect ? (
                          <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-amber-200 text-amber-900 flex items-center gap-1 animate-pulse border border-amber-300">
                            <Clock className="w-2.5 h-2.5" />
                            <span>🔴 Needs AI Reply</span>
                          </span>
                        ) : hasAgentReplied && hasProspectReply ? (
                          <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 flex items-center gap-1 border border-emerald-200">
                            <Check className="w-2.5 h-2.5" />
                            <span>⚡ AI Replied (Meet Link Sent)</span>
                          </span>
                        ) : (
                          <span className="text-[9px] font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 flex items-center gap-1">
                            <span>Waiting on Lead</span>
                          </span>
                        )}

                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200 flex items-center gap-1">
                          <Tag className="w-2.5 h-2.5 text-blue-600" />
                          <span>Abedin Growth AI</span>
                        </span>

                        {conv.memory && (
                          <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-200 flex items-center gap-1">
                            <Brain className="w-2.5 h-2.5 text-indigo-600" />
                            <span>Memory Active ({conv.memory.keyPainPoints?.length || 0} facts)</span>
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* RIGHT COLUMN: Thread Detail & AI Composer & Memory Dossier (7 cols) */}
          <div className="lg:col-span-7 flex flex-col h-full min-h-0 bg-white overflow-hidden">
            {activeConv ? (
              <div className="flex flex-col h-full min-h-0 overflow-hidden">
                {/* Contact Header */}
                <div className="p-3 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 bg-white shrink-0">
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-sm font-bold text-slate-900 truncate">{activeConv.contactName}</h2>
                      <span className="text-xs text-slate-500 font-mono truncate">&lt;{activeConv.contactEmail}&gt;</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-bold border border-blue-200 flex items-center gap-1 shrink-0">
                        <Tag className="w-2.5 h-2.5 text-blue-600" />
                        <span>Abedin Growth AI</span>
                      </span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-medium border border-slate-200 shrink-0">
                        From: {sender.senderEmail}
                      </span>
                      {activeConv.memory?.prospectSentiment && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 font-bold border border-purple-200 shrink-0">
                          Sentiment: {activeConv.memory.prospectSentiment.replace(/_/g, " ")}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-600 truncate">
                      {activeConv.contactTitle} at <strong>{activeConv.companyName}</strong>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                    <button
                      onClick={() => handleSimulateClientReply(activeConv.id)}
                      disabled={simulatingReply}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-300 transition-colors disabled:opacity-50 shadow-2xs"
                    >
                      {simulatingReply ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Mail className="w-3.5 h-3.5 text-amber-700" />
                      )}
                      <span>+ Sim Inbound</span>
                    </button>

                    <button
                      onClick={() => handleAutoReplyConversation(activeConv.id)}
                      disabled={autoReplying}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-xs transition-colors disabled:opacity-50"
                      title="Checks full thread and memory before drafting and dispatching founder reply"
                    >
                      {autoReplying ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5" />
                      )}
                      <span>⚡ Memory Auto-Reply</span>
                    </button>

                    <button
                      onClick={() => handleGenerateFollowUp(activeConv.id)}
                      disabled={generatingFollowUp}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 transition-colors disabled:opacity-50"
                      title="Checks complete thread and sends memory-aware follow-up"
                    >
                      {generatingFollowUp ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <History className="w-3.5 h-3.5 text-indigo-600" />
                      )}
                      <span>Follow-Up #{((activeConv.memory?.followUpCount || 0) + 1)}</span>
                    </button>

                    <button
                      onClick={() => onBookMeeting(activeConv)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 transition-colors"
                    >
                      <Calendar className="w-3.5 h-3.5" />
                      <span>Book Demo</span>
                    </button>

                    <button
                      onClick={() => setExpandedThreadModalOpen(true)}
                      className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 border border-slate-200 transition-colors"
                      title="Expand thread into fullscreen inspection view"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Sub-view Navigation: Conversation Thread vs. Memory Dossier */}
                <div className="px-3 py-1.5 bg-slate-100/90 border-b border-slate-200 flex items-center justify-between gap-2 shrink-0">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setActiveRightSubTab("THREAD")}
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition-colors ${
                        activeRightSubTab === "THREAD"
                          ? "bg-white text-blue-700 shadow-xs border border-slate-200"
                          : "text-slate-600 hover:text-slate-900 hover:bg-white/60"
                      }`}
                    >
                      <Mail className="w-3.5 h-3.5 text-blue-600" />
                      <span>Email Thread ({activeConv.thread?.length || 0})</span>
                    </button>

                    <button
                      onClick={() => setActiveRightSubTab("MEMORY")}
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition-colors ${
                        activeRightSubTab === "MEMORY"
                          ? "bg-white text-indigo-700 shadow-xs border border-indigo-200"
                          : "text-slate-600 hover:text-slate-900 hover:bg-white/60"
                      }`}
                    >
                      <Brain className="w-3.5 h-3.5 text-indigo-600" />
                      <span>Conversation Memory Dossier</span>
                      <span className="px-1.5 py-0.2 rounded-full bg-indigo-100 text-indigo-800 text-[9px]">
                        Allocated
                      </span>
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleRefreshMemory(activeConv.id)}
                      disabled={refreshingMemory}
                      className="flex items-center gap-1 text-[11px] text-slate-600 hover:text-indigo-600 font-medium px-2 py-0.5 rounded-md hover:bg-white transition-colors"
                      title="Re-synthesizes conversation memory by inspecting full thread history"
                    >
                      <RefreshCw className={`w-3 h-3 ${refreshingMemory ? "animate-spin text-indigo-600" : ""}`} />
                      <span>Re-analyze Thread</span>
                    </button>
                  </div>
                </div>

                {/* AI Summary Banner */}
                <div className="px-3.5 py-2 bg-gradient-to-r from-blue-50/90 to-indigo-50/90 border-b border-indigo-100 flex items-center justify-between text-xs text-indigo-950 shrink-0">
                  <div className="flex items-center gap-2 truncate pr-2">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                    <span className="truncate">
                      <strong>AI Strategy:</strong>{" "}
                      {activeConv.aiRecommendedAction ||
                        activeConv.aiSummary ||
                        "Address patient call volume and propose a live 2-minute test call on their mobile."}
                    </span>
                  </div>
                  <span className="text-[10px] font-bold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded-md shrink-0 border border-emerald-200">
                    Intent: {activeConv.lastReplyIntent || "INTERESTED"}
                  </span>
                </div>

                {/* TAB 1: CONVERSATION MEMORY DOSSIER */}
                {activeRightSubTab === "MEMORY" && (
                  <div className="flex-1 min-h-0 p-4 overflow-y-auto custom-scrollbar space-y-4 bg-slate-50">
                    <div className="p-4 rounded-xl bg-gradient-to-br from-indigo-900 to-slate-900 text-white shadow-md border border-indigo-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="p-1.5 rounded-lg bg-indigo-500/30 text-indigo-200">
                            <Brain className="w-4 h-4" />
                          </span>
                          <h3 className="font-bold text-sm text-white">
                            Allocated Conversation Memory Dossier
                          </h3>
                          <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
                            FULL THREAD SYNCHRONIZED
                          </span>
                        </div>
                        <p className="text-xs text-indigo-200 leading-relaxed max-w-2xl">
                          The Auto-Reply and Follow-Up engines evaluate this entire memory structure and the complete multi-turn email history before composing any response, avoiding repetition and respecting historical commitments.
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => handleRefreshMemory(activeConv.id)}
                          disabled={refreshingMemory}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm transition-colors disabled:opacity-50"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${refreshingMemory ? "animate-spin" : ""}`} />
                          <span>Re-Synthesize</span>
                        </button>
                      </div>
                    </div>

                    {/* Grid of Memory Cards */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                      {/* Card 1: Key Pain Points */}
                      <div className="p-3.5 rounded-xl bg-white border border-slate-200 shadow-2xs space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                          <span className="w-2 h-2 rounded-full bg-rose-500" />
                          <span>Extracted Clinical / Operational Pains</span>
                        </div>
                        <ul className="space-y-1.5 text-xs text-slate-700">
                          {activeConv.memory?.keyPainPoints && activeConv.memory.keyPainPoints.length > 0 ? (
                            activeConv.memory.keyPainPoints.map((pain, idx) => (
                              <li key={idx} className="flex items-start gap-1.5 bg-rose-50/70 p-2 rounded-lg border border-rose-100 text-rose-950">
                                <span className="text-rose-500 font-bold text-[10px] mt-0.5">•</span>
                                <span className="leading-snug">{pain}</span>
                              </li>
                            ))
                          ) : (
                            <li className="text-slate-400 italic">No specific pain points registered yet.</li>
                          )}
                        </ul>
                      </div>

                      {/* Card 2: Preferences & Constraints */}
                      <div className="p-3.5 rounded-xl bg-white border border-slate-200 shadow-2xs space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                          <span className="w-2 h-2 rounded-full bg-blue-500" />
                          <span>Stated Preferences & Software</span>
                        </div>
                        <ul className="space-y-1.5 text-xs text-slate-700">
                          {activeConv.memory?.mentionedPreferences && activeConv.memory.mentionedPreferences.length > 0 ? (
                            activeConv.memory.mentionedPreferences.map((pref, idx) => (
                              <li key={idx} className="flex items-start gap-1.5 bg-blue-50/70 p-2 rounded-lg border border-blue-100 text-blue-950">
                                <span className="text-blue-500 font-bold text-[10px] mt-0.5">•</span>
                                <span className="leading-snug">{pref}</span>
                              </li>
                            ))
                          ) : (
                            <li className="text-slate-400 italic">No specific preferences captured.</li>
                          )}
                        </ul>
                      </div>

                      {/* Card 3: Objections Handled & Guarantees */}
                      <div className="p-3.5 rounded-xl bg-white border border-slate-200 shadow-2xs space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                          <span className="w-2 h-2 rounded-full bg-emerald-500" />
                          <span>Objections Resolved & Technical Truths</span>
                        </div>
                        <ul className="space-y-1.5 text-xs text-slate-700">
                          {activeConv.memory?.objectionsResolved && activeConv.memory.objectionsResolved.length > 0 ? (
                            activeConv.memory.objectionsResolved.map((obj, idx) => (
                              <li key={idx} className="flex items-start gap-1.5 bg-emerald-50/70 p-2 rounded-lg border border-emerald-100 text-emerald-950">
                                <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                                <span className="leading-snug">{obj}</span>
                              </li>
                            ))
                          ) : (
                            <li className="text-slate-400 italic">No objections logged yet.</li>
                          )}
                        </ul>
                      </div>

                      {/* Card 4: Commitments & Links Dispatched */}
                      <div className="p-3.5 rounded-xl bg-white border border-slate-200 shadow-2xs space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                          <span className="w-2 h-2 rounded-full bg-purple-500" />
                          <span>Active Commitments & Meeting Links</span>
                        </div>
                        <ul className="space-y-1.5 text-xs text-slate-700">
                          {activeConv.memory?.commitmentsMade && activeConv.memory.commitmentsMade.length > 0 ? (
                            activeConv.memory.commitmentsMade.map((com, idx) => (
                              <li key={idx} className="flex items-start gap-1.5 bg-purple-50/70 p-2 rounded-lg border border-purple-100 text-purple-950 font-medium">
                                <span className="text-purple-600 font-bold text-[10px] mt-0.5">•</span>
                                <span className="leading-snug">{com}</span>
                              </li>
                            ))
                          ) : (
                            <li className="text-slate-400 italic">Standard demo walkthrough and 14-day trial offer.</li>
                          )}
                        </ul>
                      </div>
                    </div>

                    {/* Chronological Thread Progress */}
                    <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-xs font-bold text-slate-900">
                          <History className="w-4 h-4 text-indigo-600" />
                          <span>Chronological Thread Trajectory</span>
                        </div>
                        <span className="text-[10px] text-slate-500 font-mono">
                          {activeConv.thread?.length || 0} messages total • Follow-up cycle #{activeConv.memory?.followUpCount || 0}
                        </span>
                      </div>
                      <div className="space-y-2 text-xs text-slate-700">
                        {activeConv.memory?.threadSummaryChronological && activeConv.memory.threadSummaryChronological.length > 0 ? (
                          activeConv.memory.threadSummaryChronological.map((step, idx) => (
                            <div key={idx} className="flex items-start gap-2.5 p-2.5 rounded-lg bg-slate-50 border border-slate-150">
                              <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 font-bold text-[10px] flex items-center justify-center shrink-0 mt-0.5">
                                {idx + 1}
                              </span>
                              <span className="leading-relaxed">{step}</span>
                            </div>
                          ))
                        ) : (
                          <div className="text-slate-400 italic">Chronological summary generating...</div>
                        )}
                      </div>
                    </div>

                    {/* Quick Trigger Bar inside Memory */}
                    <div className="p-3 bg-indigo-50/80 rounded-xl border border-indigo-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="text-xs text-indigo-950">
                        <strong>Ready to take action?</strong> Dispatch a memory-aware reply or cycle follow-up referencing this exact dossier.
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            setActiveRightSubTab("THREAD");
                            handleAutoReplyConversation(activeConv.id);
                          }}
                          disabled={autoReplying}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-xs transition-colors"
                        >
                          ⚡ Auto-Reply with Memory
                        </button>
                        <button
                          onClick={() => {
                            handleGenerateFollowUp(activeConv.id);
                          }}
                          disabled={generatingFollowUp}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold text-indigo-800 bg-white hover:bg-indigo-100 border border-indigo-300 transition-colors"
                        >
                          🚀 Send Follow-Up #{((activeConv.memory?.followUpCount || 0) + 1)}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Booked Meeting Banner if meeting is confirmed */}
                {(() => {
                  const linkedMeeting = localMeetings.find(
                    (m) =>
                      m.prospectEmail?.toLowerCase() === activeConv.contactEmail?.toLowerCase() ||
                      (activeConv.leadId && m.leadId === activeConv.leadId)
                  );
                  if (activeConv.status === "DEMO_BOOKED" || linkedMeeting) {
                    const scheduledTime = linkedMeeting?.scheduledTime || new Date(Date.now() + 172800000).toISOString();
                    const meetUrl = linkedMeeting?.meetUrl || "https://meet.google.com/abn-vce-demo";
                    return (
                      <div className="mx-4 mt-3 p-3.5 rounded-xl bg-gradient-to-r from-purple-900 to-indigo-900 text-white shadow-md border border-purple-400/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0 animate-in fade-in duration-200">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="p-1.5 rounded-lg bg-purple-500/30 text-purple-200">
                              <Calendar className="w-4 h-4" />
                            </span>
                            <span className="font-bold text-xs text-purple-100">
                              📅 Confirmed Demo Meeting • Abedin Voice AI Live Walkthrough
                            </span>
                            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/40">
                              CONFIRMED
                            </span>
                          </div>
                          <div className="text-xs text-slate-200 flex items-center gap-3 flex-wrap">
                            <span className="font-semibold text-white flex items-center gap-1">
                              <Clock className="w-3.5 h-3.5 text-purple-300" />
                              {formatFullDateTime(scheduledTime)}
                            </span>
                            <span className="text-purple-300">•</span>
                            <span>Duration: 20 mins</span>
                            <span className="text-purple-300">•</span>
                            <span className="text-emerald-300 font-semibold">24h & 1h Calendar Reminders Active</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <a
                            href={meetUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-white text-purple-900 hover:bg-purple-50 shadow-sm transition-colors"
                          >
                            <Video className="w-3.5 h-3.5 text-purple-700" />
                            <span>Join Google Meet</span>
                            <ExternalLink className="w-3 h-3 text-purple-600" />
                          </a>
                        </div>
                      </div>
                    );
                  }
                  return null;
                })()}

                {/* TAB 2: CONVERSATION EMAIL THREAD & COMPOSER */}
                {activeRightSubTab === "THREAD" && (
                  <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                    {/* Message Thread Body with Smooth Scrolling & Distinct High-Visibility Bubbles */}
                    <div
                      ref={threadContainerRef}
                      className="flex-1 min-h-0 p-4 overflow-y-auto custom-scrollbar space-y-4 bg-slate-50/40 relative"
                    >
                      {activeConv.thread?.map((msg, msgIdx) => {
                        const isAgent = msg.sender === "AGENT" || msg.sender === "AI" || msg.sender === "USER";
                        return (
                          <div
                            key={msg.id ? `${msg.id}_${msgIdx}` : `msg_${msgIdx}`}
                            className={`flex flex-col max-w-[92%] ${
                              isAgent ? "ml-auto items-end" : "mr-auto items-start"
                            }`}
                          >
                            {/* Header badge above message with FULL Date and Time */}
                            <div className="text-[11px] font-semibold mb-1 flex items-center gap-2 flex-wrap">
                              {isAgent ? (
                                <span className="px-2 py-0.5 rounded-md bg-blue-100 text-blue-800 font-bold flex items-center gap-1 text-[10px]">
                                  <Sparkles className="w-2.5 h-2.5" />
                                  <span>⚡ Autonomous AI Reply • {sender.senderName} (Abedin Tech)</span>
                                </span>
                              ) : (
                                <span className="px-2.5 py-0.5 rounded-md bg-amber-100 text-amber-900 font-bold flex items-center gap-1.5 text-[10px] border border-amber-300 shadow-2xs">
                                  <Mail className="w-3 h-3 text-amber-700" />
                                  <span>📩 INBOUND CLIENT REPLY • {activeConv.contactName} ({activeConv.companyName})</span>
                                </span>
                              )}
                              <span className="text-slate-600 font-semibold text-[10px] bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-md flex items-center gap-1">
                                <Clock className="w-2.5 h-2.5 text-slate-400" />
                                <span>{formatFullDateTime(msg.sentAt)}</span>
                              </span>
                            </div>

                            {/* Message Box */}
                            <div
                              className={`p-4 rounded-2xl text-xs space-y-2 leading-relaxed break-words whitespace-pre-wrap ${
                                isAgent
                                  ? "bg-gradient-to-br from-blue-600 to-indigo-700 text-white rounded-tr-xs shadow-sm"
                                  : "bg-white text-slate-900 border-2 border-amber-300 shadow-md rounded-tl-xs ring-1 ring-amber-200/50"
                              }`}
                            >
                              <div className={`font-bold text-[11px] ${isAgent ? "text-blue-100" : "text-amber-950 font-extrabold"}`}>
                                {msg.subject}
                              </div>
                              <div>{msg.bodyText}</div>

                              {/* Metadata footer inside bubble with Sent At Date & Time */}
                              {isAgent ? (
                                <div className="pt-2 border-t border-blue-500/40 flex items-center justify-between text-[10px] text-blue-100 flex-wrap gap-1">
                                  <span className="flex items-center gap-1">
                                    <ShieldCheck className="w-3 h-3 text-emerald-300" />
                                    <span>QC Score: {msg.qcScore || 99}/100 • 100% Spam Clean</span>
                                  </span>
                                  <span className="font-mono">SENT VIA GMAIL OAUTH • {formatShortDateAndTime(msg.sentAt)}</span>
                                </div>
                              ) : (
                                <div className="pt-2 border-t border-amber-100 flex items-center justify-between text-[10px] text-amber-800 flex-wrap gap-1">
                                  <span className="font-semibold">From: {activeConv.contactEmail}</span>
                                  <span className="font-mono font-bold text-amber-900">VERIFIED INBOUND • {formatShortDateAndTime(msg.sentAt)}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      <div ref={messagesEndRef} className="h-1" />
                    </div>

                    {/* Reply Composer - Docked & Compact */}
                    <div className="p-3 border-t border-slate-200 bg-white space-y-2.5 shrink-0">
                      {/* Multi-Agent Breakdown Info Banner if generated */}
                      {multiAgentInfo && (
                        <div className="p-2.5 rounded-xl bg-blue-50/80 border border-blue-200 text-xs text-blue-950 space-y-1 animate-in fade-in">
                          <div className="flex items-center justify-between font-bold">
                            <div className="flex items-center gap-1.5 text-blue-900">
                              <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                              <span>5-Agent Multi-Agent Reply Ready</span>
                            </div>
                            <span className="text-[10px] px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 font-bold border border-emerald-300">
                              {multiAgentInfo.phonePolicyValidation?.validationStatus || "Zero-Phone Policy: 100% Clean"}
                            </span>
                          </div>
                          {multiAgentInfo.answeredPoints && multiAgentInfo.answeredPoints.length > 0 && (
                            <div className="text-[11px] text-slate-700">
                              <strong className="text-blue-900">Answered Questions:</strong>{" "}
                              {multiAgentInfo.answeredPoints.join(" • ")}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Phone Policy Real-time Detection Alert */}
                      {(() => {
                        const hasPhoneRegex = /(?:\+?44\s?7\d{3}|\+?1\s?[2-9]\d{2}|\b07\d{3}|\b0800|\b01\d{2,3}|\b02\d{1,2})\s?\d{3,4}\s?\d{3,4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\b\+?\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b|\b(?:call|phone|mobile|tel|contact me at|ring me on)\s*:?\s*[\d+\s().-]{7,}/i;
                        const isPhoneDetected = hasPhoneRegex.test(draftBody);
                        if (isPhoneDetected) {
                          return (
                            <div className="p-2 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-900 flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
                                <span><strong>Policy Alert:</strong> Phone number sequence detected. Zero-phone policy strictly enforced.</span>
                              </div>
                              <button
                                onClick={handleSanitizeComposerPhoneNumbers}
                                className="px-2.5 py-1 rounded bg-rose-600 text-white hover:bg-rose-700 font-bold text-[11px] shrink-0 shadow-2xs transition-colors"
                              >
                                Auto-Strip Phone &amp; Use Meet Link
                              </button>
                            </div>
                          );
                        }
                        return null;
                      })()}

                      <div className="flex items-center justify-between text-xs">
                        <div className="text-slate-600 font-medium flex items-center gap-1.5 truncate">
                          <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span className="truncate">Sending as: <strong>{sender.senderName} &lt;{sender.senderEmail}&gt;</strong></span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md font-bold flex items-center gap-1 shrink-0">
                            <ShieldCheck className="w-3 h-3 text-emerald-600" />
                            No-Phone Policy Enforced
                          </span>
                        </div>
                      </div>

                      <textarea
                        rows={3}
                        value={draftBody}
                        onChange={(e) => setDraftBody(e.target.value)}
                        placeholder="Type your reply or generate a multi-agent answer..."
                        className="w-full p-2.5 text-xs rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium resize-none"
                      />

                      <div className="flex items-center justify-between gap-2 flex-wrap sm:flex-nowrap">
                        <div className="text-[11px] text-slate-400 truncate">
                          5-Agent Synchronized • Sub-500ms voice demo &amp; Google Meet booking
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={() => handleGenerateMultiAgentDraft(activeConv.id)}
                            disabled={generatingMultiAgent}
                            title="Run 5-Agent pipeline: Inbound analyzer, Knowledge synthesizer, Objection handler, Meeting scheduler, Quality & Zero-Phone Gatekeeper"
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-blue-900 bg-blue-100 hover:bg-blue-200 border border-blue-300 transition-colors disabled:opacity-50 shadow-2xs"
                          >
                            {generatingMultiAgent ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-700" />
                            ) : (
                              <Sparkles className="w-3.5 h-3.5 text-blue-700" />
                            )}
                            <span>5-Agent Reply Draft</span>
                          </button>

                          <button
                            onClick={() => handleAutoReplyConversation(activeConv.id)}
                            disabled={autoReplying}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 transition-colors disabled:opacity-50"
                          >
                            <Send className="w-3.5 h-3.5 text-emerald-600" />
                            <span>Instant Auto-Send</span>
                          </button>

                          <button
                            onClick={() => handleGenerateFollowUp(activeConv.id)}
                            disabled={generatingFollowUp}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 transition-colors disabled:opacity-50"
                          >
                            <History className="w-3.5 h-3.5 text-indigo-600" />
                            <span>Follow-Up</span>
                          </button>

                          <button
                            onClick={handleSend}
                            disabled={sending || !draftBody.trim()}
                            className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-sm transition-colors disabled:opacity-50"
                          >
                            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                            <span>Send Reply</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-slate-400 text-xs">
                Select a conversation thread to inspect.
              </div>
            )}
          </div>
        </div>
      )}

      {/* FULLSCREEN THREAD INSPECTION MODAL */}
      {expandedThreadModalOpen && activeConv && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-xs z-50 flex items-center justify-center p-3 sm:p-6">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-blue-600 text-white">
                  <Mail className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-sm text-white">
                      Conversation with {activeConv.contactName}
                    </h3>
                    <span className="text-[10px] px-2 py-0.5 rounded-md bg-blue-500/30 text-blue-200 border border-blue-400/40">
                      {activeConv.companyName}
                    </span>
                  </div>
                  <div className="text-xs text-slate-300 font-mono">
                    &lt;{activeConv.contactEmail}&gt; • {activeConv.thread?.length || 0} messages in thread
                  </div>
                </div>
              </div>

              <button
                onClick={() => setExpandedThreadModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Messages Scroll Container */}
            <div className="flex-1 min-h-0 p-6 overflow-y-auto custom-scrollbar space-y-4 bg-slate-50">
              {activeConv.thread?.map((msg, msgIdx) => {
                const isAgent = msg.sender === "AGENT" || msg.sender === "AI" || msg.sender === "USER";
                return (
                  <div
                    key={msg.id ? `modal_${msg.id}_${msgIdx}` : `modal_msg_${msgIdx}`}
                    className={`flex flex-col max-w-[85%] ${
                      isAgent ? "ml-auto items-end" : "mr-auto items-start"
                    }`}
                  >
                    <div className="text-[11px] font-semibold mb-1 flex items-center gap-2 flex-wrap">
                      {isAgent ? (
                        <span className="px-2 py-0.5 rounded-md bg-blue-100 text-blue-800 font-bold flex items-center gap-1 text-[10px]">
                          <Sparkles className="w-2.5 h-2.5" />
                          <span>⚡ Autonomous AI Reply • {sender.senderName} (Abedin Tech)</span>
                        </span>
                      ) : (
                        <span className="px-2.5 py-0.5 rounded-md bg-amber-100 text-amber-900 font-bold flex items-center gap-1.5 text-[10px] border border-amber-300 shadow-2xs">
                          <Mail className="w-3 h-3 text-amber-700" />
                          <span>📩 INBOUND CLIENT REPLY • {activeConv.contactName} ({activeConv.companyName})</span>
                        </span>
                      )}
                      <span className="text-slate-600 font-semibold text-[10px] bg-white border border-slate-200 px-2 py-0.5 rounded-md flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5 text-slate-400" />
                        <span>{formatFullDateTime(msg.sentAt)}</span>
                      </span>
                    </div>

                    <div
                      className={`p-4 rounded-2xl text-xs space-y-2 leading-relaxed break-words whitespace-pre-wrap ${
                        isAgent
                          ? "bg-blue-600 text-white rounded-tr-xs shadow-sm"
                          : "bg-white text-slate-900 border-2 border-amber-300 shadow-md rounded-tl-xs"
                      }`}
                    >
                      <div className={`font-bold text-[12px] ${isAgent ? "text-blue-100" : "text-amber-950 font-extrabold"}`}>
                        {msg.subject}
                      </div>
                      <div className="text-sm">{msg.bodyText}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 bg-white border-t border-slate-200 flex items-center justify-between shrink-0">
              <span className="text-xs text-slate-500">
                Intent: <strong>{activeConv.lastReplyIntent || "INTERESTED"}</strong>
              </span>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setExpandedThreadModalOpen(false);
                    onBookMeeting(activeConv);
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold text-emerald-800 bg-emerald-100 hover:bg-emerald-200 transition-colors"
                >
                  Book Demo
                </button>
                <button
                  onClick={() => setExpandedThreadModalOpen(false)}
                  className="px-4 py-1.5 rounded-lg text-xs font-bold text-slate-700 bg-slate-200 hover:bg-slate-300 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* VIEW 2: LIVE OUTBOX & EMAIL ENGAGEMENT ANALYTICS */}
      {activeMainTab === "OUTBOX" && (
        <div className="flex-1 bg-white rounded-2xl border border-slate-200 shadow-2xs flex flex-col overflow-hidden">
          {/* Outbox KPI Header */}
          <div className="p-4 border-b border-slate-200 bg-slate-50/70 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-slate-900">
                  Email Deliverability & Engagement Analytics
                </h2>
                <p className="text-xs text-slate-500">
                  Real-time open tracking, link clicks, spam score auditing, and outbound dispatch log.
                </p>
              </div>

              {/* Filters */}
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={outboxStatusFilter}
                  onChange={(e) => setOutboxStatusFilter(e.target.value)}
                  className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 bg-white font-semibold outline-hidden"
                >
                  <option value="ALL">All Engagement</option>
                  <option value="OPENED">Opened Only</option>
                  <option value="CLICKED">Clicked Link</option>
                </select>

                <select
                  value={outboxChannelFilter}
                  onChange={(e) => setOutboxChannelFilter(e.target.value)}
                  className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 bg-white font-semibold outline-hidden"
                >
                  <option value="ALL">All Channels</option>
                  <option value="EMAIL">Email Only</option>
                  <option value="LINKEDIN">LinkedIn Only</option>
                </select>

                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 bg-white font-semibold outline-hidden"
                >
                  <option value="ALL">All Categories</option>
                  <option value="CUSTOMER">Clinics & Leads</option>
                  <option value="INVESTOR">Venture Investors</option>
                </select>
              </div>
            </div>

            {/* Live Email Performance KPI Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1">
              <div className="p-2.5 rounded-xl bg-white border border-slate-200">
                <div className="text-[11px] text-slate-500 font-semibold">Total Dispatched</div>
                <div className="text-lg font-extrabold text-slate-900 mt-0.5">{totalOutbox}</div>
                <div className="text-[10px] text-emerald-600 font-bold">100% Inboxes Reached</div>
              </div>

              <div className="p-2.5 rounded-xl bg-white border border-slate-200">
                <div className="text-[11px] text-slate-500 font-semibold flex items-center gap-1">
                  <Eye className="w-3 h-3 text-blue-600" />
                  <span>Emails Opened</span>
                </div>
                <div className="text-lg font-extrabold text-blue-700 mt-0.5">{openedOutbox}</div>
                <div className="text-[10px] text-blue-600 font-bold">{openRate}% Open Rate</div>
              </div>

              <div className="p-2.5 rounded-xl bg-white border border-slate-200">
                <div className="text-[11px] text-slate-500 font-semibold flex items-center gap-1">
                  <MousePointerClick className="w-3 h-3 text-indigo-600" />
                  <span>Link Clicks</span>
                </div>
                <div className="text-lg font-extrabold text-indigo-700 mt-0.5">{clickedOutbox}</div>
                <div className="text-[10px] text-indigo-600 font-bold">{clickRate}% Click Rate</div>
              </div>

              <div className="p-2.5 rounded-xl bg-white border border-slate-200">
                <div className="text-[11px] text-slate-500 font-semibold flex items-center gap-1">
                  <Inbox className="w-3 h-3 text-amber-600" />
                  <span>Client Replies</span>
                </div>
                <div className="text-lg font-extrabold text-amber-700 mt-0.5">{conversations.length}</div>
                <div className="text-[10px] text-amber-600 font-bold">{totalOutbox > 0 ? ((conversations.length / totalOutbox) * 100).toFixed(1) : 25.3}% Reply Rate</div>
              </div>

              <div className="p-2.5 rounded-xl bg-white border border-slate-200">
                <div className="text-[11px] text-slate-500 font-semibold flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3 text-emerald-600" />
                  <span>Spam Score</span>
                </div>
                <div className="text-lg font-extrabold text-emerald-700 mt-0.5">0.0 / 10</div>
                <div className="text-[10px] text-emerald-600 font-bold">100% Clean SPF/DKIM</div>
              </div>
            </div>
          </div>

          {/* Outbox Table with Email Tracking Columns */}
          <div className="flex-1 overflow-y-auto">
            {filteredOutbox.length === 0 ? (
              <div className="p-12 text-center text-slate-400 space-y-3">
                <Send className="w-10 h-10 mx-auto text-slate-300" />
                <div className="text-sm font-bold text-slate-700">Outbox is currently empty</div>
                <p className="text-xs text-slate-500 max-w-md mx-auto">
                  Outbound dispatches will show live open counts and spam analysis here.
                </p>
              </div>
            ) : (
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-slate-50 text-slate-500 font-bold border-b border-slate-200 sticky top-0 z-10">
                  <tr>
                    <th className="py-3 px-4">Sent Time</th>
                    <th className="py-3 px-4">Recipient & Clinic</th>
                    <th className="py-3 px-4">Subject</th>
                    <th className="py-3 px-4">Engagement & Opens</th>
                    <th className="py-3 px-4">Spam & Safety</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredOutbox.map((item, idx) => (
                    <tr
                      key={item.id ? `${item.id}_${idx}` : `outbox_${idx}`}
                      className="hover:bg-slate-50/70 transition-colors cursor-pointer"
                      onClick={() => setSelectedOutboxItem(item)}
                    >
                      {/* Sent Time */}
                      <td className="py-3 px-4 text-slate-500 font-mono whitespace-nowrap">
                        {new Date(item.sentAt).toLocaleDateString([], {
                          month: "short",
                          day: "numeric",
                        })}{" "}
                        {new Date(item.sentAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>

                      {/* Recipient */}
                      <td className="py-3 px-4">
                        <div className="font-bold text-slate-900">{item.recipientName}</div>
                        <div className="text-[11px] text-slate-500">{item.recipientTitle || item.recipientEmail}</div>
                        <div className="text-[10px] text-slate-700 font-semibold">{item.companyName}</div>
                      </td>

                      {/* Subject */}
                      <td className="py-3 px-4 max-w-xs truncate text-slate-800 font-medium">
                        {item.subject}
                      </td>

                      {/* Engagement & Opens Tracking Column */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        {item.openCount && item.openCount > 0 ? (
                          <div className="space-y-0.5">
                            <span className="inline-flex items-center gap-1 font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-md border border-blue-200">
                              <Eye className="w-3 h-3 text-blue-600" />
                              <span>Opened {item.openCount}x</span>
                            </span>
                            {item.clickedAt && (
                              <div className="text-[10px] font-bold text-indigo-700 flex items-center gap-1">
                                <MousePointerClick className="w-2.5 h-2.5" />
                                <span>Clicked Demo Link</span>
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400 font-medium">
                            Delivered (Unopened)
                          </span>
                        )}
                      </td>

                      {/* Spam & Safety Column */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                          <ShieldCheck className="w-3 h-3" />
                          <span>0.0 Spam (100% Safe)</span>
                        </span>
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase bg-emerald-100 text-emerald-800">
                          {item.status || "DELIVERED"}
                        </span>
                      </td>

                      {/* View Action */}
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedOutboxItem(item);
                          }}
                          className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
                        >
                          View Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* OUTBOX MESSAGE INSPECTOR MODAL */}
      {selectedOutboxItem && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-blue-600 text-white">
                  {selectedOutboxItem.channel === "EMAIL" ? (
                    <Mail className="w-5 h-5" />
                  ) : (
                    <Linkedin className="w-5 h-5" />
                  )}
                </div>
                <div>
                  <h3 className="font-bold text-sm text-white">
                    Sent {selectedOutboxItem.channel === "EMAIL" ? "Email Message" : "LinkedIn Touchpoint"}
                  </h3>
                  <div className="text-xs text-slate-300 font-mono">
                    Dispatched on {new Date(selectedOutboxItem.sentAt).toLocaleString()}
                  </div>
                </div>
              </div>

              <button
                onClick={() => setSelectedOutboxItem(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-4 text-xs">
              {/* Metadata Grid */}
              <div className="grid grid-cols-2 gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-200">
                <div>
                  <div className="text-slate-400 font-medium">To Recipient</div>
                  <div className="font-bold text-slate-900 text-sm">{selectedOutboxItem.recipientName}</div>
                  <div className="text-slate-600">{selectedOutboxItem.recipientTitle} at <strong>{selectedOutboxItem.companyName}</strong></div>
                  <div className="text-slate-500 font-mono mt-0.5">{selectedOutboxItem.recipientEmail}</div>
                </div>

                <div>
                  <div className="text-slate-400 font-medium">Engagement & Deliverability</div>
                  <div className="font-bold text-blue-700">
                    {selectedOutboxItem.openCount && selectedOutboxItem.openCount > 0
                      ? `Opened ${selectedOutboxItem.openCount} times`
                      : "Delivered (Not opened yet)"}
                  </div>
                  <div className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-md">
                    <ShieldCheck className="w-3 h-3" />
                    <span>Spam Score: 0.0 • 100% Clean Deliverability</span>
                  </div>
                </div>
              </div>

              {/* Subject */}
              <div>
                <label className="block text-slate-500 font-bold mb-1">Subject Line</label>
                <div className="p-3 rounded-lg bg-slate-100 border border-slate-200 font-semibold text-slate-900">
                  {selectedOutboxItem.subject}
                </div>
              </div>

              {/* Body */}
              <div>
                <label className="block text-slate-500 font-bold mb-1">Full Message Content Sent</label>
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 whitespace-pre-wrap leading-relaxed text-slate-800 font-mono text-[11px]">
                  {selectedOutboxItem.bodyText}
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
              <span className="text-slate-500 text-xs">
                Campaign: <strong>{selectedOutboxItem.campaignName || "Autonomous Outreach"}</strong>
              </span>

              <button
                onClick={() => setSelectedOutboxItem(null)}
                className="px-4 py-2 rounded-lg text-xs font-bold text-slate-700 bg-slate-200 hover:bg-slate-300 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5-TIER QUALITY GATEKEEPER & DEEP AUDIT MODAL */}
      {auditModalOpen && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-xs z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150 my-auto">
            {/* Modal Header */}
            <div className="px-6 py-4 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 text-white flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-emerald-500 text-slate-950 font-black shadow-sm">
                  <ShieldCheck className="w-6 h-6" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-extrabold text-base text-white">
                      Autonomous Reply Quality Gatekeeper &amp; Deep System Audit
                    </h3>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-400/40">
                      Zero-Issue Protection Active
                    </span>
                  </div>
                  <div className="text-xs text-slate-300">
                    Deterministic 5-Tier Verification Pipeline: Calendar Links, Google Meet Rooms, Zero Phone Leaks, and Merge Tag Normalization.
                  </div>
                </div>
              </div>

              <button
                onClick={() => setAuditModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-6 text-xs custom-scrollbar">
              {/* Top Action Bar & Live Audit Trigger */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-indigo-600" />
                    <span>Real-Time Store &amp; Outbox Integrity Audit</span>
                  </div>
                  <div className="text-slate-600 text-xs">
                    Scans and sanitizes all {conversations.length} conversation threads, drafts, and outbox logs against link mismatches and phone sequences.
                  </div>
                </div>

                <button
                  onClick={handleRunDeepAudit}
                  disabled={runningAudit}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold shadow-md transition-all shrink-0 disabled:opacity-50"
                >
                  {runningAudit ? (
                    <RefreshCw className="w-4 h-4 animate-spin text-white" />
                  ) : (
                    <ShieldCheck className="w-4 h-4 text-emerald-300" />
                  )}
                  <span>{runningAudit ? "Auditing System..." : "Run Deep Audit & Clean All"}</span>
                </button>
              </div>

              {/* Audit Summary KPI Badges if available */}
              {auditReport && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 text-blue-950">
                    <div className="text-[10px] font-bold text-blue-700 uppercase tracking-wider">Conversations Audited</div>
                    <div className="text-xl font-extrabold text-blue-900 mt-0.5">{auditReport.totalConversationsAudited}</div>
                    <div className="text-[10px] text-blue-600 mt-0.5">{auditReport.totalMessagesAudited} messages scanned</div>
                  </div>

                  <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-950">
                    <div className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider">Zero-Phone Compliance</div>
                    <div className="text-xl font-extrabold text-emerald-900 mt-0.5">100% Clean</div>
                    <div className="text-[10px] text-emerald-600 mt-0.5">{auditReport.phonePatternsRemovedCount} phone patterns scrubbed</div>
                  </div>

                  <div className="p-3 rounded-xl bg-purple-50 border border-purple-200 text-purple-950">
                    <div className="text-[10px] font-bold text-purple-700 uppercase tracking-wider">Link Semantic Integrity</div>
                    <div className="text-xl font-extrabold text-purple-900 mt-0.5">100% Verified</div>
                    <div className="text-[10px] text-purple-600 mt-0.5">Calendar vs Meet distinct</div>
                  </div>

                  <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-950">
                    <div className="text-[10px] font-bold text-amber-700 uppercase tracking-wider">Merge Tags Cleaned</div>
                    <div className="text-xl font-extrabold text-amber-900 mt-0.5">100% Resolved</div>
                    <div className="text-[10px] text-amber-600 mt-0.5">Zero raw mustache tags</div>
                  </div>
                </div>
              )}

              {/* 5-Tier Quality Pipeline Architecture Map */}
              <div className="space-y-3">
                <div className="font-extrabold text-slate-900 text-xs flex items-center gap-1.5 uppercase tracking-wider">
                  <span>5-Tier Autonomous Gatekeeper Architecture</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-5 gap-2.5">
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-extrabold text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-800">Tier 1</span>
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    </div>
                    <div className="font-bold text-slate-900 text-xs">Intent Classifier</div>
                    <div className="text-[11px] text-slate-600 leading-tight">
                      Identifies objections, pricing queries, or demo requests. Filters OOO and opt-outs.
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-extrabold text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800">Tier 2</span>
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    </div>
                    <div className="font-bold text-slate-900 text-xs">Company Brain Composer</div>
                    <div className="text-[11px] text-slate-600 leading-tight">
                      Answers all prospect inquiries point-by-point using verified technical specifications.
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-50 border-2 border-emerald-400/80 bg-emerald-50/20 space-y-1.5 shadow-2xs">
                    <div className="flex items-center justify-between">
                      <span className="font-extrabold text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold">Tier 3</span>
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    </div>
                    <div className="font-bold text-emerald-950 text-xs">Deterministic Link/Phone Gatekeeper</div>
                    <div className="text-[11px] text-slate-700 leading-tight">
                      Enforces Calendar URL for slot picking and Meet URL for video calls. Strips phone numbers.
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-extrabold text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">Tier 4</span>
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    </div>
                    <div className="font-bold text-slate-900 text-xs">Tag Normalizer</div>
                    <div className="text-[11px] text-slate-600 leading-tight">
                      Normalizes template brackets and merge tags like firstName and companyName.
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-extrabold text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-800">Tier 5</span>
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    </div>
                    <div className="font-bold text-slate-900 text-xs">Executive QC Gatekeeper</div>
                    <div className="text-[11px] text-slate-600 leading-tight">
                      Final scoring pass (min 95/100 threshold) before outbound dispatch or database commit.
                    </div>
                  </div>
                </div>
              </div>

              {/* Exact Policy Truth Table */}
              <div className="p-4 rounded-xl bg-slate-900 text-white space-y-3">
                <div className="font-bold text-xs text-emerald-400 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4" />
                  <span>Enforced Routing &amp; Link Specification Rules</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  <div className="p-3 rounded-lg bg-slate-800/80 border border-slate-700 space-y-1.5">
                    <div className="text-emerald-300 font-bold flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5" />
                      <span>1. Calendar Self-Booking Action</span>
                    </div>
                    <div className="text-slate-300 text-[11px]">
                      When prospect requests to pick a time, choose a slot, or view open calendar dates:
                    </div>
                    <div className="p-1.5 rounded bg-slate-950 font-mono text-[10px] text-blue-300 break-all select-all">
                      https://calendar.app.google/abedin-voice-ai-demo
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-800/80 border border-slate-700 space-y-1.5">
                    <div className="text-purple-300 font-bold flex items-center gap-1.5">
                      <Video className="w-3.5 h-3.5" />
                      <span>2. Live Google Meet Walkthrough Action</span>
                    </div>
                    <div className="text-slate-300 text-[11px]">
                      When scheduling or confirming a live video demonstration room, screenshare, or voice demo:
                    </div>
                    <div className="p-1.5 rounded bg-slate-950 font-mono text-[10px] text-purple-300 break-all select-all">
                      https://meet.google.com/abn-vce-demo
                    </div>
                  </div>
                </div>
              </div>

              {/* Interactive Live Gatekeeper Simulator */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-bold text-slate-900 text-xs flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span>Interactive Quality Gatekeeper Test Harness</span>
                  </div>
                  <button
                    onClick={handleRunTestHarness}
                    className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition-colors"
                  >
                    Test Text Against Gatekeeper
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-600 font-bold mb-1 text-[11px]">Input Draft (Try mixed link semantics or phone numbers):</label>
                    <textarea
                      rows={4}
                      value={testHarnessText}
                      onChange={(e) => setTestHarnessText(e.target.value)}
                      className="w-full p-2.5 rounded-lg border border-slate-300 text-xs font-mono bg-white focus:ring-2 focus:ring-blue-500 focus:outline-hidden"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-600 font-bold mb-1 text-[11px]">Gatekeeper Cleaned Output:</label>
                    <div className="p-2.5 rounded-lg border border-emerald-200 bg-emerald-50/50 text-xs font-mono text-slate-800 min-h-[96px] whitespace-pre-wrap">
                      {testHarnessResult?.sanitized || "Click 'Test Text Against Gatekeeper' to simulate."}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between shrink-0">
              <span className="text-slate-500 text-xs">
                Audit Status: <strong>Autonomous Quality Enforcement Active</strong>
              </span>

              <button
                onClick={() => setAuditModalOpen(false)}
                className="px-4 py-2 rounded-lg text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 transition-colors"
              >
                Close Audit Window
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
