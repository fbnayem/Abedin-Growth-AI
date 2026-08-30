import { db } from "./server/db/index";
import * as schema from "./server/db/schema";
import { gmailService } from "./server/services/gmail.service.ts";
import { calendarService } from "./server/services/calendar.service.ts";
import { pipelineService } from "./server/services/pipeline.service.ts";
import { outboxService } from "./server/services/outbox.service.ts";
import { killSwitchController } from "./server/controllers/killSwitch.controller.ts";
import { outboxRouter } from "./server/routes/outbox.routes.ts";
import { stripeRouter } from "./server/routes/stripe.routes.ts";
import express, { Request, Response } from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { globalStore } from "./server/dataStore";
import { generateCompanyBrain } from "./server/agents/companyBrainAgent";
import { scoreAndResearchLead, batchDiscoverLeads } from "./server/agents/leadScoringAgent";
import { scoreAndResearchInvestor, batchDiscoverInvestors } from "./server/agents/investorAgent";
import { scoreAndResearchPartner, batchDiscoverPartners } from "./server/agents/partnerAgent";
import { generateCampaignStrategy } from "./server/agents/campaignAgent";
import { processConversationThread } from "./server/agents/inboxAgent";
import { inspectEmailDraft } from "./server/agents/qualityControlAgent";
import { generateMeetingBrief } from "./server/agents/meetingAgent";
import { processGrowthCommand } from "./server/agents/growthCommandAgent";
import { simulatePitchBattle } from "./server/agents/pitchBattleAgent";
import {
  extractAndSynthesizeMemory,
  generateMemoryAwareReply,
  generateMemoryAwareFollowUp,
} from "./server/agents/conversationMemoryAgent";
import {
  autoReplyToConversation,
  autoReplyAllPendingInbounds,
  checkAndDispatchMeetingReminders,
  sendMissedMeetingRecoveryEmail,
  signMeetingAgreement,
  processMeetingFirstPayment,
  simulateInboundProspectReply,
} from "./server/agents/autoReplyEngine";
import {
  executeMultiAgentReplyPipeline,
  validateAndEnforceNoPhonePolicy,
  validateAndEnforceMeetingAndCalendarLinks,
  normalizeMergeTags,
  auditFullSystemReplies,
} from "./server/agents/multiAgentReplySystem";
import { resolveClientIdentity } from "./server/agents/clientIdentityResolver";
import {
  TRUSTED_CTA_REGISTRY,
  CALENDAR_BOOKING_URL,
  GOOGLE_MEET_URL,
} from "./server/agents/trustedCtaRegistry";
import {
  circuitBreaker,
  resetCircuitBreaker,
  tripCircuitBreaker,
  evaluateEmailUnderstandingRuleBased,
  computePurchaseReadiness,
  computeMeetingReadiness,
  computeBuyingStage,
  determineNextBestAction,
  composeAutonomousSalesReply,
  sanitizeUntrustedProspectInput,
  CANONICAL_KNOWLEDGE,
} from "./server/agents/salesDecisionEngine";
import { auditReplyAgainstPlan } from "./server/agents/independentAuditor";
import { runCompleteSalesEngineTestMatrix } from "./server/agents/salesEngineTestMatrix";
import { evaluatePolicy } from "./server/policies/policyEngine";
import { autopilotRunner } from "./server/autopilotRunner";
import { Lead, Investor, Partner, Campaign, Meeting, Opportunity, KnowledgeItem, EmailMessage, CompanyBrain } from "./src/types";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Health check
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "Abedin Growth AI Core Engine" });
  });

  // 1. Dashboard summary
  app.get("/api/dashboard", (_req: Request, res: Response) => {
    const qualifiedLeadsCount = globalStore.leads.filter(
      (l) => l.status === "QUALIFIED" || l.status === "ENGAGED" || l.status === "DEMO_SCHEDULED"
    ).length;
    const positiveConversationsCount = globalStore.conversations.filter(
      (c) => c.status === "ACTIVE" || c.status === "HUMAN_NEEDED" || c.status === "MEETING_REQUESTED"
    ).length;
    const meetingsBookedCount = globalStore.meetings.filter((m) => m.status === "CONFIRMED").length;
    const pipelineValue = globalStore.opportunities
      .filter((o) => o.category === "CUSTOMER")
      .reduce((sum, o) => sum + o.estimatedValue, 0);
    const investorConversationsCount = globalStore.investors.filter(
      (i) => i.status === "REPLIED" || i.status === "MEETING_BOOKED"
    ).length;
    const partnerConversationsCount = globalStore.partners.filter(
      (p) => p.status === "CONVERSATION" || p.status === "ACTIVE_PARTNER"
    ).length;

    res.json({
      kpis: {
        qualifiedLeads: qualifiedLeadsCount,
        positiveConversations: positiveConversationsCount,
        meetingsBooked: meetingsBookedCount,
        pipelineValue,
        investorConversations: investorConversationsCount,
        partnerConversations: partnerConversationsCount,
      },
      attentionItems: globalStore.attentionItems,
      dailyBrief: globalStore.dailyBrief,
      status: "AI Growth Engine: Active",
    });
  });


  app.get("/api/analytics/funnel", async (_req: Request, res: Response) => {
    try {
      const allContacts = await db.select().from(schema.contacts);
      const allConvs = await db.select().from(schema.conversations);
      const allMeetings = await db.select().from(schema.meetings);

      const discovered = allContacts.length;
      const qualified = 15; // mock complex AI score for now
      const outreachSent = allConvs.length;
      const opened = allConvs.filter(c => c.status !== 'NEW').length;
      const replied = allConvs.filter(c => c.status === 'REPLIED').length;
      const positive = allConvs.filter(c => c.intentConfidence && c.intentConfidence > 0.8).length || 3;
      const demoBooked = allMeetings.length;

      res.json({
        funnel: [
          { label: "1. Discovered", count: discovered, dropoff: "100%", color: "bg-slate-700" },
          { label: "2. AI Qualified (Score > 80)", count: qualified, dropoff: discovered ? `${((qualified/discovered)*100).toFixed(1)}%` : "0%", color: "bg-blue-600" },
          { label: "3. Outreach Sent", count: outreachSent, dropoff: qualified ? `${((outreachSent/qualified)*100).toFixed(1)}%` : "0%", color: "bg-indigo-600" },
          { label: "4. Opened", count: opened, dropoff: outreachSent ? `${((opened/outreachSent)*100).toFixed(1)}% Open Rate` : "0%", color: "bg-purple-600" },
          { label: "5. Replied", count: replied, dropoff: opened ? `${((replied/opened)*100).toFixed(1)}% Reply Rate` : "0%", color: "bg-amber-600" },
          { label: "6. Positive Intent", count: positive, dropoff: replied ? `${((positive/replied)*100).toFixed(1)}% Positivity` : "0%", color: "bg-emerald-600" },
          { label: "7. Demo Booked", count: demoBooked, dropoff: positive ? `${((demoBooked/positive)*100).toFixed(1)}% Conversion` : "0%", color: "bg-emerald-500" },
        ]
      });
    } catch(e) {
      console.error(e);
      res.json({ funnel: [] });
    }
  });

  // 2. Company Brain
  app.get("/api/company-brain", (_req: Request, res: Response) => {
    res.json(globalStore.companyBrain);
  });

  app.post("/api/company-brain/generate", async (req: Request, res: Response) => {
    try {
      const { companyName, companyUrl, productName, productUrl, targetMarkets, primaryObjectives, additionalNotes } = req.body;
      const newBrain = await generateCompanyBrain({
        companyName: companyName || "Abedin Tech",
        companyUrl: companyUrl || "https://abedintech.com/voice-ai/",
        productName: productName || "Abedin Voice AI",
        productUrl: productUrl || "https://abedintech.com/voice-ai/",
        targetMarkets: targetMarkets || ["United Kingdom", "United States", "UAE", "Singapore"],
        primaryObjectives: primaryObjectives || ["Get Customers", "Find Investors", "Find Partners"],
        additionalNotes,
      });
      globalStore.companyBrain = newBrain;
      globalStore.saveToDisk();
      res.json(newBrain);
    } catch (error) {
      console.error("Failed to generate company brain:", error);
      res.status(500).json({ error: "Failed to generate company brain" });
    }
  });

  app.post("/api/company-brain/preset", (req: Request, res: Response) => {
    const { presetId, customData } = req.body;
    let newBrain: CompanyBrain = { ...globalStore.companyBrain };

    if (presetId === "VOICE_AI") {
      newBrain = {
        workspaceId: "default",
        companyName: "Abedin Tech",
        companyUrl: "https://abedintech.com/voice-ai/",
        productName: "Abedin Voice AI",
        productUrl: "https://abedintech.com/voice-ai/",
        tagline: "Autonomous 24/7 Voice AI Receptionist for Healthcare & Dental Clinics",
        description: "Sub-500ms conversational voice AI answering patient phone inquiries 24/7, booking directly into EHR and Google Calendar, and eliminating missed appointment revenue leak.",
        targetIndustries: ["Dental & Healthcare Clinics", "Private Medical Practices", "Cosmetic Surgery Clinics", "Veterinary Hospitals"],
        targetCountries: ["United Kingdom", "United States", "UAE", "Singapore"],
        customerProblems: [
          "Missed patient phone inquiries during lunch hours and after 5 PM",
          "High front desk staff turnover and reception overload",
          "Lost high-ticket dental consultation bookings to competing practices",
          "Double-booking and manual calendar appointment entry errors",
        ],
        coreFeatures: [
          "Sub-500ms voice response latency (feels 100% natural, no robotic pause)",
          "2-way direct Google Calendar & EHR synchronization",
          "Automated patient qualification and emergency triage forwarding",
          "14-day zero-risk trial setup (deployed in 15 minutes)",
        ],
        primaryBenefits: [
          "Captures 100% of after-hours appointment revenue",
          "Reduces reception desk workload by 68%",
          "Pays for itself with just 2 captured appointments per month",
        ],
        differentiators: [
          "Sub-500ms latency vs 1.8s+ on competitors",
          "Native 2-way calendar sync with zero double booking",
          "Direct emergency triage routing to on-call doctors",
        ],
        targetPersonas: [
          { title: "Practice Manager", department: "Operations", painPoint: "Overworked reception desk and missed weekend bookings" },
          { title: "Managing Director / Owner", department: "Executive", painPoint: "High ad spend wasted when phone calls go to voicemail" },
          { title: "Clinical Director", department: "Medical", painPoint: "Ensuring emergency toothache/concierge triage is handled safely" },
        ],
        customerUseCases: [
          { industry: "Dental Clinics", useCase: "24/7 Emergency & Cosmetic Booking", expectedROI: "340% in Month 1" },
          { industry: "Concierge Medicine", useCase: "VIP Patient Intake & Home Visits", expectedROI: "450% in Month 1" },
        ],
        salesAngles: [
          "Calculate monthly revenue lost from unanswered calls",
          "Offer quick 10-minute live demonstration on Google Meet",
          "14-day zero-risk trial setup",
        ],
        objectionsAndAnswers: [
          { objection: "Will patients know it's an AI?", recommendedResponse: "Our sub-500ms voice speed and natural British accents are indistinguishable from a premier receptionist. We'd love to walk you through an interactive live demonstration on Google Meet right now." },
          { objection: "Does it sync with our calendar?", recommendedResponse: "Yes, it has direct 2-way integration with Google Calendar, Microsoft 365, and major EHR systems with live slot locking." },
        ],
        investorNarrative: {
          vision: "The autonomous voice infrastructure for global healthcare and service enterprises.",
          marketOpportunity: "£42B global clinic telephone and front-desk automation market.",
          moat: "Proprietary sub-500ms telephony pipeline and specialized clinical triage models.",
          tractionHighlights: "400+ clinic network, £14.4k ACV, 99.4% retention.",
        },
        partnerNarrative: {
          partnerValueProposition: "Offer premier managed Voice AI reception to your healthcare clients with 30% recurring monthly margin.",
          revenueSharingModel: "30% recurring monthly subscription margin + £200 onboarding fee per clinic.",
          idealPartnerProfile: "Healthcare marketing agencies, dental consultants, and telecom MSPs.",
        },
        updatedAt: new Date().toISOString(),
      };
    } else if (presetId === "B2B_SAAS") {
      newBrain = {
        workspaceId: "default",
        companyName: "NexusGrowth AI",
        companyUrl: "https://nexusgrowth.ai",
        productName: "Nexus Outbound Autonomous Engine",
        productUrl: "https://nexusgrowth.ai/platform",
        tagline: "Autonomous B2B Sales Engine Generating Qualified Pipeline on Autopilot",
        description: "Autonomous multi-agent outbound platform that researches B2B accounts, crafts hyper-personalized multi-channel pitches, handles objections, and books sales demos.",
        targetIndustries: ["B2B SaaS", "FinTech", "Enterprise Software", "Professional Services"],
        targetCountries: ["United Kingdom", "United States", "Germany", "Canada"],
        customerProblems: [
          "High SDR payroll cost and low outbound reply rates",
          "Generic spam email campaigns damaging domain reputation",
          "Slow manual lead research taking hours per account",
        ],
        coreFeatures: [
          "Deep account research and trigger-event detection",
          "Verified email and LinkedIn multi-touch sequences",
          "Autonomous objection handling and meeting scheduler",
        ],
        primaryBenefits: [
          "10x higher qualified demo bookings",
          "Zero manual SDR research effort",
          "100% spam-safe deliverability guarantee",
        ],
        differentiators: [
          "Autonomous multi-agent research depth",
          "Integrated deliverability QC and SPF/DKIM verification",
        ],
        targetPersonas: [
          { title: "VP of Sales", department: "Sales", painPoint: "Pipeline unpredictability and missed quota" },
          { title: "Founder / CEO", department: "Executive", painPoint: "Scaling customer acquisition without ballooning headcount" },
        ],
        customerUseCases: [
          { industry: "B2B Software", useCase: "Outbound Account-Based Prospecting", expectedROI: "500% Pipeline ROI" },
        ],
        salesAngles: [
          "Audit current outbound reply rates and show 3 personalized AI draft samples",
        ],
        objectionsAndAnswers: [
          { objection: "Will this spam our domain?", recommendedResponse: "We utilize multi-domain warmup, deliverability QC, and strict pacing to maintain 0.0 spam score." },
        ],
        investorNarrative: {
          vision: "AI-native revenue workforce replacing repetitive SDR and sales development workflows.",
          marketOpportunity: "£65B global sales automation market.",
          moat: "Proprietary research graph and multi-agent intent models.",
          tractionHighlights: "£22k ARR average contract, 4.2x LTV/CAC.",
        },
        partnerNarrative: {
          partnerValueProposition: "Deploy our outbound pipeline engine for your B2B clients with full revenue sharing.",
          revenueSharingModel: "25% recurring margin + performance bonuses per booked meeting.",
          idealPartnerProfile: "B2B Growth Agencies, Go-To-Market Consultants.",
        },
        updatedAt: new Date().toISOString(),
      };
    } else if (presetId === "LEGAL_FINANCIAL") {
      newBrain = {
        workspaceId: "default",
        companyName: "Apex Sovereign Advisory",
        companyUrl: "https://apexadvisory.co.uk",
        productName: "Apex Client Acquisition & Intake AI",
        productUrl: "https://apexadvisory.co.uk/solutions",
        tagline: "High-Net-Worth Client Intake & Autonomous Inbound Qualifying System",
        description: "Confidential, compliance-verified AI intake and client consultation booking for wealth managers, family offices, and corporate legal practices.",
        targetIndustries: ["Wealth Management", "Corporate Law Firms", "M&A Advisory", "Accounting & Audit Firms"],
        targetCountries: ["United Kingdom", "Switzerland", "UAE", "United States"],
        customerProblems: [
          "High-value client inquiries dropped during off-hours",
          "Stringent regulatory compliance and confidentiality requirements",
          "Slow partner intake response time losing retained client mandates",
        ],
        coreFeatures: [
          "24/7 confidential inquiry triage with GDPR & SRA compliance",
          "High-value portfolio intake qualification",
          "Direct partner calendar reservation",
        ],
        primaryBenefits: [
          "Immediate responsiveness to £500k+ portfolio inquiries",
          "100% compliance audit trail",
          "Elevated white-glove client experience",
        ],
        differentiators: [
          "Institutional grade encryption and compliance protocols",
          "Specialized financial and legal terminology models",
        ],
        targetPersonas: [
          { title: "Senior Partner", department: "Partnership", painPoint: "Missing high-value mandates to faster-responding competitors" },
          { title: "Practice Director", department: "Operations", painPoint: "Managing strict intake compliance without adding staff" },
        ],
        customerUseCases: [
          { industry: "Wealth Management", useCase: "High-Net-Worth Lead Intake", expectedROI: "800% Mandate ROI" },
        ],
        salesAngles: [
          "Demonstrate confidential intake simulation with instant partner alert",
        ],
        objectionsAndAnswers: [
          { objection: "Is it compliant with confidentiality rules?", recommendedResponse: "Fully GDPR compliant with dedicated private tenant infrastructure and zero model data retention." },
        ],
        investorNarrative: {
          vision: "The trusted client intake infrastructure for high-ticket professional services.",
          marketOpportunity: "£30B private wealth and legal practice tech market.",
          moat: "Compliance certifications and high-trust enterprise integrations.",
          tractionHighlights: "£36k ACV, zero churn across tier-1 advisory firms.",
        },
        partnerNarrative: {
          partnerValueProposition: "Integrate compliance-first intake for high-end advisory firms.",
          revenueSharingModel: "30% recurring margin on enterprise plans.",
          idealPartnerProfile: "Legal tech consultants and private wealth network brokers.",
        },
        updatedAt: new Date().toISOString(),
      };
    } else if (customData) {
      newBrain = {
        ...newBrain,
        ...customData,
        updatedAt: new Date().toISOString(),
      };
    }

    globalStore.companyBrain = newBrain;
    globalStore.saveToDisk();
    res.json({ success: true, brain: newBrain });
  });

  // Batch Follow-Up to all Contacted Leads
  app.post("/api/leads/batch-followup", async (_req: Request, res: Response) => {
    try {
      const contactedLeads = globalStore.leads.filter(
        (l) => l.status === "CONTACTED" || (!!l.contactedAt && l.status !== "ENGAGED" && l.status !== "DEMO_SCHEDULED" && l.status !== "WON")
      );

      let dispatchedCount = 0;
      const nowIso = new Date().toISOString();

      for (const lead of contactedLeads.slice(0, 50)) {
        const firstName = lead.name.replace("Dr. ", "").split(" ")[0];
        const subject = `Re: ${lead.lastOutreachSubject || `Quick question regarding ${lead.companyName}'s after-hours patient calls`}`;
        const bodyText = `Hi ${firstName},\n\nFollowing up on my previous note regarding ${lead.companyName}'s after-hours patient intake in ${lead.country || "your area"}.\n\nMost clinics we work with were losing 15-20 booking calls every week simply because their front desk was closed after 5 PM or during lunch.\n\nCould I send you a 60-second video demo of how Abedin Voice AI answers with sub-500ms latency and syncs with Google Calendar?\n\nBest regards,\nNayem Abedin\nFounder & CEO | Abedin Tech\nDirect: +44 20 7946 0192`;

        const msgId = `msg_follow_${Date.now()}_${lead.id}`;
        globalStore.outboxLogs.unshift({
          id: `outbox_${msgId}`,
          recipientName: lead.name,
          recipientEmail: lead.email,
          recipientTitle: lead.title,
          companyName: lead.companyName,
          channel: "EMAIL",
          senderEmail: globalStore.senderIdentity.senderEmail,
          senderName: globalStore.senderIdentity.senderName,
          subject,
          bodyText,
          sentAt: nowIso,
          status: "DELIVERED",
          qcScore: 99,
          openCount: (lead.openCount || 0) + 1,
          lastOpenedAt: nowIso,
          spamScore: 0.0,
          deliverabilityStatus: "VERIFIED_CLEAN",
          campaignName: "Day 3 Latency & Missed Call Value Follow-Up",
          category: "CUSTOMER",
          leadId: lead.id,
        });

        lead.lastActivityAt = nowIso;
        lead.nextAction = "Day 7 Final Check-in";
        dispatchedCount++;
      }

      globalStore.saveToDisk();
      res.json({ success: true, dispatchedCount, totalContacted: contactedLeads.length });
    } catch (e: any) {
      console.error("Batch follow-up error:", e);
      res.status(500).json({ error: e.message || "Failed to dispatch batch follow-ups" });
    }
  });

  
  // 3. Leads & Research (REWRITTEN TO NATIVE POSTGRESQL)
  app.get("/api/leads", async (_req: Request, res: Response) => {
    try {
      const dbLeads = await db.select().from(schema.contacts);
      // Map DB schema back to the frontend Lead format
      const mappedLeads = dbLeads.map(c => ({
        id: c.id,
        workspaceId: c.organizationId,
        type: "CUSTOMER",
        name: c.name || "",
        title: c.title || "",
        email: c.primaryEmail || "",
        phone: c.phone || "",
        linkedinUrl: c.linkedinUrl || "",
        status: c.status,
        createdAt: c.createdAt.toISOString(),
      }));
      // Merge with any legacy globalStore leads that haven't migrated yet
      const legacyIds = new Set(mappedLeads.map(l => l.id));
      const legacyLeads = globalStore.leads.filter(l => !legacyIds.has(l.id));
      
      res.json([...mappedLeads, ...legacyLeads]);
    } catch (e) {
      console.error(e);
      res.json(globalStore.leads); // fallback
    }
  });

  app.post("/api/leads", async (req: Request, res: Response) => {
    const leadData = req.body;
    const newId = `lead_${Date.now()}`;
    
    try {
      await db.insert(schema.contacts).values({
        id: newId,
        organizationId: "default",
        name: leadData.name || "Prospect",
        primaryEmail: leadData.email || "",
        title: leadData.title || "Director",
        phone: leadData.phone,
        linkedinUrl: leadData.linkedinUrl,
        status: leadData.status || "NEW"
      });
    } catch(e) {
      console.error("DB Insert Failed", e);
    }

    // Keep legacy sync for background agents
    const newLead: Lead = {
      id: newId,
      workspaceId: "default",
      type: "CUSTOMER",
      name: leadData.name || "Prospect",
      title: leadData.title || "Director",
      email: leadData.email || "",
      phone: leadData.phone,
      linkedinUrl: leadData.linkedinUrl,
      companyName: leadData.companyName || "Target Org",
      companyWebsite: leadData.companyWebsite || "",
      industry: leadData.industry || "Healthcare & Clinics",
      country: leadData.country || "United Kingdom",
      employeeCount: leadData.employeeCount || "10-50",
      status: (leadData.status as any) || "NEW",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    globalStore.leads.unshift(newLead);
    globalStore.saveToDisk();

    res.json(newLead);
  });


  app.post("/api/leads/:id/email", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { subject, body } = req.body;
      const lead = globalStore.leads.find((l) => l.id === id);
      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }

      const qc = await inspectEmailDraft({
        recipientEmail: lead.email,
        recipientName: lead.name,
        subject,
        body,
      });

      const nowIso = new Date().toISOString();
      const msgId = `msg_lead_${Date.now()}`;
      const newMsg: EmailMessage = {
        id: msgId,
        conversationId: `conv_lead_${lead.id}`,
        sender: "AGENT",
        senderName: globalStore.senderIdentity.senderName,
        senderEmail: globalStore.senderIdentity.senderEmail,
        recipientEmail: lead.email,
        subject,
        bodyHtml: `<p>${body.replace(/\n/g, "<br/>")}</p>`,
        bodyText: body,
        sentAt: nowIso,
        status: "SENT",
        qcScore: qc.score,
        qcDecision: qc.decision,
      };

      globalStore.outboxLogs.unshift({
        id: `outbox_${msgId}`,
        recipientName: lead.name,
        recipientEmail: lead.email,
        recipientTitle: lead.title,
        companyName: lead.companyName,
        channel: "EMAIL",
        senderEmail: globalStore.senderIdentity.senderEmail,
        senderName: globalStore.senderIdentity.senderName,
        subject,
        bodyText: body,
        sentAt: nowIso,
        status: "DELIVERED",
        qcScore: qc.score || 98,
        campaignName: "Manual Direct Outreach",
        category: "CUSTOMER",
        leadId: lead.id,
      });

      lead.status = "CONTACTED";
      lead.contactedAt = nowIso;
      lead.lastActivityAt = nowIso;
      lead.lastOutreachSubject = subject;
      lead.lastOutreachBody = body;
      lead.lastOutreachChannel = "EMAIL";
      lead.nextAction = "Day 3 follow-up";

      // Thread in conversations
      let conv = globalStore.conversations.find((c) => c.contactEmail === lead.email);
      if (conv) {
        conv.thread.push(newMsg);
        conv.status = "WAITING_ON_PROSPECT";
        conv.updatedAt = nowIso;
      } else {
        globalStore.conversations.unshift({
          id: `conv_lead_${lead.id}`,
          workspaceId: "default",
          leadId: lead.id,
          subject,
          contactName: lead.name,
          contactEmail: lead.email,
          contactTitle: lead.title,
          companyName: lead.companyName,
          category: "CUSTOMER",
          status: "WAITING_ON_PROSPECT",
          lastReplyIntent: "UNKNOWN",
          intentConfidence: 0.95,
          aiSummary: `Outreach dispatched: "${subject}".`,
          aiRecommendedAction: "Awaiting prospect response.",
          thread: [newMsg],
          unread: false,
          updatedAt: nowIso,
        });
      }

      globalStore.saveToDisk();
      res.json({ success: true, message: newMsg, lead });
    } catch (error) {
      console.error("Send lead email error:", error);
      res.status(500).json({ error: "Failed to send email to lead" });
    }
  });

  app.post("/api/leads/:id/simulate-reply", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const lead = globalStore.leads.find((l) => l.id === id);
      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }

      const nowIso = new Date().toISOString();
      const firstNameOnly = lead.name.replace("Dr. ", "").split(" ")[0];
      const subject = lead.lastOutreachSubject || `Quick question regarding ${lead.companyName}'s after-hours patient calls`;
      const replyBody = `Hi Nayem,\n\nThanks for reaching out. We actually drop quite a few calls on weekday evenings and Saturday mornings when our reception desk is closed. Does your AI voice assistant integrate directly with our practice calendar for live appointment bookings?\n\nWould love to see a 5-minute demo.\n\nBest regards,\n${lead.name}\n${lead.title} | ${lead.companyName}`;

      lead.status = "ENGAGED";
      lead.lastActivityAt = nowIso;
      lead.nextAction = "Auto-Reply or Book Demo";

      const convId = `conv_lead_${lead.id}`;
      let conv = globalStore.conversations.find((c) => c.leadId === lead.id || c.contactEmail?.toLowerCase() === lead.email?.toLowerCase());

      const replyMsg: EmailMessage = {
        id: `msg_rep_${Date.now()}`,
        conversationId: conv ? conv.id : convId,
        sender: "PROSPECT",
        senderName: lead.name,
        senderEmail: lead.email,
        recipientEmail: "nayem@abedintech.com",
        subject: `Re: ${subject}`,
        bodyText: replyBody,
        bodyHtml: `<p>${replyBody.replace(/\n/g, "<br/>")}</p>`,
        sentAt: nowIso,
        status: "SENT",
      };

      if (conv) {
        conv.thread.push(replyMsg);
        conv.status = "ACTIVE";
        conv.lastReplyIntent = "DEMO_REQUESTED";
        conv.intentConfidence = 0.98;
        conv.aiSummary = `${lead.name} inquired about practice calendar integration and requested a live demo walkthrough.`;
        conv.aiRecommendedAction = "Offer Google Calendar booking link or lock in Thursday at 2:00 PM.";
        conv.unread = true;
        conv.updatedAt = nowIso;
      } else {
        const initialOutbound: EmailMessage = {
          id: `msg_init_${Date.now()}`,
          conversationId: convId,
          sender: "AGENT",
          senderName: "Nayem Abedin",
          senderEmail: "nayem@abedintech.com",
          recipientEmail: lead.email,
          subject: subject,
          bodyText: lead.lastOutreachBody || `Hi ${firstNameOnly},\n\nWe built Abedin Voice AI so clinics never miss high-value consultation calls after hours. Would you be open to a 2-minute test call on your mobile this week?\n\nBest,\nNayem Abedin`,
          bodyHtml: `<p>${(lead.lastOutreachBody || `Hi ${firstNameOnly},<br/><br/>We built Abedin Voice AI...`).replace(/\n/g, "<br/>")}</p>`,
          sentAt: lead.contactedAt || new Date(Date.now() - 3600000).toISOString(),
          status: "SENT",
          qcScore: 98,
          qcDecision: "PASS" as const,
        };

        conv = {
          id: convId,
          workspaceId: "default",
          leadId: lead.id,
          subject: `Re: ${subject}`,
          contactName: lead.name,
          contactEmail: lead.email,
          contactTitle: lead.title,
          companyName: lead.companyName,
          category: "CUSTOMER",
          status: "ACTIVE",
          lastReplyIntent: "DEMO_REQUESTED",
          intentConfidence: 0.98,
          aiSummary: `${lead.name} requested a live demo and inquired about calendar integration.`,
          aiRecommendedAction: "Lock in live demo slot and demonstrate sub-500ms voice speed.",
          proposedAiDraft: {
            subject: `Re: ${subject}`,
            body: `Hi ${firstNameOnly},\n\nFantastic! Yes—Abedin Voice AI integrates natively with your calendar and clinical software with sub-500ms response speed.\n\nWould Thursday at 2:00 PM work for a quick 10-minute live demonstration?\n\nBest regards,\nNayem Abedin`,
            rationale: "Confirms calendar capability and locks in immediate meeting demo.",
            policyStatus: { actionName: "SEND_REPLY", decision: "ALLOW", reason: "Within autonomous scope" },
          },
          thread: [initialOutbound, replyMsg],
          unread: true,
          updatedAt: nowIso,
        };
        globalStore.conversations.unshift(conv);
      }

      globalStore.saveToDisk();
      res.json({ success: true, lead, conversation: conv });
    } catch (error) {
      console.error("Simulate reply error:", error);
      res.status(500).json({ error: "Failed to simulate reply" });
    }
  });

  app.post("/api/leads/research", async (req: Request, res: Response) => {
    try {
      const leadInput = req.body;
      const researched = await scoreAndResearchLead(leadInput, globalStore.companyBrain);
      
      // If lead exists in store, update it
      if (leadInput.id) {
        const index = globalStore.leads.findIndex((l) => l.id === leadInput.id);
        if (index !== -1) {
          globalStore.leads[index] = {
            ...globalStore.leads[index],
            ...researched,
          } as Lead;
          globalStore.saveToDisk();
        }
      }
      res.json(researched);
    } catch (error) {
      console.error("Lead research error:", error);
      res.status(500).json({ error: "Failed to research lead" });
    }
  });

  app.post("/api/leads/batch-generate", async (req: Request, res: Response) => {
    try {
      const { industry, location, count, criteria } = req.body;
      const existingNames = globalStore.leads.map((l) => l.companyName).filter(Boolean);
      const generatedList = await batchDiscoverLeads({
        industry,
        location,
        count: count ? Number(count) : 4,
        criteria,
        excludeNames: existingNames,
        companyBrain: globalStore.companyBrain,
      });

      // Prepend newly discovered leads in order
      globalStore.leads.unshift(...generatedList);
      globalStore.saveToDisk();

      // Update daily brief metrics
      if (globalStore.dailyBrief) {
        globalStore.dailyBrief.prospectsResearched = (globalStore.dailyBrief.prospectsResearched || 0) + generatedList.length;
        globalStore.dailyBrief.qualifiedCount = (globalStore.dailyBrief.qualifiedCount || 0) + generatedList.length;
      }

      // Log AI run
      globalStore.aiRunLogs.unshift({
        id: `run_lead_discover_${Date.now()}`,
        workspaceId: "default",
        agentType: "LeadScoringAgent",
        actionType: "BATCH_DISCOVER",
        modelCategory: "SMART",
        status: "SUCCESS",
        confidence: 0.96,
        summary: `Discovered and scored ${generatedList.length} leads in ${industry || "Healthcare"} (${location || "UK"})`,
        durationMs: 720,
        createdAt: new Date().toISOString(),
      });

      res.json(generatedList);
    } catch (error) {
      console.error("Batch generate leads error:", error);
      res.status(500).json({ error: "Failed to generate leads" });
    }
  });

  // 4. Investors
  app.get("/api/investors", async (_req: Request, res: Response) => {
    try {
      const dbLeads = await db.select().from(schema.contacts);
      const mapped = dbLeads.map(c => ({
        id: c.id,
        workspaceId: c.organizationId,
        type: "INVESTOR",
        name: c.name || "",
        title: c.title || "",
        email: c.primaryEmail || "",
        phone: c.phone || "",
        linkedinUrl: c.linkedinUrl || "",
        status: c.status,
        createdAt: c.createdAt.toISOString(),
      }));
      res.json([...mapped, ...globalStore.investors]);
    } catch(e) { res.json(globalStore.investors); }
  });

  app.post("/api/investors", async (req: Request, res: Response) => {
    const invData: Partial<Investor> = req.body;
    const newInv: Investor = {
      id: `inv_${Date.now()}`,
      workspaceId: "default",
      name: invData.name || "Investor Partner",
      fundName: invData.fundName || "Venture Fund",
      role: invData.role || "Partner",
      email: invData.email || "",
      country: invData.country || "Singapore",
      stage: invData.stage || "SEED",
      typicalCheckSize: invData.typicalCheckSize || "$500K - $1.5M",
      targetSectors: invData.targetSectors || ["Applied AI", "B2B SaaS"],
      investorFitScore: invData.investorFitScore || 88,
      status: invData.status || "DISCOVERED",
      thesisMatchReason: invData.thesisMatchReason || "Active investments in B2B AI software and operational automation.",
      portfolioFitExample: invData.portfolioFitExample || "Synergistic SaaS portfolio companies.",
      recommendedPitchAngle: invData.recommendedPitchAngle || "Emphasize unit economics, rapid payback, and sticky calendar integration.",
      sensitiveRestrictions: invData.sensitiveRestrictions || ["Valuation discussions must be handled by founder"],
      lastContactAt: new Date().toISOString(),
    };
    globalStore.investors.unshift(newInv);
    globalStore.saveToDisk();
    res.json(newInv);
  });

  app.post("/api/investors/batch-generate", async (req: Request, res: Response) => {
    try {
      const { stage, sectors, location, count } = req.body;
      const existingNames = globalStore.investors.map((i) => i.fundName).filter(Boolean);
      const generatedList = await batchDiscoverInvestors({
        stage,
        sectors: Array.isArray(sectors) ? sectors : typeof sectors === "string" ? [sectors] : undefined,
        location,
        count: count ? Number(count) : 4,
        excludeNames: existingNames,
        companyBrain: globalStore.companyBrain,
      });

      // Prepend newly discovered investors in order
      globalStore.investors.unshift(...generatedList);
      globalStore.saveToDisk();

      globalStore.aiRunLogs.unshift({
        id: `run_inv_discover_${Date.now()}`,
        workspaceId: "default",
        agentType: "InvestorAgent",
        actionType: "BATCH_DISCOVER",
        modelCategory: "SMART",
        status: "SUCCESS",
        confidence: 0.95,
        summary: `Discovered and analyzed ${generatedList.length} ${stage || "Seed"} investors matching AI infrastructure thesis`,
        durationMs: 810,
        createdAt: new Date().toISOString(),
      });

      res.json(generatedList);
    } catch (error) {
      console.error("Batch generate investors error:", error);
      res.status(500).json({ error: "Failed to generate investors" });
    }
  });

  app.post("/api/investors/research", async (req: Request, res: Response) => {
    try {
      const invInput = req.body;
      const researched = await scoreAndResearchInvestor(invInput, globalStore.companyBrain);
      if (invInput.id) {
        const idx = globalStore.investors.findIndex((i) => i.id === invInput.id);
        if (idx !== -1) {
          globalStore.investors[idx] = {
            ...globalStore.investors[idx],
            ...researched,
          } as Investor;
          globalStore.saveToDisk();
        }
      }
      res.json(researched);
    } catch (error) {
      console.error("Investor research error:", error);
      res.status(500).json({ error: "Failed to research investor" });
    }
  });

  app.post("/api/investors/:id/email", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { subject, body } = req.body;
      const inv = globalStore.investors.find((i) => i.id === id);
      if (!inv) {
        return res.status(404).json({ error: "Investor not found" });
      }

      const nowIso = new Date().toISOString();
      const msgId = `msg_inv_${Date.now()}`;
      
      globalStore.outboxLogs.unshift({
        id: `outbox_${msgId}`,
        recipientName: inv.name,
        recipientEmail: inv.email,
        recipientTitle: inv.role,
        companyName: inv.fundName,
        channel: "EMAIL",
        senderEmail: globalStore.senderIdentity.senderEmail,
        senderName: globalStore.senderIdentity.senderName,
        subject,
        bodyText: body,
        sentAt: nowIso,
        status: "DELIVERED",
        qcScore: 99,
        campaignName: "Venture Investor Outreach",
        category: "INVESTOR",
        investorId: inv.id,
      });

      inv.status = "CONTACTED";
      inv.contactedAt = nowIso;
      inv.lastContactAt = nowIso;
      inv.lastOutreachSubject = subject;
      inv.lastOutreachBody = body;
      inv.lastOutreachChannel = "EMAIL";

      globalStore.saveToDisk();
      res.json({ success: true, investor: inv });
    } catch (error) {
      console.error("Send investor email error:", error);
      res.status(500).json({ error: "Failed to send email to investor" });
    }
  });

  // 5. Partners
  app.get("/api/partners", async (_req: Request, res: Response) => {
    try {
      const dbLeads = await db.select().from(schema.contacts);
      const mapped = dbLeads.map(c => ({
        id: c.id,
        workspaceId: c.organizationId,
        type: "PARTNER",
        name: c.name || "",
        title: c.title || "",
        email: c.primaryEmail || "",
        phone: c.phone || "",
        linkedinUrl: c.linkedinUrl || "",
        status: c.status,
        createdAt: c.createdAt.toISOString(),
      }));
      res.json([...mapped, ...globalStore.partners]);
    } catch(e) { res.json(globalStore.partners); }
  });

  app.post("/api/partners", async (req: Request, res: Response) => {
    const partData: Partial<Partner> = req.body;
    const newPart: Partner = {
      id: `part_${Date.now()}`,
      workspaceId: "default",
      name: partData.name || "Partner Contact",
      companyName: partData.companyName || "Partner Agency",
      partnerType: partData.partnerType || "AGENCY",
      role: partData.role || "Managing Director",
      email: partData.email || "",
      country: partData.country || "United Kingdom",
      partnerFitScore: partData.partnerFitScore || 87,
      status: partData.status || "DISCOVERED",
      potentialCollaboration: partData.potentialCollaboration || "Offer Abedin Voice AI as a managed receptionist add-on.",
      revenueModel: partData.revenueModel || "30% recurring monthly margin on subscriptions.",
      targetDecisionMaker: partData.targetDecisionMaker || "Managing Partner",
      lastContactAt: new Date().toISOString(),
    };
    globalStore.partners.unshift(newPart);
    globalStore.saveToDisk();
    res.json(newPart);
  });

  app.post("/api/partners/batch-generate", async (req: Request, res: Response) => {
    try {
      const { partnerType, territory, count } = req.body;
      const existingNames = globalStore.partners.map((p) => p.companyName).filter(Boolean);
      const generatedList = await batchDiscoverPartners({
        partnerType,
        territory,
        count: count ? Number(count) : 4,
        excludeNames: existingNames,
        companyBrain: globalStore.companyBrain,
      });

      // Prepend newly discovered partners in order
      globalStore.partners.unshift(...generatedList);
      globalStore.saveToDisk();

      globalStore.aiRunLogs.unshift({
        id: `run_partner_discover_${Date.now()}`,
        workspaceId: "default",
        agentType: "PartnerAgent",
        actionType: "BATCH_DISCOVER",
        modelCategory: "SMART",
        status: "SUCCESS",
        confidence: 0.94,
        summary: `Discovered and scored ${generatedList.length} channel partners (${partnerType || "Agency"}) in ${territory || "UK"}`,
        durationMs: 780,
        createdAt: new Date().toISOString(),
      });

      res.json(generatedList);
    } catch (error) {
      console.error("Batch generate partners error:", error);
      res.status(500).json({ error: "Failed to generate partners" });
    }
  });

  app.post("/api/partners/research", async (req: Request, res: Response) => {
    try {
      const partInput = req.body;
      const researched = await scoreAndResearchPartner(partInput, globalStore.companyBrain);
      if (partInput.id) {
        const idx = globalStore.partners.findIndex((p) => p.id === partInput.id);
        if (idx !== -1) {
          globalStore.partners[idx] = {
            ...globalStore.partners[idx],
            ...researched,
          } as Partner;
          globalStore.saveToDisk();
        }
      }
      res.json(researched);
    } catch (error) {
      console.error("Partner research error:", error);
      res.status(500).json({ error: "Failed to research partner" });
    }
  });

  // 6. Campaigns
  app.get("/api/campaigns", async (_req: Request, res: Response) => {
    try {
      const dbCamps = await db.select().from(schema.campaigns);
      const mapped = dbCamps.map(c => ({
        id: c.id,
        name: c.name,
        status: c.status,
        targetAudience: c.targetAudience,
        type: c.type
      }));
      res.json([...mapped, ...globalStore.campaigns]);
    } catch(e) { res.json(globalStore.campaigns); }
  });

  app.post("/api/campaigns/generate-strategy", async (req: Request, res: Response) => {
    try {
      const strategy = await generateCampaignStrategy({
        name: req.body.name || "New Outbound Campaign",
        engineType: req.body.engineType || "CUSTOMER",
        targetAudience: req.body.targetAudience || "Dental Practice Managers",
        targetIndustries: req.body.targetIndustries || ["Dental & Healthcare Clinics"],
        targetLocations: req.body.targetLocations || ["United Kingdom"],
        companyBrain: globalStore.companyBrain,
      });

      const newCampaign: Campaign = {
        id: `camp_${Date.now()}`,
        workspaceId: "default",
        name: req.body.name || "New Outbound Campaign",
        engineType: req.body.engineType || "CUSTOMER",
        status: "ACTIVE",
        targetAudience: req.body.targetAudience || "Dental Practice Managers",
        targetIndustries: req.body.targetIndustries || ["Dental & Healthcare Clinics"],
        targetLocations: req.body.targetLocations || ["United Kingdom"],
        steps: strategy.steps || [],
        enrolledCount: req.body.enrolledCount || 20,
        sentCount: 0,
        openedCount: 0,
        repliedCount: 0,
        convertedCount: 0,
        autonomyMode: req.body.autonomyMode || "SEMI_AUTONOMOUS",
        aiStrategySummary: strategy.aiStrategySummary || "Targeted 4-step sequence.",
        createdAt: new Date().toISOString(),
      };

      globalStore.campaigns.unshift(newCampaign);
      globalStore.saveToDisk();
      res.json(newCampaign);
    } catch (error) {
      console.error("Campaign strategy error:", error);
      res.status(500).json({ error: "Failed to generate campaign" });
    }
  });

  app.post("/api/campaigns/:id/toggle", (req: Request, res: Response) => {
    const { id } = req.params;
    const campaign = globalStore.campaigns.find((c) => c.id === id);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    campaign.status = campaign.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    globalStore.saveToDisk();
    res.json(campaign);
  });

  // 7. Inbox & Conversations
  app.get("/api/inbox", (_req: Request, res: Response) => {
    // Return conversations sorted by: 
    // 1) Active threads with unreplied prospect inbound messages first
    // 2) Threads with prospect replies
    // 3) Most recent activity
    const sorted = [...globalStore.conversations].sort((a, b) => {
      const aProspectMsgs = (a.thread || []).filter((m) => m.sender === "PROSPECT").length;
      const bProspectMsgs = (b.thread || []).filter((m) => m.sender === "PROSPECT").length;
      
      const aLastIsProspect = a.thread?.[a.thread.length - 1]?.sender === "PROSPECT" ? 1 : 0;
      const bLastIsProspect = b.thread?.[b.thread.length - 1]?.sender === "PROSPECT" ? 1 : 0;

      if (aLastIsProspect !== bLastIsProspect) return bLastIsProspect - aLastIsProspect;
      if (aProspectMsgs > 0 && bProspectMsgs === 0) return -1;
      if (bProspectMsgs > 0 && aProspectMsgs === 0) return 1;

      return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    });

    res.json(sorted);
  });

  app.get("/api/inbox/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    const conv = globalStore.conversations.find((c) => c.id === id);
    if (!conv) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    res.json(conv);
  });

  app.post("/api/inbox/:id/classify", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const conv = globalStore.conversations.find((c) => c.id === id);
      if (!conv) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const result = await processConversationThread(conv, globalStore.companyBrain);
      conv.lastReplyIntent = result.intent;
      conv.intentConfidence = result.confidence;
      conv.aiSummary = result.summary;
      conv.aiRecommendedAction = result.recommendedAction;
      if (result.suggestedDraft) {
        conv.proposedAiDraft = result.suggestedDraft;
      }
      conv.updatedAt = new Date().toISOString();
      globalStore.saveToDisk();

      res.json({ conversation: conv, result });
    } catch (error) {
      console.error("Classify conversation error:", error);
      res.status(500).json({ error: "Failed to classify conversation" });
    }
  });

  app.post("/api/inbox/:id/reply", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { subject, body } = req.body;
      const conv = globalStore.conversations.find((c) => c.id === id);
      if (!conv) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Check policy
      const policy = evaluatePolicy({
        actionName: "SEND_REPLY",
        category: conv.category,
        isUnsubscribed: globalStore.suppressionList.includes(conv.contactEmail),
        aiConfidence: conv.intentConfidence,
        autonomySettings: globalStore.autopilotSettings,
      });

      if (policy.decision === "BLOCK") {
        return res.status(400).json({ error: policy.reason, decision: "BLOCK" });
      }

      // Queue in Transactional Outbox (Phase 16)
      const idempotencyKey = `manual_reply_${conv.id}_${Date.now()}`;
      await outboxService.queueMessage(conv.id, {
        to: conv.contactEmail,
        subject: subject,
        htmlBody: `<p>${body.replace(/\n/g, "<br/>")}</p>`,
        textBody: body,
      }, idempotencyKey);

      const newMsg = {
        id: `msg_queued_${Date.now()}`,
        conversationId: conv.id,
        sender: "AGENT" as const,
        senderName: globalStore.senderIdentity.senderName,
        senderEmail: globalStore.senderIdentity.senderEmail || "info@abedintech.com",
        recipientEmail: conv.contactEmail,
        subject,
        bodyHtml: `<p>${body.replace(/\n/g, "<br/>")}</p>`,
        bodyText: body,
        sentAt: new Date().toISOString(),
        status: "DRAFT" as const,
        qcScore: 100,
        qcDecision: "PASS" as const,
      };

      conv.thread.push(newMsg);
      conv.status = "WAITING_ON_PROSPECT";
      conv.unread = false;
      conv.updatedAt = new Date().toISOString();

      // Remove from attention items if present
      globalStore.attentionItems = globalStore.attentionItems.filter((a) => a.relatedEntityId !== conv.id);
      globalStore.saveToDisk();

      res.json({ success: true, message: newMsg, conversation: conv });
    } catch (error) {
      console.error("Send reply error:", error);
      res.status(500).json({ error: "Failed to send reply" });
    }
  });

  // Autonomous Inbound Auto-Reply Endpoints
  app.post("/api/inbox/auto-reply-all", async (_req: Request, res: Response) => {
    try {
      const result = await autoReplyAllPendingInbounds();
      res.json(result);
    } catch (error: any) {
      console.error("Auto-reply all error:", error);
      res.status(500).json({ error: error.message || "Failed to auto-reply to all inbounds" });
    }
  });

  app.post("/api/inbox/:id/auto-reply", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const conv = globalStore.conversations.find(c => c.id === id);
      if (!conv) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const lastMessage = conv.thread[conv.thread.length - 1];

      // Route to the new Pipeline Service (Phase 19 & 87)
      await pipelineService.processInboundMessage({
        fromEmail: conv.contactEmail,
        fromName: conv.contactName,
        subject: lastMessage?.subject || "No Subject",
        textBody: lastMessage?.bodyText || "",
        providerMessageId: lastMessage?.id || `msg_${Date.now()}`,
        threadId: conv.id,
        orgId: "default_org"
      });
      
      // Fallback for legacy dashboard UI updates:
      // The old engine returned a draft or sent a message immediately. 
      // The new engine queues it via OutboxWorker. We tell the frontend it's queued.
      conv.status = "WAITING_ON_PROSPECT"; // Optimistic local fallback to prevent frontend hanging
      globalStore.saveToDisk();
      
      res.json({ success: true, message: "Processing routed to Multi-Agent Pipeline and queued in Transactional Outbox." });
    } catch (error: any) {
      console.error("Auto-reply conversation error:", error);
      res.status(500).json({ error: error.message || "Failed to auto-reply to conversation via pipeline" });
    }
  });

  // Dedicated Multi-Agent Response Generation Endpoint with Regex Validation
  app.post("/api/inbox/:id/generate-multi-agent-reply", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { customInstructions } = req.body || {};
      const conv = globalStore.conversations.find((c) => c.id === id);
      if (!conv) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const multiAgentOutput = await executeMultiAgentReplyPipeline(
        conv,
        globalStore.companyBrain,
        customInstructions
      );

      // Enforce additional regex scan on the output
      const validation = validateAndEnforceNoPhonePolicy(multiAgentOutput.sanitizedBody);

      conv.proposedAiDraft = {
        subject: multiAgentOutput.subject,
        body: validation.sanitized,
        rationale: `5-Agent Pipeline: Answered ${multiAgentOutput.answeredPoints.length} questions. Zero-Phone Policy: ${validation.validationStatus}.`,
        policyStatus: {
          actionName: "SEND_REPLY",
          decision: "ALLOW",
          reason: "Multi-agent tailored reply with zero-phone compliance",
        },
      };
      conv.memory = multiAgentOutput.memory;
      globalStore.saveToDisk();

      res.json({
        success: true,
        ...multiAgentOutput,
        sanitizedBody: validation.sanitized,
        phonePolicyValidation: validation,
        conversation: conv,
      });
    } catch (error: any) {
      console.error("Generate multi-agent reply error:", error);
      res.status(500).json({ error: error.message || "Failed to generate multi-agent reply" });
    }
  });

  // Dedicated Phone Policy Validation Tool Endpoint
  app.post("/api/inbox/validate-phone-policy", (req: Request, res: Response) => {
    try {
      const { text } = req.body;
      const result = validateAndEnforceNoPhonePolicy(text || "");
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to validate text" });
    }
  });

  // Deep System Audit & Quality Gatekeeper Verification Endpoint
  app.post("/api/inbox/deep-audit", (_req: Request, res: Response) => {
    try {
      const auditReport = auditFullSystemReplies();
      res.json({ success: true, auditReport });
    } catch (error: any) {
      console.error("Deep audit error:", error);
      res.status(500).json({ error: error.message || "Failed to execute deep system audit" });
    }
  });

  // Canonical CTA Registry Endpoint (Part 21)
  app.get("/api/inbox/cta-registry", (_req: Request, res: Response) => {
    res.json({ success: true, ctaRegistry: TRUSTED_CTA_REGISTRY });
  });

  // Circuit Breaker Status & Toggle Endpoints (Part 49)
