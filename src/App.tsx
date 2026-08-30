import React, { useState, useEffect } from "react";

import { initAuth, googleSignIn, logout as firebaseLogout, getAccessToken } from "./lib/firebase";
import { User } from "firebase/auth";

import { Sidebar, NavTab } from "./components/Sidebar";
import { Header } from "./components/Header";
import { CommandBar } from "./components/CommandBar";
import { ScoreWhyModal } from "./components/ScoreWhyModal";
import { WorkflowPlanModal } from "./components/WorkflowPlanModal";
import { NewOpportunityModal } from "./components/NewOpportunityModal";
import { AddLeadModal } from "./components/AddLeadModal";
import { AddInvestorModal } from "./components/AddInvestorModal";
import { AddPartnerModal } from "./components/AddPartnerModal";
import { DiscoverLeadsModal } from "./components/DiscoverLeadsModal";
import { DiscoverInvestorsModal } from "./components/DiscoverInvestorsModal";
import { DiscoverPartnersModal } from "./components/DiscoverPartnersModal";
import { ScheduleMeetingModal } from "./components/ScheduleMeetingModal";
import { PitchSimulatorModal } from "./components/PitchSimulatorModal";
import { LiveMeetingBattlecardModal } from "./components/LiveMeetingBattlecardModal";
import { OnboardingModal } from "./pages/OnboardingModal";
import { diagnosticFetch } from "./utils/diagnosticFetch";
import { DashboardView } from "./pages/DashboardView";
import { LeadsView } from "./pages/LeadsView";
import { LeadDetailModal } from "./pages/LeadDetailModal";
import { InvestorDetailModal } from "./pages/InvestorDetailModal";
import { PartnerDetailModal } from "./pages/PartnerDetailModal";
import { CompaniesView } from "./pages/CompaniesView";
import { InvestorsView } from "./pages/InvestorsView";
import { PartnersView } from "./pages/PartnersView";
import { CampaignsView } from "./pages/CampaignsView";
import { CampaignWizardModal } from "./pages/CampaignWizardModal";
import { InboxView } from "./pages/InboxView";
import { OutboxView } from "./pages/OutboxView";
import { PipelineView } from "./pages/PipelineView";
import { MeetingsView } from "./pages/MeetingsView";
import { GrowthAgentView } from "./pages/GrowthAgentView";
import { KnowledgeView } from "./pages/KnowledgeView";
import { AnalyticsView } from "./pages/AnalyticsView";
import { IntegrationsView } from "./pages/IntegrationsView";
import { SettingsView } from "./pages/SettingsView";
import {
  Lead,
  Investor,
  Partner,
  Campaign,
  Conversation,
  Opportunity,
  Meeting,
  CompanyBrain,
  KnowledgeItem,
  AutopilotSettings,
  NeedsAttentionItem,
  DailyGrowthBrief,
  AIRunLog,
  EngineType,
  AutopilotStatusState,
} from "./types";
import { AICommandResult } from "../server/agents/growthCommandAgent";

