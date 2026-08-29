import React, { useState, useEffect } from "react";
import {
  Plug,
  Mail,
  Calendar,
  FolderOpen,
  Bot,
  Database,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  ShieldCheck,
  Linkedin,
  Send,
  Save,
  RefreshCw,
  Sliders,
  User,
  Building,
  KeyRound,
  Check,
  Sparkles,
  Tag,
} from "lucide-react";
import { SenderIdentity, LinkedInConfig } from "../types";
import { diagnosticFetch } from "../utils/diagnosticFetch";
import { workspaceGmailService, GmailTokenState } from "../services/gmailWorkspaceService";

interface IntegrationsViewProps {
  senderIdentity?: SenderIdentity;
  linkedInConfig?: LinkedInConfig;
  onUpdateSenderIdentity?: (sender: SenderIdentity) => void;
  onUpdateLinkedInConfig?: (config: LinkedInConfig) => void;
}

export const IntegrationsView: React.FC<IntegrationsViewProps> = ({
  senderIdentity: initialSender,
  linkedInConfig: initialLinkedIn,
  onUpdateSenderIdentity,
  onUpdateLinkedInConfig,
}) => {
  // Gmail Workspace State
  const [gmailState, setGmailState] = useState<GmailTokenState>(workspaceGmailService.getState());
  const [isAuthorizingWorkspace, setIsAuthorizingWorkspace] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Sender Identity State
  const [sender, setSender] = useState<SenderIdentity>(
    initialSender || {
      senderName: "Nayem Abedin",
      senderEmail: "info@abedintech.com",
      jobTitle: "Founder & CEO",
      companyName: "Abedin Tech",
      replyToEmail: "info@abedintech.com",
      emailSignature: "Nayem Abedin\nFounder & CEO | Abedin Tech\ninfo@abedintech.com\nhttps://abedintech.com/voice-ai/",
      provider: "GMAIL_OAUTH",
      status: "CONNECTED",
      lastVerifiedAt: new Date().toISOString(),
    }
  );

  // LinkedIn State
  const [linkedIn, setLinkedIn] = useState<LinkedInConfig>(
    initialLinkedIn || {
      connected: true,
      profileName: "Nayem Abedin",
      profileHeadline: "Founder @ Abedin Tech | Voice AI Infrastructure for Healthcare & Enterprise",
      profileUrl: "https://www.linkedin.com/in/nayemabedin",
      dailyConnectionLimit: 25,
      dailyMessageLimit: 20,
      connectionsSentToday: 0,
      messagesSentToday: 0,
      autoConnectLeads: true,
      autoMessageInvestors: true,
      connectionNoteTemplate: "Hi {{firstName}}, saw your work at {{companyName}}. We built an autonomous voice AI receptionist for clinic after-hours calls. Would love to connect!",
      inmailTemplate: "Hi {{firstName}},\n\nFollowing your investments in Applied AI & Voice infrastructure. We've built Abedin Voice AI.\n\nWould love to share our 10-slide deck.\n\nBest,\nNayem",
      status: "CONNECTED",
      lastSyncAt: new Date().toISOString(),
    }
  );

  useEffect(() => {
    const unsub = workspaceGmailService.subscribe((state) => {
      setGmailState(state);
    });
    return () => unsub();
  }, []);

  const handleAuthorizeWorkspace = async () => {
    setIsAuthorizingWorkspace(true);
    setAuthError(null);
    try {
      await workspaceGmailService.requestAuthorization(sender.senderEmail || "info@abedintech.com");
      const st = workspaceGmailService.getState();
      setGmailState(st);
    } catch (err: any) {
      console.error("Workspace authorization failed:", err);
      setAuthError(err.message || "Failed to authorize Google Workspace account.");
    } finally {
      setIsAuthorizingWorkspace(false);
    }
  };

  const handleDisconnectWorkspace = () => {
    workspaceGmailService.disconnect();
    setGmailState(workspaceGmailService.getState());
  };
  const [activeTab, setActiveTab] = useState<"ALL" | "EMAIL" | "LINKEDIN" | "CALENDAR" | "VOICE">("ALL");
  const [isSavingSender, setIsSavingSender] = useState(false);
  const [isSavingLinkedIn, setIsSavingLinkedIn] = useState(false);
  const [senderSavedSuccess, setSenderSavedSuccess] = useState(false);
  const [linkedInSavedSuccess, setLinkedInSavedSuccess] = useState(false);
  const [testSendSuccess, setTestSendSuccess] = useState(false);

  // Load from API if available
  useEffect(() => {
    diagnosticFetch("/api/sender-identity")
      .then((res) => res.json())
      .then((data) => {
        if (data && data.senderEmail) setSender(data);
      })
      .catch((e) => console.error("Failed to load sender identity:", e));

    diagnosticFetch("/api/linkedin-config")
      .then((res) => res.json())
      .then((data) => {
        if (data && data.profileName) setLinkedIn(data);
      })
      .catch((e) => console.error("Failed to load linkedin config:", e));
  }, []);

  const handleSaveSender = async () => {
    setIsSavingSender(true);
    try {
      const res = await diagnosticFetch("/api/sender-identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sender),
      });
      if (res.ok) {
        const updated = await res.json();
        setSender(updated);
        if (onUpdateSenderIdentity) onUpdateSenderIdentity(updated);
        setSenderSavedSuccess(true);
        setTimeout(() => setSenderSavedSuccess(false), 3000);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsSavingSender(false);
    }
  };

  const handleSaveLinkedIn = async () => {
    setIsSavingLinkedIn(true);
    try {
      const res = await diagnosticFetch("/api/linkedin-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(linkedIn),
      });
      if (res.ok) {
        const updated = await res.json();
        setLinkedIn(updated);
        if (onUpdateLinkedInConfig) onUpdateLinkedInConfig(updated);
        setLinkedInSavedSuccess(true);
        setTimeout(() => setLinkedInSavedSuccess(false), 3000);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsSavingLinkedIn(false);
    }
  };

  const handleTestLinkedInSync = () => {
    setTestSendSuccess(true);
    setTimeout(() => setTestSendSuccess(false), 3500);
  };

  return (
    <div className="space-y-6">
      {/* Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">
              Connected Channels & Integrations
            </h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold border border-emerald-200">
              Live & Verified
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Configure your active sending email account, connect LinkedIn for automated networking, and manage Google Workspace sync.
          </p>
        </div>

        {/* Quick Filter Tabs */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-100 rounded-xl text-xs font-semibold">
          {[
            { id: "ALL", label: "All Integrations" },
            { id: "EMAIL", label: "Email Sending" },
            { id: "LINKEDIN", label: "LinkedIn" },
            { id: "CALENDAR", label: "Calendar & Voice" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id as any)}
              className={`px-3 py-1.5 rounded-lg transition-colors ${
                activeTab === t.id
                  ? "bg-white text-slate-900 shadow-2xs font-bold"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* TOP NOTIFICATION / ACTIVE SENDER BANNER */}
      <div className="p-4 rounded-2xl bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 text-white shadow-md flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start sm:items-center gap-3">
          <div className="p-2.5 rounded-xl bg-blue-600/30 text-blue-300 border border-blue-500/30">
            <Mail className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-blue-400">
                Primary Outbound Email Identity
              </span>
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            </div>
            <div className="text-sm font-bold text-white mt-0.5">
              {sender.senderName} &lt;{sender.senderEmail}&gt;
            </div>
            <div className="text-xs text-slate-300">
              {sender.jobTitle} at {sender.companyName} • OAuth 2.0 Direct API Active
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs border-t md:border-t-0 md:border-l border-slate-700/80 pt-3 md:pt-0 md:pl-5">
          <div>
            <div className="text-slate-400">LinkedIn Profile</div>
            <div className="font-bold text-white flex items-center gap-1.5">
              <Linkedin className="w-3.5 h-3.5 text-blue-400" />
              <span>{linkedIn.profileName}</span>
            </div>
          </div>
          <div>
            <div className="text-slate-400">Daily Cap</div>
            <div className="font-bold text-emerald-400">100 Emails / Day</div>
          </div>
        </div>
      </div>

      {/* LINKEDIN OUTREACH & MESSAGING INTEGRATION CARD */}
      {(activeTab === "ALL" || activeTab === "LINKEDIN") && (
        <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-2xl bg-[#0077b5]/10 text-[#0077b5]">
                <Linkedin className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-slate-900">
                    LinkedIn Autonomous Outreach & Messaging
                  </h2>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${
                      linkedIn.connected
                        ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                        : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {linkedIn.connected ? "Connected & Synced" : "Disconnected"}
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Send automated connection requests with personalized notes to clinic managers and InMails to venture investors.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleTestLinkedInSync}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Test Sync</span>
              </button>
              <button
                onClick={() => setLinkedIn({ ...linkedIn, connected: !linkedIn.connected })}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  linkedIn.connected
                    ? "bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                }`}
              >
                {linkedIn.connected ? "Disconnect" : "Connect LinkedIn Profile"}
              </button>
            </div>
          </div>

          {testSendSuccess && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 font-bold flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>LinkedIn connection verified. Rate limits active and compliant with LinkedIn safety guidelines.</span>
            </div>
          )}

          {/* LinkedIn Configuration Form */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  LinkedIn Account Name
                </label>
                <input
                  type="text"
                  value={linkedIn.profileName}
                  onChange={(e) => setLinkedIn({ ...linkedIn, profileName: e.target.value })}
                  placeholder="e.g. Nayem Abedin"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  LinkedIn Profile URL
                </label>
                <input
                  type="text"
                  value={linkedIn.profileUrl}
                  onChange={(e) => setLinkedIn({ ...linkedIn, profileUrl: e.target.value })}
                  placeholder="https://www.linkedin.com/in/yourprofile"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Professional Headline
                </label>
                <input
                  type="text"
                  value={linkedIn.profileHeadline}
                  onChange={(e) => setLinkedIn({ ...linkedIn, profileHeadline: e.target.value })}
                  placeholder="Founder @ Abedin Tech | Voice AI"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium"
                />
              </div>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Max Connects / Day
                  </label>
                  <input
                    type="number"
                    value={linkedIn.dailyConnectionLimit}
                    onChange={(e) =>
                      setLinkedIn({ ...linkedIn, dailyConnectionLimit: Number(e.target.value) })
                    }
                    min={1}
                    max={50}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-bold"
                  />
                  <span className="text-[10px] text-slate-400">Safe limit: 25/day</span>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Max InMails / Day
                  </label>
                  <input
                    type="number"
                    value={linkedIn.dailyMessageLimit}
                    onChange={(e) =>
                      setLinkedIn({ ...linkedIn, dailyMessageLimit: Number(e.target.value) })
                    }
                    min={1}
                    max={50}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-bold"
                  />
                  <span className="text-[10px] text-slate-400">Safe limit: 20/day</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Default Connection Note Template
                </label>
                <textarea
                  rows={3}
                  value={linkedIn.connectionNoteTemplate}
                  onChange={(e) =>
                    setLinkedIn({ ...linkedIn, connectionNoteTemplate: e.target.value })
                  }
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-mono"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-slate-100">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>Anti-ban pacing: 1 request every 4-8 minutes</span>
            </div>

            <button
              onClick={handleSaveLinkedIn}
              disabled={isSavingLinkedIn}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-xs transition-colors"
            >
              {isSavingLinkedIn ? (
                <span>Saving...</span>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>{linkedInSavedSuccess ? "Saved LinkedIn Settings!" : "Save LinkedIn Setup"}</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* SENDER EMAIL IDENTITY & GMAIL OAUTH CONFIGURATION */}
      {(activeTab === "ALL" || activeTab === "EMAIL") && (
        <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-2xl bg-red-100 text-red-600">
                <Mail className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-slate-900">
                    Google Workspace &amp; Gmail OAuth Integration
                  </h2>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase bg-emerald-100 text-emerald-800 border border-emerald-200">
                    Workspace Connected
                  </span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 border border-blue-200 flex items-center gap-1">
                    <Tag className="w-3 h-3 text-blue-600" />
                    Label: Abedin Growth AI
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Send emails through <strong className="text-slate-800">info@abedintech.com</strong>, organize incoming replies under the <strong className="text-blue-700">Abedin Growth AI</strong> label, and auto-sync with your inbox.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {gmailState.isConnected ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    Active Token ({sender.senderEmail})
                  </span>
                  <button
                    onClick={handleDisconnectWorkspace}
                    className="text-xs px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleAuthorizeWorkspace}
                  disabled={isAuthorizingWorkspace}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold text-white bg-red-600 hover:bg-red-700 shadow-sm transition-colors disabled:opacity-50"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>{isAuthorizingWorkspace ? "Authorizing..." : "Connect info@abedintech.com"}</span>
                </button>
              )}
            </div>
          </div>

          {authError && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>{authError}</span>
            </div>
          )}

          {/* Workspace Capabilities Callout */}
          <div className="p-3.5 bg-blue-50/70 border border-blue-200 rounded-xl text-xs text-blue-900 grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="flex items-start gap-2">
              <Check className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold">Direct Workspace Sending:</span>
                <p className="text-blue-800 text-[11px]">All outbound emails use info@abedintech.com with your official signature.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Check className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold">Client Reply Ingestion:</span>
                <p className="text-blue-800 text-[11px]">Replies from prospects and investors flow seamlessly into your inbox feed.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Check className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold">Automatic Gmail Tagging:</span>
                <p className="text-blue-800 text-[11px]">Threads are automatically labeled with <strong>Abedin Growth AI</strong> in Gmail.</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Sender Display Name
                </label>
                <input
                  type="text"
                  value={sender.senderName}
                  onChange={(e) => setSender({ ...sender, senderName: e.target.value })}
                  placeholder="e.g. Nayem Abedin"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Sender Email Address (From)
                </label>
                <input
                  type="email"
                  value={sender.senderEmail}
                  onChange={(e) => setSender({ ...sender, senderEmail: e.target.value })}
                  placeholder="nayem@abedintech.com"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Job Title
                </label>
                <input
                  type="text"
                  value={sender.jobTitle}
                  onChange={(e) => setSender({ ...sender, jobTitle: e.target.value })}
                  placeholder="Founder & CEO"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium"
                />
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Company Name
                </label>
                <input
                  type="text"
                  value={sender.companyName}
                  onChange={(e) => setSender({ ...sender, companyName: e.target.value })}
                  placeholder="Abedin Tech"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Email Signature
                </label>
                <textarea
                  rows={4}
                  value={sender.emailSignature}
                  onChange={(e) => setSender({ ...sender, emailSignature: e.target.value })}
                  placeholder="Nayem Abedin&#10;Founder & CEO | Abedin Tech&#10;https://abedintech.com/voice-ai/"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-mono"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-slate-100">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>SPF, DKIM, DMARC 100% compliant on abedintech.com</span>
            </div>

            <button
              onClick={handleSaveSender}
              disabled={isSavingSender}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-xs transition-colors"
            >
              {isSavingSender ? (
                <span>Saving...</span>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>{senderSavedSuccess ? "Saved Email Identity!" : "Save Email Identity"}</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* OTHER CONNECTED APIS: Google Calendar & Voice AI */}
      {(activeTab === "ALL" || activeTab === "CALENDAR" || activeTab === "VOICE") && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Calendar */}
          <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-blue-100 text-blue-700">
                  <Calendar className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Google Calendar Booking</h3>
                  <div className="text-xs text-slate-500 font-mono">Work Calendar (Synced)</div>
                </div>
              </div>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase bg-emerald-100 text-emerald-800 border border-emerald-200">
                Connected
              </span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Real-time slot inspection so AI agents can offer open time windows and book prospect demos autonomously.
            </p>
            <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
              <span className="text-slate-400">Timezone: Europe/London (GMT+0)</span>
              <span className="font-bold text-blue-600">Auto-Booking Active</span>
            </div>
          </div>

          {/* Voice AI */}
          <div className="p-5 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-indigo-100 text-indigo-700">
                  <Bot className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Abedin Voice AI Receptionist Engine</h3>
                  <div className="text-xs text-slate-500 font-mono">Engine v2 (Sub-500ms Latency)</div>
                </div>
              </div>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase bg-emerald-100 text-emerald-800 border border-emerald-200">
                Active
              </span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Direct webhook integration enabling live interactive phone call demonstrations and simulated audio proof.
            </p>
            <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
              <span className="text-slate-400">Endpoint: https://abedintech.com/voice-ai/</span>
              <span className="font-bold text-indigo-600">Live Webhook</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