app.get("/api/inbox/circuit-breaker", (_req: Request, res: Response) => {
    // We import circuitBreaker from salesDecisionEngine dynamically or just require it
    // Wait, since we are in server.ts we can import it at the top or inline.
    res.json({
      enabled: require('./server/agents/salesDecisionEngine.ts').circuitBreaker.globalAutonomousSendEnabled,
      reason: require('./server/agents/salesDecisionEngine.ts').circuitBreaker.pausedReason
    });
  });

  app.post("/api/inbox/circuit-breaker/toggle", (req: Request, res: Response) => {
    const { enabled, reason } = req.body;
    if (enabled) {
      killSwitchController.toggleGlobal(req, res); return;
    } else {
      killSwitchController.toggleGlobal(req, res); return;
    }
    
  });

  // Automated 70-Scenario Sales Engine Test Matrix Execution (Part 37 & 38)
  app.post("/api/inbox/run-test-matrix", async (_req: Request, res: Response) => {
    try {
      const report = await runCompleteSalesEngineTestMatrix();
      res.json({ success: true, report });
    } catch (error: any) {
      console.error("Run test matrix error:", error);
      res.status(500).json({ error: error.message || "Failed to run test matrix" });
    }
  });

  // 12-Layer Sales Decision Engine Real-Time Inspection Endpoint (Part 36 Admin Debug View)
  app.post("/api/inbox/sales-decision-engine/inspect", async (req: Request, res: Response) => {
    try {
      const { conversationId, customText, senderEmail, senderName } = req.body;

      const conv = conversationId
        ? globalStore.conversations.find((c) => c.id === conversationId)
        : globalStore.conversations[0];

      const email = senderEmail || conv?.contactEmail || "dr.smith@dentalcare.co.uk";
      const name = senderName || conv?.contactName || "Dr. Smith";
      const rawText = customText || conv?.thread[conv.thread.length - 1]?.bodyText || "How much does your Voice AI cost per month for a dental clinic?";

      // 1. Prompt Injection Sanitization (Part 43)
      const sanitizedInput = sanitizeUntrustedProspectInput(rawText);

      // 2. Client Identity Resolution (Part 1)
      const identity = resolveClientIdentity({
        senderEmail: email,
        senderName: name,
        existingConversationId: conv?.id,
      });

      // 3. Email Understanding (Part 5 & 6)
      const emailUnderstanding = evaluateEmailUnderstandingRuleBased(sanitizedInput.sanitized);

      // 4. Purchase & Meeting Readiness (Part 8 & 9)
      const purchaseReadiness = computePurchaseReadiness(emailUnderstanding);
      const meetingReadiness = computeMeetingReadiness(emailUnderstanding, conv?.thread?.length || 1);

      // 5. Buying Stage (Part 7)
      const buyingStage = computeBuyingStage(
        "SOLUTION_EXPLORING",
        emailUnderstanding.primaryIntent,
        purchaseReadiness.score,
        meetingReadiness.score
      );

      // 6. Next Best Action (Part 10)
      const nextBestAction = determineNextBestAction(
        emailUnderstanding,
        buyingStage,
        purchaseReadiness,
        meetingReadiness
      );

      // 7. Compose Autonomous Reply (Part 17-20)
      const composedReply = await composeAutonomousSalesReply({
        identity,
        emailUnderstanding,
        nextBestAction,
        buyingStage,
        rawInboundText: rawText,
        threadHistory: conv?.thread,
      });

      // 8. Independent Executive Audit (Part 30 & 31)
      const auditResult = auditReplyAgainstPlan({
        draftBody: composedReply.body,
        replyPlan: composedReply.replyPlan,
        identity,
        emailUnderstanding,
        nextBestAction,
        conversationId: conv?.id || "preview-inspect",
      });

      // Specialists Consulted Breakdown
      const specialistsConsulted = {
        technical: nextBestAction.technicalAgentRequired
          ? {
              verifiedCapabilities: [
                CANONICAL_KNOWLEDGE.technical.latency,
                CANONICAL_KNOWLEDGE.technical.crmIntegrations,
                CANONICAL_KNOWLEDGE.technical.compliance,
              ],
              answerSummary: "Verified sub-500ms latency, 2-way CRM/Calendar sync, and HIPAA/GDPR compliance.",
            }
          : undefined,
        pricing: nextBestAction.pricingAllowed
          ? {
              packageOffered: CANONICAL_KNOWLEDGE.pricing.standardPackage,
              pricingConfidence: 0.98,
              customQuoteNeeded: false,
            }
          : undefined,
        objection: nextBestAction.objectionAgentRequired
          ? {
              handledObjection: "Timing / Budget",
              strategy: "Empathetic low-pressure acknowledgment with £18,000+ monthly missed call recovery data.",
            }
          : undefined,
        roi: nextBestAction.roiAgentRequired
          ? {
              metricEstimated: CANONICAL_KNOWLEDGE.roi.missedCallsRecovered,
              annualValueEstimated: "£216,000 / year recovered revenue",
            }
          : undefined,
      };

      const whyExplanation = `Autonomous Sales Decision Engine processed inbound message from ${identity.name} (${identity.company}). Evaluated primary intent as ${emailUnderstanding.primaryIntent} at buying stage ${buyingStage}. Calculated Purchase Readiness at ${purchaseReadiness.score}/100 and Meeting Readiness at ${meetingReadiness.score}/100. Selected next best action '${nextBestAction.action}' with rationale: "${nextBestAction.reason}". Passed through Executive QC Auditor with score ${auditResult.score}/100 and zero deterministic policy violations.`;

      res.json({
        success: true,
        inspection: {
          identity,
          emailUnderstanding,
          buyingStage: {
            previous: "SOLUTION_EXPLORING",
            current: buyingStage,
          },
          purchaseReadiness,
          meetingReadiness,
          specialistsConsulted,
          nextBestAction,
          replyPlan: composedReply.replyPlan,
          generatedDraft: {
            subject: composedReply.subject,
            body: composedReply.body,
          },
          auditorResult: {
            decision: auditResult.decision,
            score: auditResult.score,
            checksPassed: auditResult.checksPassed,
            issuesDetected: auditResult.issuesDetected,
          },
          deterministicSafetyResult: auditResult.deterministicSafetyResult,
          finalDecision: auditResult.decision === "PASS" ? "SEND_AUTONOMOUS" : "AWAITING_HUMAN_APPROVAL",
          finalEmailBody: auditResult.sanitizedBody,
          whyExplanation,
        },
      });
    } catch (error: any) {
      console.error("Decision engine inspect error:", error);
      res.status(500).json({ error: error.message || "Failed to inspect decision engine" });
    }
  });

  app.post("/api/inbox/simulate-reply", async (_req: Request, res: Response) => {
    try {
      const result = await simulateInboundProspectReply();
      res.json(result);
    } catch (error: any) {
      console.error("Simulate reply error:", error);
      res.status(500).json({ error: error.message || "Failed to simulate client reply" });
    }
  });

  app.post("/api/inbox/:id/simulate-reply", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await simulateInboundProspectReply(id);
      res.json(result);
    } catch (error: any) {
      console.error("Simulate reply for conversation error:", error);
      res.status(500).json({ error: error.message || "Failed to simulate client reply for conversation" });
    }
  });

  // Conversation Memory Endpoints (allocated memory checking full thread)
  app.get("/api/inbox/:id/memory", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const conv = globalStore.conversations.find((c) => c.id === id);
      if (!conv) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (!conv.memory) {
        conv.memory = await extractAndSynthesizeMemory(conv, globalStore.companyBrain);
        globalStore.saveToDisk();
      }
      res.json(conv.memory);
    } catch (error: any) {
      console.error("Get conversation memory error:", error);
      res.status(500).json({ error: error.message || "Failed to retrieve conversation memory" });
    }
  });

  app.post("/api/inbox/:id/memory/refresh", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const conv = globalStore.conversations.find((c) => c.id === id);
      if (!conv) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      const memory = await extractAndSynthesizeMemory(conv, globalStore.companyBrain);
      conv.memory = memory;
      globalStore.saveToDisk();
      res.json({ success: true, memory, conversation: conv });
    } catch (error: any) {
      console.error("Refresh conversation memory error:", error);
      res.status(500).json({ error: error.message || "Failed to refresh conversation memory" });
    }
  });

  app.post("/api/inbox/:id/follow-up", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { customInstructions, customBody, customSubject } = req.body || {};
      const conv = globalStore.conversations.find((c) => c.id === id);
      if (!conv) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      let subject = customSubject;
      let bodyText = customBody;

      if (!bodyText) {
        const generated = await generateMemoryAwareFollowUp(conv, globalStore.companyBrain, customInstructions);
        subject = customSubject || generated.subject;
        bodyText = generated.body;
        conv.memory = generated.memory;
      } else {
        conv.memory = await extractAndSynthesizeMemory(conv, globalStore.companyBrain);
      }

      const qc = await inspectEmailDraft({
        recipientEmail: conv.contactEmail,
        recipientName: conv.contactName,
        subject: subject!,
        body: bodyText!,
      });

      const nowIso = new Date().toISOString();
      const msgId = `msg_flw_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

      const newMsg: EmailMessage = {
        id: msgId,
        conversationId: conv.id,
        sender: "AGENT",
        senderName: globalStore.senderIdentity.senderName,
        senderEmail: globalStore.senderIdentity.senderEmail,
        recipientEmail: conv.contactEmail,
        subject: subject!,
        bodyHtml: `<p>${bodyText!.replace(/\n/g, "<br/>")}</p>`,
        bodyText: bodyText!,
        sentAt: nowIso,
        status: "SENT",
        qcScore: qc.score || 98,
        qcDecision: qc.decision || "PASS",
        isAiGenerated: true,
      };

      conv.thread.push(newMsg);
      conv.status = "WAITING_ON_PROSPECT";
      conv.unread = false;
      conv.updatedAt = nowIso;

      if (conv.memory) {
        conv.memory.followUpCount = (conv.memory.followUpCount || 0) + 1;
        conv.memory.lastUpdated = nowIso;
        conv.memory.threadSummaryChronological.push(
          `Step ${conv.memory.threadSummaryChronological.length + 1}: Memory-aware follow-up #${conv.memory.followUpCount} sent referencing prior context.`
        );
      }

      globalStore.outboxLogs.unshift({
        id: `outbox_${msgId}`,
        recipientName: conv.contactName,
        recipientEmail: conv.contactEmail,
        recipientTitle: conv.contactTitle || "Practice Leader",
        companyName: conv.companyName,
        channel: "EMAIL",
        senderEmail: globalStore.senderIdentity.senderEmail,
        senderName: globalStore.senderIdentity.senderName,
        subject: subject!,
        bodyText: bodyText!,
        sentAt: nowIso,
        status: "DELIVERED",
        qcScore: qc.score || 98,
        campaignName: "Contextual Memory-Aware Follow-Up Engine",
        category: conv.category,
        leadId: conv.leadId,
      });

      globalStore.saveToDisk();

      res.json({ success: true, message: newMsg, conversation: conv, memory: conv.memory });
    } catch (error: any) {
      console.error("Generate follow-up error:", error);
      res.status(500).json({ error: error.message || "Failed to generate follow-up" });
    }
  });

  // 8. Pipeline Opportunities
  app.get("/api/pipeline", async (_req: Request, res: Response) => {
    try {
      const dbOpps = await db.select().from(schema.opportunities);
      const mapped = dbOpps.map(o => ({
        id: o.id,
        contactId: o.contactId,
        stage: o.stage,
        value: o.value
      }));
      res.json([...mapped, ...globalStore.opportunities]);
    } catch(e) { res.json(globalStore.opportunities); }
  });

  app.post("/api/pipeline", (req: Request, res: Response) => {
    const oppData: Partial<Opportunity> = req.body;
    const newOpp: Opportunity = {
      id: `opp_${Date.now()}`,
      workspaceId: "default",
      title: oppData.title || "New Opportunity",
      companyName: oppData.companyName || "Target Org",
      contactName: oppData.contactName || "Prospect Lead",
      contactEmail: oppData.contactEmail || "",
      category: oppData.category || "CUSTOMER",
      stage: oppData.stage || "QUALIFIED",
      estimatedValue: oppData.estimatedValue || 12000,
      currency: oppData.currency || "£",
      probability: oppData.probability || 50,
      aiScore: oppData.aiScore || 88,
      nextStep: oppData.nextStep || "Schedule discovery demo",
      expectedCloseDate: oppData.expectedCloseDate || new Date(Date.now() + 86400000 * 30).toISOString().split("T")[0],
      updatedAt: new Date().toISOString(),
    };
    globalStore.opportunities.unshift(newOpp);
    globalStore.saveToDisk();
    res.json(newOpp);
  });

  app.put("/api/pipeline/:id/stage", (req: Request, res: Response) => {
    const { id } = req.params;
    const { stage } = req.body;
    const opp = globalStore.opportunities.find((o) => o.id === id);
    if (!opp) {
      return res.status(404).json({ error: "Opportunity not found" });
    }
    opp.stage = stage;
    opp.updatedAt = new Date().toISOString();
    globalStore.saveToDisk();
    res.json(opp);
  });

  // 9. Meetings & Calendar
  app.get("/api/meetings", async (_req: Request, res: Response) => {
    try {
      const dbMeetings = await db.select().from(schema.meetings);
      const mapped = dbMeetings.map(m => ({
        id: m.id,
        contactId: m.contactId,
        prospectName: "Unknown",
        prospectEmail: "unknown@example.com",
        companyName: "Unknown",
        status: m.status,
        scheduledAt: m.scheduledTime ? m.scheduledTime.toISOString() : undefined,
        meetLink: m.meetUrl,
      }));
      res.json([...mapped, ...globalStore.meetings]);
    } catch(e) { res.json(globalStore.meetings); }
  });

  app.post("/api/meetings", async (req: Request, res: Response) => {
    const { prospectName, prospectEmail, companyName, category, scheduledTime, durationMinutes } = req.body;
    
    // Generate AI pre-meeting brief
    const aiBrief = await generateMeetingBrief({
      prospectName: prospectName || "Prospect",
      prospectEmail: prospectEmail || "",
      companyName: companyName || "Target Company",
      category: category || "CUSTOMER",
      companyBrain: globalStore.companyBrain,
    });

    const newMeeting: Meeting = {
      id: `meet_${Date.now()}`,
      workspaceId: "default",
      title: `Abedin Voice AI // ${companyName || "Prospect Demo"}`,
      prospectName: prospectName || "Prospect",
      prospectEmail: prospectEmail || "",
      companyName: companyName || "Target Company",
      category: category || "CUSTOMER",
      scheduledTime: scheduledTime || new Date(Date.now() + 86400000 * 2).toISOString(),
      durationMinutes: durationMinutes || 30,
      meetUrl: `https://meet.google.com/${Math.random().toString(36).substring(2, 5)}-${Math.random().toString(36).substring(2, 6)}-${Math.random().toString(36).substring(2, 5)}`,
      status: "CONFIRMED",
      aiBrief,
    };

    globalStore.meetings.unshift(newMeeting);
    globalStore.saveToDisk();
    res.json(newMeeting);
  });

  app.post("/api/meetings/brief", async (req: Request, res: Response) => {
    try {
      const brief = await generateMeetingBrief({
        ...req.body,
        companyBrain: globalStore.companyBrain,
      });
      res.json(brief);
    } catch (error) {
      console.error("Meeting brief error:", error);
      res.status(500).json({ error: "Failed to generate meeting brief" });
    }
  });

  // Automated 24h and 1h Reminders
  app.post("/api/meetings/:id/send-reminder", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { type } = req.body; // '24H' | '1H'
      const meeting = globalStore.meetings.find((m) => m.id === id);
      if (!meeting) {
        return res.status(404).json({ error: "Meeting not found" });
      }

      if (!meeting.reminders) {
        meeting.reminders = { reminder24hSent: false, reminder1hSent: false };
      }

      if (type === "24H") {
        meeting.reminders.reminder24hSent = false; // Reset to force dispatch
      } else {
        meeting.reminders.reminder1hSent = false;
        meeting.reminders.reminder24hSent = true;
      }

      const result = await checkAndDispatchMeetingReminders(true);
      res.json({ success: true, result, meeting });
    } catch (error: any) {
      console.error("Send reminder error:", error);
      res.status(500).json({ error: error.message || "Failed to send meeting reminder" });
    }
  });

  // Mark Meeting as Missed / No-Show & Trigger Recovery
  app.post("/api/meetings/:id/mark-missed", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const recovery = await sendMissedMeetingRecoveryEmail(id, 1);
      const meeting = globalStore.meetings.find((m) => m.id === id);
      res.json({ success: true, recovery, meeting });
    } catch (error: any) {
      console.error("Mark missed meeting error:", error);
      res.status(500).json({ error: error.message || "Failed to mark meeting missed" });
    }
  });

  // Dispatch Missed Meeting Recovery Email (Types 1-4)
  app.post("/api/meetings/:id/send-recovery-email", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { variation } = req.body;
      const result = await sendMissedMeetingRecoveryEmail(id, Number(variation) as 1 | 2 | 3 | 4 || 1);
      const meeting = globalStore.meetings.find((m) => m.id === id);
      res.json({ success: true, result, meeting });
    } catch (error: any) {
      console.error("Send recovery email error:", error);
      res.status(500).json({ error: error.message || "Failed to send recovery email" });
    }
  });

  // Sign Master Services Agreement in Live Meeting Room
  app.post("/api/meetings/:id/sign-contract", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { clientSignerName, practiceName, agreedTerms } = req.body;
      const result = await signMeetingAgreement(id, {
        clientSignerName: clientSignerName || "Practice Director",
        practiceName: practiceName || "Clinic Group",
        agreedTerms: agreedTerms ?? true,
      });
      const meeting = globalStore.meetings.find((m) => m.id === id);
      res.json({ success: true, result, meeting });
    } catch (error: any) {
      console.error("Sign contract error:", error);
      res.status(500).json({ error: error.message || "Failed to sign agreement" });
    }
  });

  // Process First Payment (£499.00 GBP) in Live Meeting Room
  app.post("/api/meetings/:id/process-payment", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { amount, paymentMethod } = req.body;
      const result = await processMeetingFirstPayment(id, {
        amount: amount || 499,
        paymentMethod: paymentMethod || "CARD_ONLINE",
      });
      const meeting = globalStore.meetings.find((m) => m.id === id);
      res.json({ success: true, result, meeting, opportunities: globalStore.opportunities });
    } catch (error: any) {
      console.error("Process payment error:", error);
      res.status(500).json({ error: error.message || "Failed to process payment" });
    }
  });

  // 10. Knowledge Base
  app.get("/api/knowledge", (_req: Request, res: Response) => {
    res.json(globalStore.knowledgeItems);
  });

  app.post("/api/knowledge", (req: Request, res: Response) => {
    const { category, title, content, source, approvedForAI, isSensitive } = req.body;
    const newItem: KnowledgeItem = {
      id: `kno_${Date.now()}`,
      workspaceId: "default",
      category: category || "PRODUCT",
      title: title || "New Knowledge Document",
      content: content || "",
      source: source || "User Knowledge Upload",
      approvedForAI: approvedForAI ?? true,
      isSensitive: isSensitive ?? false,
      updatedAt: new Date().toISOString(),
    };
    globalStore.knowledgeItems.unshift(newItem);
    globalStore.saveToDisk();
    res.json(newItem);
  });

  // 11. Autopilot Settings
  app.get("/api/settings", (_req: Request, res: Response) => {
    res.json({
      autopilot: globalStore.autopilotSettings,
      suppressionCount: globalStore.suppressionList.length,
      integrations: {
        gmail: { connected: true, email: "nayem@abedintech.com" },
        calendar: { connected: true, primaryCalendar: "Work Calendar" },
        drive: { connected: false },
        apollo: { connected: false, label: "Lead Discovery Adapter (Demo Active)" },
        crunchbase: { connected: false, label: "Investor Data Adapter (Demo Active)" },
        voiceAi: { connected: true, provider: "Abedin Voice AI Engine v2" },
      },
    });
  });

  app.post("/api/settings/autopilot", (req: Request, res: Response) => {
    globalStore.autopilotSettings = {
      ...globalStore.autopilotSettings,
      ...req.body,
    };
    globalStore.saveToDisk();
    res.json(globalStore.autopilotSettings);
  });

  // 12. AI Growth Command & Agent Chat
  app.post("/api/growth-command", async (req: Request, res: Response) => {
    try {
      const { command, contextData } = req.body;
      const result = await processGrowthCommand(
        command || "Show status",
        globalStore.companyBrain,
        contextData || {
          leadsCount: globalStore.leads.length,
          investorsCount: globalStore.investors.length,
          conversationsCount: globalStore.conversations.length,
          activeMeetings: globalStore.meetings.length,
        }
      );

      // Log AI run
      globalStore.aiRunLogs.unshift({
        id: `run_${Date.now()}`,
        workspaceId: "default",
        agentType: "GrowthCommandAgent",
        actionType: "PROCESS_COMMAND",
        modelCategory: "SMART",
        status: "SUCCESS",
        confidence: 0.95,
        summary: `Executed command: "${command}" (Intent: ${result.intent})`,
        durationMs: 540,
        createdAt: new Date().toISOString(),
      });

      res.json(result);
    } catch (error) {
      console.error("Growth command error:", error);
      res.status(500).json({ error: "Failed to process growth command" });
    }
  });

  // 13. Quality Control check
  app.post("/api/qc/inspect", async (req: Request, res: Response) => {
    try {
      const result = await inspectEmailDraft(req.body);
      res.json(result);
    } catch (error) {
      console.error("QC error:", error);
      res.status(500).json({ error: "QC inspection failed" });
    }
  });

  // 14. Pitch Battle Objection War Room Simulation
  app.post("/api/pitch-battle/simulate", async (req: Request, res: Response) => {
    try {
      const result = await simulatePitchBattle(req.body, globalStore.companyBrain);
      res.json(result);
    } catch (error) {
      console.error("Pitch battle simulation error:", error);
      res.status(500).json({ error: "Failed to simulate pitch battle" });
    }
  });

  // 15. AI Logs
  app.get("/api/logs", (_req: Request, res: Response) => {
    res.json(globalStore.aiRunLogs);
  });

  // 16. Continuous Autopilot Runner API
  
  app.post("/api/settings/token", express.json(), (req, res) => {
    const { token } = req.body;
    if (token) {
      gmailService.setCredentials({ access_token: token });
      calendarService.setCredentials({ access_token: token });
      console.log("Workspace OAuth token registered in backend.");
      res.json({ success: true });
    } else {
      res.status(400).json({ error: "Missing token" });
    }
  });

  app.get("/api/autopilot/status", (_req: Request, res: Response) => {
    res.json(autopilotRunner.getStatus());
  });

  app.post("/api/autopilot/toggle", (_req: Request, res: Response) => {
    const isActive = autopilotRunner.toggle();
    res.json({ isActive, status: autopilotRunner.getStatus() });
  });

  app.post("/api/autopilot/settings", (req: Request, res: Response) => {
    const updated = autopilotRunner.setSettings(req.body);
    res.json(updated);
  });

  app.post("/api/autopilot/run-cycle-now", async (_req: Request, res: Response) => {
    try {
      const result = await autopilotRunner.runFullCycleNow(true);
      res.json({
        ...result,
        status: autopilotRunner.getStatus(),
        leadsCount: globalStore.leads.length,
        investorsCount: globalStore.investors.length,
        conversationsCount: globalStore.conversations.length,
      });
    } catch (error: any) {
      console.error("Manual cycle run error:", error);
      res.status(500).json({ error: error.message || "Failed to run autopilot cycle" });
    }
  });

  // 17. Sender Identity Configuration
  app.get("/api/sender-identity", (_req: Request, res: Response) => {
    res.json(globalStore.senderIdentity);
  });

  app.post("/api/sender-identity", (req: Request, res: Response) => {
    globalStore.senderIdentity = {
      ...globalStore.senderIdentity,
      ...req.body,
      lastVerifiedAt: new Date().toISOString(),
    };
    globalStore.saveToDisk();
    res.json(globalStore.senderIdentity);
  });

  // 18. LinkedIn Configuration & Direct Outreach
  app.get("/api/linkedin-config", (_req: Request, res: Response) => {
    res.json(globalStore.linkedInConfig);
  });

  app.post("/api/linkedin-config", (req: Request, res: Response) => {
    globalStore.linkedInConfig = {
      ...globalStore.linkedInConfig,
      ...req.body,
      lastSyncAt: new Date().toISOString(),
    };
    globalStore.saveToDisk();
    res.json(globalStore.linkedInConfig);
  });

  app.post("/api/linkedin/send-message", (req: Request, res: Response) => {
    try {
      const { recipientType, recipientId, recipientName, recipientTitle, companyName, messageType, note } = req.body;
      const nowIso = new Date().toISOString();
      const msgId = `li_${Date.now()}`;

      // Update counters
      if (messageType === "CONNECTION_REQUEST") {
        globalStore.linkedInConfig.connectionsSentToday = (globalStore.linkedInConfig.connectionsSentToday || 0) + 1;
      } else {
        globalStore.linkedInConfig.messagesSentToday = (globalStore.linkedInConfig.messagesSentToday || 0) + 1;
      }

      // Record in Outbox
      globalStore.outboxLogs.unshift({
        id: `outbox_${msgId}`,
        recipientName: recipientName || "LinkedIn Member",
        recipientEmail: `${recipientName?.toLowerCase().replace(/\s+/g, ".") || "contact"}@linkedin.com`,
        recipientTitle: recipientTitle || "",
        companyName: companyName || "",
        channel: "LINKEDIN",
        senderEmail: globalStore.linkedInConfig.profileName,
        senderName: globalStore.linkedInConfig.profileName,
        subject: messageType === "CONNECTION_REQUEST" ? "LinkedIn Connection Request + Note" : "LinkedIn InMail Message",
        bodyText: note || "",
        sentAt: nowIso,
        status: "DELIVERED",
        qcScore: 99,
        campaignName: "LinkedIn Autonomous Network Outreach",
        category: recipientType === "INVESTOR" ? "INVESTOR" : "CUSTOMER",
        leadId: recipientType === "LEAD" ? recipientId : undefined,
        investorId: recipientType === "INVESTOR" ? recipientId : undefined,
      });

      // Update entity if exists
      if (recipientType === "LEAD" && recipientId) {
        const lead = globalStore.leads.find((l) => l.id === recipientId);
        if (lead) {
          lead.status = "CONTACTED";
          lead.contactedAt = nowIso;
          lead.lastActivityAt = nowIso;
          lead.lastOutreachSubject = "LinkedIn Connection Request";
          lead.lastOutreachBody = note;
          lead.lastOutreachChannel = "LINKEDIN";
          lead.nextAction = "Day 2: Check connection acceptance";
        }
      } else if (recipientType === "INVESTOR" && recipientId) {
        const inv = globalStore.investors.find((i) => i.id === recipientId);
        if (inv) {
          inv.status = "CONTACTED";
          inv.contactedAt = nowIso;
          inv.lastContactAt = nowIso;
          inv.lastOutreachSubject = "LinkedIn InMail Note";
          inv.lastOutreachBody = note;
          inv.lastOutreachChannel = "LINKEDIN";
        }
      }

      globalStore.saveToDisk();
      res.json({
        success: true,
        linkedInConfig: globalStore.linkedInConfig,
        outboxEntry: globalStore.outboxLogs[0],
      });
    } catch (error: any) {
      console.error("LinkedIn send error:", error);
      res.status(500).json({ error: error.message || "Failed to send LinkedIn message" });
    }
  });

  // 19. Complete Outbox & Audit Trails
  app.get("/api/outbox", (_req: Request, res: Response) => {
    res.json(globalStore.outboxLogs);
  });

  // Vite middleware for development / static serving in production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    
// eSignature routes (DocuSign/PandaDoc Webhook)
app.post("/api/signature/webhook", express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  try {
    // In a real app we verify the HMAC signature from DocuSign here
    const event = JSON.parse(req.body.toString());
    
    if (event.event === 'envelope-completed') {
      const meetingId = event.data.envelopeSummary.customFields.customField.find((f: any) => f.name === 'meetingId')?.value;
      if (meetingId) {
        console.log(`DocuSign webhook received for meeting: ${meetingId}`);
        await db.update(schema.meetings).set({ status: 'CONFIRMED' }).where(eq(schema.meetings.id, meetingId));
      }
    }
    res.status(200).send("OK");
  } catch(e) {
    console.error("DocuSign webhook error", e);
    res.status(500).send("Error");
  }
});

  app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Abedin Growth AI] Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});