export function App() {
  const [currentTab, setCurrentTab] = useState<NavTab>("home");

  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = initAuth(
      (user, token) => {
        setCurrentUser(user);
        setIsAuthLoading(false);
        // Send token to backend so it can be used for autonomous background tasks
        fetch('/api/settings/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        }).catch(err => console.error("Failed to sync token to backend:", err));
      },
      () => {
        setCurrentUser(null);
        setIsAuthLoading(false);
      }
    );
    return () => unsubscribe();
  }, []);

  const handleGoogleLogin = async () => {
    try {
      await googleSignIn();
    } catch (e) {
      console.error(e);
    }
  };

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Modals state
  const [commandBarOpen, setCommandBarOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [newCampaignOpen, setNewCampaignOpen] = useState(false);
  const [newOpportunityOpen, setNewOpportunityOpen] = useState(false);
  const [addLeadOpen, setAddLeadOpen] = useState(false);
  const [addInvestorOpen, setAddInvestorOpen] = useState(false);
  const [addPartnerOpen, setAddPartnerOpen] = useState(false);
  const [discoverLeadsOpen, setDiscoverLeadsOpen] = useState(false);
  const [discoverInvestorsOpen, setDiscoverInvestorsOpen] = useState(false);
  const [discoverPartnersOpen, setDiscoverPartnersOpen] = useState(false);
  const [scheduleMeetingOpen, setScheduleMeetingOpen] = useState(false);
  const [scheduleMeetingInitialData, setScheduleMeetingInitialData] = useState<{
    name?: string;
    companyName?: string;
    email?: string;
    category?: EngineType;
  } | undefined>(undefined);
  const [scoreWhyTarget, setScoreWhyTarget] = useState<any | null>(null);
  const [activeLeadDetail, setActiveLeadDetail] = useState<Lead | null>(null);
  const [activeInvestorDetail, setActiveInvestorDetail] = useState<Investor | null>(null);
  const [activePartnerDetail, setActivePartnerDetail] = useState<Partner | null>(null);
  const [selectedInboxConvId, setSelectedInboxConvId] = useState<string | undefined>(undefined);
  const [activePlan, setActivePlan] = useState<AICommandResult | null>(null);
  const [pitchSimulatorTarget, setPitchSimulatorTarget] = useState<{
    entity: Lead | Investor;
    type: "CUSTOMER" | "INVESTOR";
  } | null>(null);
  const [battlecardTarget, setBattlecardTarget] = useState<{
    entity: Lead | Investor;
    type: "CUSTOMER" | "INVESTOR";
  } | null>(null);

  // App Data State
  const [kpis, setKpis] = useState({
    qualifiedLeads: 18,
    positiveConversations: 7,
    meetingsBooked: 4,
    pipelineValue: 48000,
    investorConversations: 3,
    partnerConversations: 4,
  });

  const [attentionItems, setAttentionItems] = useState<NeedsAttentionItem[]>([]);
  const [dailyBrief, setDailyBrief] = useState<DailyGrowthBrief>({
    date: new Date().toISOString().split("T")[0],
    prospectsResearched: 34,
    qualifiedCount: 18,
    contactedCount: 12,
    demosBooked: 2,
    strategicRecommendation:
      "Dental practices with 5-20 staff are responding 38% better when the opening line references after-hours missed patient call volume.",
  });

  const [companyBrain, setCompanyBrain] = useState<CompanyBrain>({
    companyName: "Abedin Tech",
    companyUrl: "https://abedintech.com/voice-ai/",
    productName: "Abedin Voice AI",
    productUrl: "https://abedintech.com/voice-ai/",
    tagline: "Autonomous 24/7 Voice AI Receptionists & Appointment Booking for High-Call Businesses",
    primaryBenefits: [
      "Sub-500ms voice response latency for natural, fluent conversations",
      "Direct 2-way Google Calendar and CRM appointment scheduling",
      "Zero missed after-hours patient or customer revenue",
      "80% reduction in front-desk reception overhead",
    ],
    targetIndustries: ["Dental & Healthcare Clinics", "Real Estate Agencies", "Legal Practices"],
    targetPersonas: [
      { title: "Practice Manager", primaryGoal: "Ensure every patient call is answered without burning out front desk", mainObjection: "Is AI realistic enough for patient triage?" },
      { title: "Managing Partner / Founder", primaryGoal: "Increase revenue recovery from after-hours callers", mainObjection: "Integration friction with calendar software" },
    ],
    objectionsHandling: [
      { objection: "Does it sound like an annoying robotic IVR?", counterAngle: "No, Abedin Voice AI uses fluid sub-500ms conversational models with human-like cadence." },
      { objection: "Can it book directly into our calendar?", counterAngle: "Yes, it verifies free/busy slots and books directly via Google Calendar/CRM." },
    ],
    investorNarrative: {
      vision: "Building the universal autonomous voice layer for global service operations.",
      marketSize: "$45B Global Conversational AI & Reception Market",
      tractionHighlights: "Deploying across UK clinics with 98.4% call resolution rate.",
    },
  });

  const [leads, setLeads] = useState<Lead[]>([]);
  const [investors, setInvestors] = useState<Investor[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [autopilotSettings, setAutopilotSettings] = useState<AutopilotSettings>({
    autonomyLevel: "SEMI_AUTONOMOUS",
    requireApprovalForInvestors: true,
    requireApprovalForPartners: false,
    requireApprovalForDiscountRequests: true,
    autoCheckQualityControl: true,
    maxOutreachPerDay: 50,
  });
  const [aiLogs, setAiLogs] = useState<AIRunLog[]>([]);
  const [autopilotStatus, setAutopilotStatus] = useState<AutopilotStatusState | undefined>(undefined);

  const syncLiveEngineData = async () => {
    try {
      const [autoRes, dashRes, leadsRes, invRes, inboxRes, logsRes] = await Promise.all([
        fetch("/api/autopilot/status"),
        fetch("/api/dashboard"),
        fetch("/api/leads"),
        fetch("/api/investors"),
        fetch("/api/inbox"),
        fetch("/api/logs"),
      ]);

      const isJson = (res: Response) => res.headers.get("content-type")?.includes("application/json");

      if (autoRes.ok && isJson(autoRes)) {
        const data: AutopilotStatusState = await autoRes.json();
        setAutopilotStatus(data);
      }
      if (dashRes.ok && isJson(dashRes)) {
        const d = await dashRes.json();
        setKpis(d.kpis);
        if (d.dailyBrief) setDailyBrief(d.dailyBrief);
        if (d.attentionItems) setAttentionItems(d.attentionItems);
      }
      if (leadsRes.ok && isJson(leadsRes)) {
        const freshLeads = await leadsRes.json();
        setLeads(freshLeads);
      }
      if (invRes.ok && isJson(invRes)) {
        const freshInv = await invRes.json();
        setInvestors(freshInv);
      }
      if (inboxRes.ok && isJson(inboxRes)) {
        const freshInbox = await inboxRes.json();
        setConversations(freshInbox);
      }
      if (logsRes.ok && isJson(logsRes)) {
        const freshLogs = await logsRes.json();
        setAiLogs(freshLogs);
      }
    } catch (e) {
      if (e instanceof TypeError && e.message === 'Failed to fetch') {
        // Ignore dev server restart disconnect
      } else if (e instanceof SyntaxError && e.message.includes('json')) {
        // Ignore benign HTML response during dev server restart
      } else {
        console.error("Live data sync error:", e);
      }
    }
  };

  const handleToggleAutopilot = async () => {
    try {
      const res = await fetch("/api/autopilot/toggle", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.status) setAutopilotStatus(data.status);
        await syncLiveEngineData();
      }
    } catch (e) {
      console.error("Failed to toggle autopilot:", e);
    }
  };

  const handleRunAutopilotCycleNow = async () => {
    try {
      const res = await fetch("/api/autopilot/run-cycle-now", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.status) setAutopilotStatus(data.status);
        await syncLiveEngineData();
      }
    } catch (e) {
      console.error("Failed to run autopilot cycle:", e);
    }
  };

  // Initial Data Fetching
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [
          dashRes,
          brainRes,
          leadsRes,
          invRes,
          partRes,
          campRes,
          inboxRes,
          pipeRes,
          meetRes,
          knoRes,
          setRes,
          logsRes,
          autoRes,
        ] = await Promise.all([
          fetch("/api/dashboard"),
          fetch("/api/company-brain"),
          fetch("/api/leads"),
          fetch("/api/investors"),
          fetch("/api/partners"),
          fetch("/api/campaigns"),
          fetch("/api/inbox"),
          fetch("/api/pipeline"),
          fetch("/api/meetings"),
          fetch("/api/knowledge"),
          fetch("/api/settings"),
          fetch("/api/logs"),
          fetch("/api/autopilot/status"),
        ]);

        const isJson = (r: Response) => r.headers.get("content-type")?.includes("application/json");

        if (dashRes.ok && isJson(dashRes)) {
          const d = await dashRes.json();
          setKpis(d.kpis);
          setAttentionItems(d.attentionItems || []);
          if (d.dailyBrief) setDailyBrief(d.dailyBrief);
        }
        if (brainRes.ok && isJson(brainRes)) setCompanyBrain(await brainRes.json());
        if (leadsRes.ok && isJson(leadsRes)) setLeads(await leadsRes.json());
        if (invRes.ok && isJson(invRes)) setInvestors(await invRes.json());
        if (partRes.ok && isJson(partRes)) setPartners(await partRes.json());
        if (campRes.ok && isJson(campRes)) setCampaigns(await campRes.json());
        if (inboxRes.ok && isJson(inboxRes)) setConversations(await inboxRes.json());
        if (pipeRes.ok && isJson(pipeRes)) setOpportunities(await pipeRes.json());
        if (meetRes.ok && isJson(meetRes)) setMeetings(await meetRes.json());
        if (knoRes.ok && isJson(knoRes)) setKnowledgeItems(await knoRes.json());
        if (setRes.ok && isJson(setRes)) {
          const s = await setRes.json();
          
        }
        if (logsRes.ok && isJson(logsRes)) setAiLogs(await logsRes.json());
        if (autoRes.ok && isJson(autoRes)) setAutopilotStatus(await autoRes.json());
      } catch (e) {
        if (e instanceof TypeError && e.message === 'Failed to fetch') {
          // Ignore
        } else if (e instanceof SyntaxError && e.message.includes('json')) {
          // Ignore
        } else {
          console.error("Initial fetch error:", e);
        }
      }
    };

    fetchData();

    // Periodic live sync for continuous background runner every 8 seconds
    const interval = setInterval(syncLiveEngineData, 8000);
    return () => clearInterval(interval);
  }, []);

  // Quick refresh whenever tab changes
  useEffect(() => {
    syncLiveEngineData();
  }, [currentTab]);

  // Keyboard shortcut for Command Bar (⌘K or Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandBarOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Handlers for interactive actions
  const handleOpenScoreWhy = (item: any) => {
    setScoreWhyTarget(item);
  };

  const handleOpenAttentionItem = (item: NeedsAttentionItem) => {
    if (item.actionType === "REVIEW_REPLY") {
      const conv = conversations.find((c) => c.id === item.relatedEntityId);
      if (conv) {
        setSelectedInboxConvId(conv.id);
        setCurrentTab("inbox");
      } else {
        setCurrentTab("inbox");
      }
    } else if (item.actionType === "FOUNDER_REVIEW") {
      setCurrentTab("investors");
    } else {
      setCurrentTab("meetings");
    }
  };

  const handleSendEmail = async (lead: Lead, subject: string, body: string) => {
    try {
      const res = await diagnosticFetch(`/api/leads/${lead.id}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.lead) {
          setLeads((prev) =>
            prev.map((l) => (l.id === lead.id ? { ...l, ...data.lead } : l))
          );
        }
        // Refresh conversations and dashboard
        const [inboxRes, dashRes] = await Promise.all([
          fetch("/api/inbox"),
          fetch("/api/dashboard"),
        ]);
        if (inboxRes.ok) setConversations(await inboxRes.json());
        if (dashRes.ok) {
          const d = await dashRes.json();
          setKpis(d.kpis);
        }
      } else {
        // Fallback local update
        const nowIso = new Date().toISOString();
        setLeads((prev) =>
          prev.map((l) =>
            l.id === lead.id
              ? {
                  ...l,
                  status: "CONTACTED",
                  contactedAt: nowIso,
                  lastOutreachSubject: subject,
                  lastOutreachBody: body,
                  lastOutreachChannel: "EMAIL",
                }
              : l
          )
        );
      }
    } catch (e) {
      console.error("Failed to send email to lead:", e);
    }
  };

  const handleBookMeeting = async (prospect: any) => {
    setScheduleMeetingInitialData({
      name: prospect.name,
      companyName: prospect.companyName || prospect.fundName,
      email: prospect.email,
      category: prospect.fundName ? "INVESTOR" : prospect.partnerType ? "PARTNER" : "CUSTOMER",
    });
    setScheduleMeetingOpen(true);
  };

  const handleResearchLead = async (lead: Lead) => {
    try {
      const res = await fetch("/api/leads/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lead),
      });
      if (res.ok) {
        const updated = await res.json();
        setLeads((prev) =>
          prev.map((l) => (l.id === lead.id ? { ...l, ...updated } : l))
        );
        if (activeLeadDetail?.id === lead.id) {
          setActiveLeadDetail({ ...activeLeadDetail, ...updated });
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleBatchDiscoverLeads = async () => {
    try {
      const res = await fetch("/api/leads/batch-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          industry: "Dental & Healthcare Clinics",
          location: "United Kingdom",
          count: 4,
        }),
      });
      if (res.ok) {
        const newBatch = await res.json();
        setLeads((prev) => [...newBatch, ...prev]);
        setKpis((prev) => ({ ...prev, qualifiedLeads: prev.qualifiedLeads + newBatch.length }));
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleToggleCampaignStatus = async (campaignId: string) => {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/toggle`, {
        method: "POST",
      });
      if (res.ok) {
        const updated = await res.json();
        setCampaigns((prev) =>
          prev.map((c) => (c.id === campaignId ? updated : c))
        );
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleSendInboxReply = async (convId: string, subject: string, body: string) => {
    const res = await fetch(`/api/inbox/${convId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject, body }),
    });
    if (res.ok) {
      const data = await res.json();
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? data.conversation : c))
      );
      setAttentionItems((prev) => prev.filter((a) => a.relatedEntityId !== convId));
    }
  };

  const handleClassifyThread = async (convId: string) => {
    const res = await fetch(`/api/inbox/${convId}/classify`, {
      method: "POST",
    });
    if (res.ok) {
      const data = await res.json();
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? data.conversation : c))
      );
    }
  };

  const handleUpdatePipelineStage = async (oppId: string, newStage: any) => {
    const res = await fetch(`/api/pipeline/${oppId}/stage`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: newStage }),
    });
    if (res.ok) {
      const updated = await res.json();
      setOpportunities((prev) =>
        prev.map((o) => (o.id === oppId ? updated : o))
      );
    }
  };

  const handleGenerateMeetingBrief = async (meeting: Meeting) => {
    const res = await fetch("/api/meetings/brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(meeting),
    });
    if (res.ok) {
      const brief = await res.json();
      setMeetings((prev) =>
        prev.map((m) => (m.id === meeting.id ? { ...m, aiBrief: brief } : m))
      );
    }
  };

  const handleExecuteWorkflowPlan = async (plan: AICommandResult) => {
    try {
      const targetTab = plan.actionRecommendation?.targetTab || (plan.structuredIntent?.engineType === "INVESTOR" ? "investors" : plan.structuredIntent?.engineType === "PARTNER" ? "partners" : "leads");
      const count = (plan.structuredIntent as any)?.targetCount || plan.structuredIntent?.count || 4;
      const targetAudience = (plan.structuredIntent as any)?.targetAudience || plan.structuredIntent?.targetIndustry || "Dental & Healthcare Clinics";
      const location = (plan.structuredIntent as any)?.targetLocation || plan.structuredIntent?.location || "United Kingdom";

      if (targetTab === "leads" || plan.structuredIntent?.engineType === "CUSTOMER") {
        const res = await diagnosticFetch(
          "/api/leads/batch-generate",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              industry: targetAudience,
              location,
              count,
            }),
          },
          { context: "App.handleExecuteWorkflowPlan(Leads)" }
        );
        if (res.ok) {
          const newBatch = await res.json();
          setLeads((prev) => {
            const existingIds = new Set(prev.map((l) => l.id));
            const fresh = newBatch.filter((l: any) => !existingIds.has(l.id));
            return [...fresh, ...prev];
          });
          setKpis((prev) => ({ ...prev, qualifiedLeads: prev.qualifiedLeads + newBatch.length }));
        }
        setCurrentTab("leads");
      } else if (targetTab === "investors" || plan.structuredIntent?.engineType === "INVESTOR") {
        const res = await diagnosticFetch(
          "/api/investors/batch-generate",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              stage: "SEED",
              sectors: ["Applied AI", "Voice AI", "B2B SaaS"],
              location,
              count,
            }),
          },
          { context: "App.handleExecuteWorkflowPlan(Investors)" }
        );
        if (res.ok) {
          const newBatch = await res.json();
          setInvestors((prev) => {
            const existingIds = new Set(prev.map((i) => i.id));
            const fresh = newBatch.filter((i: any) => !existingIds.has(i.id));
            return [...fresh, ...prev];
          });
        }
        setCurrentTab("investors");
      } else if (targetTab === "partners" || plan.structuredIntent?.engineType === "PARTNER") {
        const res = await diagnosticFetch(
          "/api/partners/batch-generate",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              partnerType: "AGENCY",
              territory: location,
              count,
            }),
          },
          { context: "App.handleExecuteWorkflowPlan(Partners)" }
        );
        if (res.ok) {
          const newBatch = await res.json();
          setPartners((prev) => {
            const existingIds = new Set(prev.map((p) => p.id));
            const fresh = newBatch.filter((p: any) => !existingIds.has(p.id));
            return [...fresh, ...prev];
          });
        }
        setCurrentTab("partners");
      } else {
        setCurrentTab(targetTab as NavTab);
      }
    } catch (e) {
      console.error("Execute plan error:", e);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100/70 text-slate-800 font-sans flex antialiased">
      {/* Navigation Sidebar */}
      <Sidebar currentUser={currentUser} onLogin={handleGoogleLogin} onLogout={firebaseLogout}
        currentTab={currentTab}
        onSelectTab={(tab) => setCurrentTab(tab)}
        unreadInboxCount={conversations.filter((c) => c.unread).length}
        attentionCount={attentionItems.length}
        isOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 lg:pl-64">
        {/* Sticky Header */}
        <Header
          onToggleMobileMenu={() => setMobileMenuOpen(!mobileMenuOpen)}
          onOpenCommandBar={() => setCommandBarOpen(true)}
          onOpenOnboarding={() => setOnboardingOpen(true)}
          onOpenNewCampaign={() => setNewCampaignOpen(true)}
          autopilotStatus={autopilotStatus}
          onToggleAutopilot={handleToggleAutopilot}
          companyName={companyBrain.companyName}
          productName={companyBrain.productName}
        />

        {/* Page View Body */}
        <main
          className={`flex-1 w-full mx-auto ${
            currentTab === "inbox"
              ? "p-2 sm:p-4 max-w-7xl h-[calc(100vh-4.5rem)] min-h-[640px] flex flex-col overflow-hidden"
              : "p-4 sm:p-6 md:p-8 max-w-7xl"
          }`}
        >
          {currentTab === "home" && (
            <DashboardView
              kpis={kpis}
              attentionItems={attentionItems}
              dailyBrief={dailyBrief}
              autopilotStatus={autopilotStatus}
              onToggleAutopilot={handleToggleAutopilot}
              onRunCycleNow={handleRunAutopilotCycleNow}
              onNavigateTab={(t) => setCurrentTab(t)}
              onOpenCommandBar={() => setCommandBarOpen(true)}
              onOpenAttentionItem={handleOpenAttentionItem}
            />
          )}

          {currentTab === "leads" && (
            <LeadsView
              leads={leads}
              onSelectLead={(lead) => setActiveLeadDetail(lead)}
              onOpenScoreWhy={handleOpenScoreWhy}
              onOpenAddLead={() => setAddLeadOpen(true)}
              onBatchDiscoverLeads={() => setDiscoverLeadsOpen(true)}
              onBookMeeting={handleBookMeeting}
              onOpenPitchSimulator={(lead) => setPitchSimulatorTarget({ entity: lead, type: "CUSTOMER" })}
              onOpenBattlecard={(lead) => setBattlecardTarget({ entity: lead, type: "CUSTOMER" })}
              onBulkEnrollCampaign={(selectedLeads) => {
                setLeads((prev) =>
                  prev.map((l) =>
                    selectedLeads.some((sl) => sl.id === l.id) ? { ...l, status: "CONTACTED" } : l
                  )
                );
              }}
            />
          )}

          {currentTab === "companies" && (
            <CompaniesView
              leads={leads}
              onSelectCompanyLeads={(_name) => setCurrentTab("leads")}
            />
          )}

          {currentTab === "investors" && (
            <InvestorsView
              investors={investors}
              onOpenScoreWhy={handleOpenScoreWhy}
              onSelectInvestor={(inv) => setActiveInvestorDetail(inv)}
              onBookMeeting={handleBookMeeting}
              onAddInvestor={() => setAddInvestorOpen(true)}
              onDiscoverInvestors={() => setDiscoverInvestorsOpen(true)}
              onOpenPitchSimulator={(inv) => setPitchSimulatorTarget({ entity: inv, type: "INVESTOR" })}
              onOpenBattlecard={(inv) => setBattlecardTarget({ entity: inv, type: "INVESTOR" })}
            />
          )}

          {currentTab === "partners" && (
            <PartnersView
              partners={partners}
              onOpenScoreWhy={handleOpenScoreWhy}
              onSelectPartner={(p) => setActivePartnerDetail(p)}
              onBookMeeting={handleBookMeeting}
              onAddPartner={() => setAddPartnerOpen(true)}
              onDiscoverPartners={() => setDiscoverPartnersOpen(true)}
            />
          )}

          {currentTab === "campaigns" && (
            <CampaignsView
              campaigns={campaigns}
              onOpenNewCampaign={() => setNewCampaignOpen(true)}
              onToggleCampaignStatus={handleToggleCampaignStatus}
            />
          )}

          {currentTab === "inbox" && (
            <InboxView
              conversations={conversations}
              meetings={meetings}
              initialSelectedId={selectedInboxConvId}
              onSelectConversation={(_c) => {}}
              onSendReply={handleSendInboxReply}
              onBookMeeting={handleBookMeeting}
              onClassifyThread={handleClassifyThread}
              companyBrain={companyBrain}
              onRefreshOutbox={syncLiveEngineData}
              onRefreshConversations={syncLiveEngineData}
            />
          )}
          {currentTab === "outbox" && <OutboxView />}

          {currentTab === "pipeline" && (
            <PipelineView
              opportunities={opportunities}
              onUpdateStage={handleUpdatePipelineStage}
              onAddOpportunity={() => setNewOpportunityOpen(true)}
            />
          )}

          {currentTab === "meetings" && (
            <MeetingsView
              meetings={meetings}
              onGenerateBrief={handleGenerateMeetingBrief}
              onScheduleNew={() => {
                setScheduleMeetingInitialData(undefined);
                setScheduleMeetingOpen(true);
              }}
              onRefreshMeetings={syncLiveEngineData}
            />
          )}

          {currentTab === "agent" && (
            <GrowthAgentView
              onExecutePlan={(plan) => setActivePlan(plan)}
              onNavigateTab={(t) => setCurrentTab(t)}
            />
          )}

          {currentTab === "knowledge" && (
            <KnowledgeView
              brain={companyBrain}
              knowledgeItems={knowledgeItems}
              onUpdateBrain={(updated) => setCompanyBrain(updated)}
              onAddKnowledgeItem={(newItem) => {
                setKnowledgeItems((prev) => [newItem, ...prev]);
              }}
            />
          )}

          {currentTab === "analytics" && <AnalyticsView />}

          {currentTab === "integrations" && <IntegrationsView />}

          {currentTab === "settings" && (
            <SettingsView
              settings={autopilotSettings}
              onUpdateSettings={(newS) => {
                setAutopilotSettings(newS);
                fetch("/api/settings/autopilot", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(newS),
                });
              }}
              logs={aiLogs}
            />
          )}
        </main>
      </div>

      {/* MODALS */}
      <CommandBar
        isOpen={commandBarOpen}
        onClose={() => setCommandBarOpen(false)}
        onExecutePlan={(plan) => setActivePlan(plan)}
        onNavigateTab={(tab) => setCurrentTab(tab)}
      />

      <WorkflowPlanModal
        plan={activePlan}
        onClose={() => setActivePlan(null)}
        onConfirmStart={async (plan) => {
          await handleExecuteWorkflowPlan(plan);
        }}
      />

      <ScoreWhyModal
        isOpen={!!scoreWhyTarget}
        onClose={() => setScoreWhyTarget(null)}
        title={scoreWhyTarget?.name || ""}
        subtitle={`${scoreWhyTarget?.companyName || scoreWhyTarget?.fundName || ""} • ${scoreWhyTarget?.industry || scoreWhyTarget?.stage || ""}`}
        totalScore={scoreWhyTarget?.aiScore || scoreWhyTarget?.investorFitScore || scoreWhyTarget?.partnerFitScore || 88}
        breakdown={scoreWhyTarget?.scoreBreakdown}
        recommendedPitch={scoreWhyTarget?.recommendedPitch || scoreWhyTarget?.recommendedPitchAngle}
        bestAngle={scoreWhyTarget?.bestOutreachAngle || scoreWhyTarget?.potentialCollaboration}
        customReasons={scoreWhyTarget?.thesisMatchReason ? [scoreWhyTarget.thesisMatchReason] : undefined}
        sensitiveRestrictions={scoreWhyTarget?.sensitiveRestrictions}
      />

      <LeadDetailModal
        lead={activeLeadDetail}
        conversations={conversations}
        onClose={() => setActiveLeadDetail(null)}
        onOpenScoreWhy={handleOpenScoreWhy}
        onSendEmail={handleSendEmail}
        onSendReply={handleSendInboxReply}
        onBookMeeting={handleBookMeeting}
        onResearchLead={handleResearchLead}
        onNavigateToInbox={(convId) => {
          setSelectedInboxConvId(convId);
          setActiveLeadDetail(null);
          setCurrentTab("inbox");
        }}
        onOpenPitchSimulator={(lead) => {
          setActiveLeadDetail(null);
          setPitchSimulatorTarget({ entity: lead, type: "CUSTOMER" });
        }}
        onOpenBattlecard={(lead) => {
          setActiveLeadDetail(null);
          setBattlecardTarget({ entity: lead, type: "CUSTOMER" });
        }}
      />

      <InvestorDetailModal
        investor={activeInvestorDetail}
        conversations={conversations}
        onClose={() => setActiveInvestorDetail(null)}
        onOpenScoreWhy={handleOpenScoreWhy}
        onBookMeeting={handleBookMeeting}
        onSendReply={handleSendInboxReply}
        onOpenPitchSimulator={(inv) => {
          setActiveInvestorDetail(null);
          setPitchSimulatorTarget({ entity: inv, type: "INVESTOR" });
        }}
        onOpenBattlecard={(inv) => {
          setActiveInvestorDetail(null);
          setBattlecardTarget({ entity: inv, type: "INVESTOR" });
        }}
      />

      <PartnerDetailModal
        partner={activePartnerDetail}
        conversations={conversations}
        onClose={() => setActivePartnerDetail(null)}
        onOpenScoreWhy={handleOpenScoreWhy}
        onBookMeeting={handleBookMeeting}
        onSendReply={handleSendInboxReply}
      />

      {pitchSimulatorTarget && (
        <PitchSimulatorModal
          isOpen={!!pitchSimulatorTarget}
          onClose={() => setPitchSimulatorTarget(null)}
          entity={pitchSimulatorTarget.entity}
          type={pitchSimulatorTarget.type}
          companyBrain={companyBrain}
        />
      )}

      {battlecardTarget && (
        <LiveMeetingBattlecardModal
          isOpen={!!battlecardTarget}
          onClose={() => setBattlecardTarget(null)}
          entity={battlecardTarget.entity}
          type={battlecardTarget.type}
          companyBrain={companyBrain}
          onScheduleCall={() => {
            const target = battlecardTarget.entity;
            setBattlecardTarget(null);
            handleBookMeeting(target);
          }}
        />
      )}

      <CampaignWizardModal
        isOpen={newCampaignOpen}
        onClose={() => setNewCampaignOpen(false)}
        onCampaignCreated={(camp) => {
          setCampaigns((prev) => [camp, ...prev]);
          setCurrentTab("campaigns");
        }}
      />

      <NewOpportunityModal
        isOpen={newOpportunityOpen}
        onClose={() => setNewOpportunityOpen(false)}
        onOpportunityCreated={(opp) => {
          setOpportunities((prev) => [opp, ...prev]);
          setKpis((prev) => ({ ...prev, pipelineValue: prev.pipelineValue + (opp.estimatedValue || 0) }));
        }}
      />

      <AddLeadModal
        isOpen={addLeadOpen}
        onClose={() => setAddLeadOpen(false)}
        onLeadCreated={(lead) => {
          setLeads((prev) => [lead, ...prev]);
          setKpis((prev) => ({ ...prev, qualifiedLeads: prev.qualifiedLeads + 1 }));
        }}
      />

      <DiscoverLeadsModal
        isOpen={discoverLeadsOpen}
        onClose={() => setDiscoverLeadsOpen(false)}
        onLeadsDiscovered={(newLeads) => {
          setLeads((prev) => {
            const existingIds = new Set(prev.map((l) => l.id));
            const fresh = newLeads.filter((l) => !existingIds.has(l.id));
            return [...fresh, ...prev];
          });
          setKpis((prev) => ({ ...prev, qualifiedLeads: prev.qualifiedLeads + newLeads.length }));
        }}
      />

      <AddInvestorModal
        isOpen={addInvestorOpen}
        onClose={() => setAddInvestorOpen(false)}
        onInvestorCreated={(inv) => {
          setInvestors((prev) => [inv, ...prev]);
        }}
      />

      <DiscoverInvestorsModal
        isOpen={discoverInvestorsOpen}
        onClose={() => setDiscoverInvestorsOpen(false)}
        onInvestorsDiscovered={(newInvestors) => {
          setInvestors((prev) => {
            const existingIds = new Set(prev.map((i) => i.id));
            const fresh = newInvestors.filter((i) => !existingIds.has(i.id));
            return [...fresh, ...prev];
          });
        }}
      />

      <AddPartnerModal
        isOpen={addPartnerOpen}
        onClose={() => setAddPartnerOpen(false)}
        onPartnerCreated={(partner) => {
          setPartners((prev) => [partner, ...prev]);
        }}
      />

      <DiscoverPartnersModal
        isOpen={discoverPartnersOpen}
        onClose={() => setDiscoverPartnersOpen(false)}
        onPartnersDiscovered={(newPartners) => {
          setPartners((prev) => {
            const existingIds = new Set(prev.map((p) => p.id));
            const fresh = newPartners.filter((p) => !existingIds.has(p.id));
            return [...fresh, ...prev];
          });
        }}
      />

      <ScheduleMeetingModal
        isOpen={scheduleMeetingOpen}
        onClose={() => setScheduleMeetingOpen(false)}
        initialData={scheduleMeetingInitialData}
        onMeetingScheduled={(meeting) => {
          setMeetings((prev) => [meeting, ...prev]);
          setKpis((prev) => ({ ...prev, meetingsBooked: prev.meetingsBooked + 1 }));
          setCurrentTab("meetings");
        }}
      />

      <OnboardingModal
        isOpen={onboardingOpen}
        onClose={() => setOnboardingOpen(false)}
        initialBrain={companyBrain}
        onSaveBrain={(newBrain) => setCompanyBrain(newBrain)}
      />
    </div>
  );
}

export default App;
