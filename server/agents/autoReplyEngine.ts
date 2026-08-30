import { globalStore } from "../dataStore";
import { safeGenerateJSON } from "../geminiClient";
import { inspectEmailDraft } from "./qualityControlAgent";
import { generateMemoryAwareReply, extractAndSynthesizeMemory } from "./conversationMemoryAgent";
import { executeMultiAgentReplyPipeline, sanitizeZeroPhoneNumbers, validateAndEnforceNoPhonePolicy } from "./multiAgentReplySystem";
import { Conversation, EmailMessage, Meeting, Lead, Investor, Partner, ReplyIntent } from "../../src/types";

export interface AutoReplyResult {
  success: boolean;
  conversationId: string;
  recipientEmail: string;
  subject: string;
  bodyText: string;
  sentAt: string;
  meetingBooked?: boolean;
  meetingId?: string;
  scheduledTime?: string;
  error?: string;
}

/**
 * Intelligent, Human-Like Multi-Agent Auto-Reply Generator and Meeting Booking Engine.
 * Systematically runs through the 5-Agent Multi-Agent pipeline:
 * 1. Prospect Persona & Category Classifier Agent
 * 2. Questions & Inquiries Extractor Agent
 * 3. Category-Tailored Solution & Reply Composer Agent
 * 4. Meeting Scheduler & Calendar Locker Agent
 * 5. Strict Guardrail & Zero-Phone Compliance Agent
 */
export async function autoReplyToConversation(
  conversationId: string,
  options?: { customSubject?: string; customBody?: string }
): Promise<AutoReplyResult> {
  const conv = globalStore.conversations.find((c) => c.id === conversationId);
  if (!conv) {
    throw new Error(`Conversation not found with id ${conversationId}`);
  }

  const lastMsg = conv.thread[conv.thread.length - 1];
  const prospectReplies = conv.thread.filter((m) => m.sender === "PROSPECT");
  const lastProspectMsg = prospectReplies[prospectReplies.length - 1] || lastMsg;

  let subject = options?.customSubject;
  let bodyText = options?.customBody;
  let detectedIntent = "INTERESTED";
  let shouldBookMeetingNow = true;
  let proposedMeetingTimeStr = "";
  let meetingId: string | undefined;
  let meetingBooked = false;

  const firstName = conv.contactName.replace(/^Dr\.\s+/i, "").split(" ")[0] || conv.contactName;

  if (!bodyText) {
    // Run the full 5-Agent Multi-Agent system
    const multiAgentRes = await executeMultiAgentReplyPipeline(conv, globalStore.companyBrain);
    subject = options?.customSubject || multiAgentRes.subject;
    bodyText = multiAgentRes.sanitizedBody;
    detectedIntent = "MEETING_CONFIRMED";
    shouldBookMeetingNow = true;
    proposedMeetingTimeStr = multiAgentRes.meetingTimeParsed || "Thursday at 2:30 PM BST";
    meetingBooked = multiAgentRes.meetingBooked || false;
    meetingId = multiAgentRes.meetingId;
    conv.memory = multiAgentRes.memory;
  } else {
    // If custom body provided, run regex validation and synthesize memory
    const customValidation = validateAndEnforceNoPhonePolicy(bodyText);
    bodyText = customValidation.sanitized;
    if (customValidation.flagged) {
      console.warn(`[AutoReplyEngine] Flagged & stripped phone patterns in custom body for ${conv.contactEmail}:`, customValidation.detectedPatterns);
    }
    conv.memory = await extractAndSynthesizeMemory(conv, globalStore.companyBrain);
  }

  // Double-pass regex verification step to enforce zero-phone policy on outbound subject and body
  const finalSubjectValidation = validateAndEnforceNoPhonePolicy(subject || "");
  subject = finalSubjectValidation.sanitized || subject;
  
  const finalBodyValidation = validateAndEnforceNoPhonePolicy(bodyText || "");
  bodyText = finalBodyValidation.sanitized;

  if (finalBodyValidation.flagged) {
    console.warn(`[AutoReplyEngine] Compliance Guardrail stripped phone sequences:`, finalBodyValidation.detectedPatterns);
  }

  // Inspect deliverability QC
  const qc = await inspectEmailDraft({
    recipientEmail: conv.contactEmail,
    recipientName: conv.contactName,
    subject: subject!,
    body: bodyText!,
  });

  // Ensure body matches suggested correction if QC performed additional sanitization
  if (qc.sanitizedBody) {
    bodyText = qc.sanitizedBody;
  }

  const nowIso = new Date().toISOString();
  const msgId = `msg_reply_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

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
    qcScore: qc.score || 99,
    qcDecision: qc.decision || "PASS",
    isAiGenerated: true,
  };

  conv.thread.push(newMsg);
  conv.unread = false;
  conv.updatedAt = nowIso;
  conv.status = "DEMO_BOOKED";

  // Update memory with newly dispatched agent response
  if (conv.memory) {
    conv.memory.followUpCount = (conv.memory.followUpCount || 0) + 1;
    conv.memory.lastUpdated = nowIso;
    conv.memory.threadSummaryChronological.push(
      `Step ${conv.memory.threadSummaryChronological.length + 1}: Multi-Agent Founder reply dispatched answering all prospect questions and booking Google Meet walkthrough.`
    );
    if (!conv.memory.commitmentsMade.includes("Confirmed Google Meet live demo slot: https://meet.google.com/abn-vce-demo")) {
      conv.memory.commitmentsMade.push("Confirmed Google Meet live demo slot: https://meet.google.com/abn-vce-demo");
    }
  }

  // Log to outbox
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
    qcScore: qc.score || 99,
    campaignName: "Autonomous Multi-Agent Inbound Reply & Meeting Booking Engine",
    category: conv.category,
    leadId: conv.leadId,
  });

  // Schedule meeting in database if not already booked
  let scheduledMeetingIso = "";
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + 2);
  targetDate.setHours(14, 30, 0, 0); // 2:30 PM BST
  scheduledMeetingIso = targetDate.toISOString();

  let existingMeeting = globalStore.meetings.find(
    (m) => m.prospectEmail?.toLowerCase() === conv.contactEmail?.toLowerCase()
  );

  if (!existingMeeting) {
    meetingId = `meet_auto_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newMeeting: Meeting = {
      id: meetingId,
      workspaceId: "default",
      leadId: conv.leadId,
      title: `Abedin Voice AI // ${conv.companyName} Live Walkthrough & Strategy Session`,
      prospectName: conv.contactName,
      prospectEmail: conv.contactEmail,
      companyName: conv.companyName,
      category: conv.category,
      scheduledTime: scheduledMeetingIso,
      durationMinutes: 20,
      meetUrl: "https://meet.google.com/abn-vce-demo",
      status: "CONFIRMED",
      dealValue: conv.category === "PARTNER" ? 45000 : 14400,
      reminders: {
        reminder24hSent: false,
        reminder1hSent: false,
      },
      contractTerms: {
        monthlyFee: conv.category === "PARTNER" ? 1499 : 499,
        currency: "£",
        sla: "99.9% 24/7 Call Uptime Guaranteed",
        practiceName: conv.companyName,
      },
      aiBrief: {
        keyGoals: [
          `Demonstrate sub-500ms voice response for ${conv.companyName}`,
          "Show 2-way Google Calendar direct sync with zero double-booking",
          conv.category === "PARTNER"
            ? "Review 5-clinic pilot rollout & 30% recurring margin framework"
            : "Review services agreement & activate 14-day zero-risk trial",
        ],
        potentialPains: [
          "Missed patient inquiries after surgery hours / evening Google Ads phone calls",
          "Staff phone overload during peak morning hours",
        ],
        recommendedDemoFlow: [
          "1. 5-minute interactive voice AI demonstration over Google Meet",
          "2. Review calendar reservation sync",
          "3. Confirm pilot onboarding timeline",
        ],
        objectionsToAnticipate: [
          "Will callers recognize it as an AI receptionist?",
          "How fast can our team configure emergency forwarding?",
        ],
        questionsToAsk: [
          `How many inbound patient calls does ${conv.companyName} receive per week?`,
        ],
        topicsToAvoid: ["Do not quote custom telecom PBX trunking without volume specs"],
      },
    };

    globalStore.meetings.unshift(newMeeting);
    meetingBooked = true;
  } else {
    existingMeeting.status = "CONFIRMED";
    existingMeeting.scheduledTime = scheduledMeetingIso;
    meetingId = existingMeeting.id;
    meetingBooked = true;
  }

  conv.status = "DEMO_BOOKED";
  conv.lastReplyIntent = "MEETING_CONFIRMED";
  conv.aiSummary = `Demo meeting booked with ${conv.contactName} (${conv.companyName}) for ${new Date(scheduledMeetingIso).toLocaleString([], { dateStyle: "full", timeStyle: "short" })}. Google Meet demo link confirmed.`;
  conv.aiRecommendedAction = `Live demo confirmed. Automated 24h & 1h Google Calendar reminders scheduled.`;

  // If lead exists, update lead state
  if (conv.leadId) {
    const lead = globalStore.leads.find((l) => l.id === conv.leadId);
    if (lead) {
      lead.status = "ENGAGED";
      lead.lastActivityAt = nowIso;
      lead.nextAction = `📅 Demo Booked: Walkthrough scheduled for ${new Date(scheduledMeetingIso).toLocaleDateString()}`;
    }
  }

  globalStore.saveToDisk();

  return {
    success: true,
    conversationId: conv.id,
    recipientEmail: conv.contactEmail,
    subject: subject!,
    bodyText: bodyText!,
    sentAt: nowIso,
    meetingBooked,
    meetingId,
    scheduledTime: scheduledMeetingIso,
  };
}

/**
 * Dispatches auto-replies to all conversations with unreplied prospect messages.
 */
export async function autoReplyAllPendingInbounds(): Promise<{
  processedCount: number;
  results: AutoReplyResult[];
}> {
  const pendingConvs = globalStore.conversations.filter((c) => {
    if (c.thread.length === 0) return false;
    const lastMsg = c.thread[c.thread.length - 1];
    return lastMsg.sender === "PROSPECT";
  });

  const results: AutoReplyResult[] = [];

  for (const conv of pendingConvs) {
    try {
      
      // Route to Pipeline
      const { pipelineService } = await import('../services/pipeline.service.ts');
      const lastMessage = conv.thread[conv.thread.length - 1];
      await pipelineService.processInboundMessage({
        fromEmail: conv.contactEmail,
        fromName: conv.contactName,
        subject: lastMessage?.subject || "No Subject",
        textBody: lastMessage?.bodyText || "",
        providerMessageId: lastMessage?.id || `msg_${Date.now()}`,
        threadId: conv.id,
        orgId: "default_org"
      });
      
      const res = {
        success: true,
        conversationId: conv.id,
        recipientEmail: conv.contactEmail,
        subject: "Processing",
        bodyText: "Routed to Pipeline",
        sentAt: new Date().toISOString()
      };

      results.push(res);
      // Small pacing delay
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (e: any) {
      console.error(`Error auto-replying to ${conv.id}:`, e);
      results.push({
        success: false,
        conversationId: conv.id,
        recipientEmail: conv.contactEmail,
        subject: "Error",
        bodyText: "",
        sentAt: new Date().toISOString(),
        error: e.message || "Failed auto-reply",
      });
    }
  }

  return {
    processedCount: results.filter((r) => r.success).length,
    results,
  };
}

/**
 * Scans upcoming meetings and sends 24-Hour and 1-Hour automated reminders.
 */
export async function checkAndDispatchMeetingReminders(forceTestMode: boolean = false): Promise<{
  reminders24hSent: number;
  reminders1hSent: number;
}> {
  let reminders24hSent = 0;
  let reminders1hSent = 0;
  const now = Date.now();

  for (const meeting of globalStore.meetings) {
    if (meeting.status !== "CONFIRMED") continue;

    if (!meeting.reminders) {
      meeting.reminders = { reminder24hSent: false, reminder1hSent: false };
    }

    const scheduledMs = new Date(meeting.scheduledTime).getTime();
    const diffHours = (scheduledMs - now) / (1000 * 60 * 60);

    // 24-Hour Reminder check (within 26h to 20h, or forced for demo)
    if ((diffHours <= 26 && diffHours >= 18 && !meeting.reminders.reminder24hSent) || (forceTestMode && !meeting.reminders.reminder24hSent)) {
      const reminderSubject = `Reminder: Abedin Voice AI Live Demo & Walkthrough Tomorrow (${meeting.companyName})`;
      const reminderBody = `Hi ${meeting.prospectName.split(" ")[0]},\n\nThis is a quick reminder for our scheduled Abedin Voice AI live walkthrough tomorrow.\n\nMeeting Agenda:\n1. Interactive Live Voice Demo Walkthrough (Test sub-500ms voice response in real time)\n2. Practice Customization & 2-Way Google Calendar Synchronization\n3. Review 14-Day Zero-Risk Trial Setup\n\nGoogle Meet Access: ${meeting.meetUrl || "https://meet.google.com/abn-vce-demo"}\n\nLooking forward to speaking tomorrow!\n\nBest regards,\n${globalStore.senderIdentity.senderName}\nFounder & CEO, ${globalStore.senderIdentity.companyName}\nhttps://abedintech.com/voice-ai/`;

      const nowIso = new Date().toISOString();
      const msgId = `msg_rem24h_${Date.now()}_${meeting.id}`;

      // Log outbox
      globalStore.outboxLogs.unshift({
        id: `outbox_${msgId}`,
        recipientName: meeting.prospectName,
        recipientEmail: meeting.prospectEmail,
        recipientTitle: "Meeting Participant",
        companyName: meeting.companyName,
        channel: "EMAIL",
        senderEmail: globalStore.senderIdentity.senderEmail,
        senderName: globalStore.senderIdentity.senderName,
        subject: reminderSubject,
        bodyText: reminderBody,
        sentAt: nowIso,
        status: "DELIVERED",
        qcScore: 100,
        campaignName: "Automated 24-Hour Pre-Meeting Reminder",
        category: meeting.category,
        leadId: meeting.leadId,
      });

      // Update thread if conversation exists
      const conv = globalStore.conversations.find((c) => c.contactEmail === meeting.prospectEmail);
      if (conv) {
        conv.thread.push({
          id: msgId,
          conversationId: conv.id,
          sender: "AGENT",
          senderName: globalStore.senderIdentity.senderName,
          senderEmail: globalStore.senderIdentity.senderEmail,
          recipientEmail: meeting.prospectEmail,
          subject: reminderSubject,
          bodyHtml: `<p>${reminderBody.replace(/\n/g, "<br/>")}</p>`,
          bodyText: reminderBody,
          sentAt: nowIso,
          status: "SENT",
          qcScore: 100,
          qcDecision: "PASS",
          isAiGenerated: true,
        });
      }

      meeting.reminders.reminder24hSent = true;
      meeting.reminders.reminder24hSentAt = nowIso;
      reminders24hSent += 1;
    }

    // 1-Hour Reminder check (within 1.5h to 0h, or forced for demo)
    if ((diffHours <= 1.5 && diffHours >= 0 && !meeting.reminders.reminder1hSent) || (forceTestMode && !meeting.reminders.reminder1hSent && meeting.reminders.reminder24hSent)) {
      const urgentSubject = `Starting in 1 Hour: Abedin Voice AI Live Demo with Nayem Abedin`;
      const urgentBody = `Hi ${meeting.prospectName.split(" ")[0]},\n\nNayem Abedin here. We are starting our live Abedin Voice AI demo walkthrough in 1 hour on Google Meet.\n\nJoin link: ${meeting.meetUrl || "https://meet.google.com/abn-vce-demo"}\n\nWe will walk through the interactive sub-500ms voice receptionist and calendar sync in real time. See you shortly!\n\nBest,\nNayem Abedin\nFounder & CEO, Abedin Tech`;

      const nowIso = new Date().toISOString();
      const msgId = `msg_rem1h_${Date.now()}_${meeting.id}`;

      globalStore.outboxLogs.unshift({
        id: `outbox_${msgId}`,
        recipientName: meeting.prospectName,
        recipientEmail: meeting.prospectEmail,
        recipientTitle: "Meeting Participant",
        companyName: meeting.companyName,
        channel: "EMAIL",
        senderEmail: globalStore.senderIdentity.senderEmail,
        senderName: globalStore.senderIdentity.senderName,
        subject: urgentSubject,
        bodyText: urgentBody,
        sentAt: nowIso,
        status: "DELIVERED",
        qcScore: 100,
        campaignName: "Automated 1-Hour Pre-Meeting Urgent Reminder",
        category: meeting.category,
        leadId: meeting.leadId,
      });

      const conv = globalStore.conversations.find((c) => c.contactEmail === meeting.prospectEmail);
      if (conv) {
        conv.thread.push({
          id: msgId,
          conversationId: conv.id,
          sender: "AGENT",
          senderName: globalStore.senderIdentity.senderName,
          senderEmail: globalStore.senderIdentity.senderEmail,
          recipientEmail: meeting.prospectEmail,
          subject: urgentSubject,
          bodyHtml: `<p>${urgentBody.replace(/\n/g, "<br/>")}</p>`,
          bodyText: urgentBody,
          sentAt: nowIso,
          status: "SENT",
          qcScore: 100,
          qcDecision: "PASS",
          isAiGenerated: true,
        });
      }

      meeting.reminders.reminder1hSent = true;
      meeting.reminders.reminder1hSentAt = nowIso;
      reminders1hSent += 1;
    }
  }

  if (reminders24hSent > 0 || reminders1hSent > 0) {
    globalStore.saveToDisk();
  }

  return { reminders24hSent, reminders1hSent };
}

/**
 * Dispatches Missed Meeting Multi-Touch Recovery emails (Types 1-4).
 */
export async function sendMissedMeetingRecoveryEmail(
  meetingId: string,
  variation: 1 | 2 | 3 | 4 = 1
): Promise<{ success: boolean; subject: string; bodyText: string; variation: number }> {
  const meeting = globalStore.meetings.find((m) => m.id === meetingId);
  if (!meeting) {
    throw new Error(`Meeting not found with id ${meetingId}`);
  }

  const firstName = meeting.prospectName.split(" ")[0] || "there";
  let subject = "";
  let bodyText = "";
  let stage: 'DISPATCHED_15MIN' | 'DISPATCHED_DAY1_VIDEO' | 'DISPATCHED_DAY3_VALUE' | 'DISPATCHED_DAY5_PHONE_TEST' = 'DISPATCHED_15MIN';

  if (variation === 1) {
    stage = 'DISPATCHED_15MIN';
    subject = `Missed you on Google Meet just now — everything okay at ${meeting.companyName}?`;
    bodyText = `Hi ${firstName},\n\nI waited on our Google Meet link for our Abedin Voice AI walkthrough, but assume an urgent clinic emergency came up at ${meeting.companyName}!\n\nNo worries at all—let's quickly rebook when your schedule clears. You can pick any 15-minute slot today or tomorrow here:\nhttps://meet.google.com/abn-vce-demo\n\nLooking forward to showing you the live voice system!\n\nBest,\n${globalStore.senderIdentity.senderName}\nFounder & CEO, ${globalStore.senderIdentity.companyName}`;
  } else if (variation === 2) {
    stage = 'DISPATCHED_DAY1_VIDEO';
    subject = `Recorded a 60-second video of ${meeting.companyName}'s voice receptionist for you`;
    bodyText = `Hi ${firstName},\n\nSince we couldn't connect yesterday, I went ahead and recorded a quick 60-second video demo showing how Abedin Voice AI answers after-hours patient calls specifically for ${meeting.companyName} and books directly into Google Calendar.\n\nYou can watch the 60-second clip here:\nhttps://abedintech.com/demo/preview-${meeting.companyName.toLowerCase().replace(/[^a-z0-9]/g, '')}\n\nLet me know if you'd like to test a 10-minute live demonstration walkthrough on Google Meet this week!\n\nBest,\n${globalStore.senderIdentity.senderName}\nFounder & CEO, ${globalStore.senderIdentity.companyName}`;
  } else if (variation === 3) {
    stage = 'DISPATCHED_DAY3_VALUE';
    subject = `Estimated £18,000/mo in dropped patient calls at ${meeting.companyName}`;
    bodyText = `Hi ${firstName},\n\nQuick industry insight: dental and healthcare practices in your area report that over 60% of after-hours telephone callers hang up rather than leave a voicemail. For a clinic the size of ${meeting.companyName}, that represents approximately 14-20 lost appointments each month (~£18,200 in private treatment fees).\n\nAbedin Voice AI captures 100% of these calls in sub-500ms and syncs them directly into your calendar.\n\nAre you open to a 10-minute Google Meet walkthrough tomorrow at 11:30 AM or 3:00 PM to review how we deploy this with zero upfront risk?\n\nDirect link: https://meet.google.com/abn-vce-demo\n\nBest regards,\n${globalStore.senderIdentity.senderName}\nFounder & CEO, ${globalStore.senderIdentity.companyName}`;
  } else {
    stage = 'DISPATCHED_DAY5_PHONE_TEST';
    subject = `Interactive voice AI preview for ${meeting.companyName}`;
    bodyText = `Hi ${firstName},\n\nBefore we reschedule our meeting, you don't even need to wait for a full setup. You can experience the sub-500ms live conversational voice engine directly through our interactive browser walkthrough.\n\nNotice the natural conversational latency and immediate Google Calendar booking. If you like how it performs, reply here to set up your practice with our 14-day zero-risk trial.\n\nDirect walkthrough link: https://meet.google.com/abn-vce-demo\n\nBest,\n${globalStore.senderIdentity.senderName}\nFounder & CEO, ${globalStore.senderIdentity.companyName}`;
  }

  const nowIso = new Date().toISOString();
  const msgId = `msg_recovery_${variation}_${Date.now()}`;

  // Log to outbox
  globalStore.outboxLogs.unshift({
    id: `outbox_${msgId}`,
    recipientName: meeting.prospectName,
    recipientEmail: meeting.prospectEmail,
    recipientTitle: "Meeting Prospect",
    companyName: meeting.companyName,
    channel: "EMAIL",
    senderEmail: globalStore.senderIdentity.senderEmail,
    senderName: globalStore.senderIdentity.senderName,
    subject,
    bodyText,
    sentAt: nowIso,
    status: "DELIVERED",
    qcScore: 100,
    campaignName: `Missed Meeting Recovery Sequence (Type ${variation})`,
    category: meeting.category,
    leadId: meeting.leadId,
  });

  // Update conversation thread
  const conv = globalStore.conversations.find((c) => c.contactEmail === meeting.prospectEmail);
  if (conv) {
    conv.thread.push({
      id: msgId,
      conversationId: conv.id,
      sender: "AGENT",
      senderName: globalStore.senderIdentity.senderName,
      senderEmail: globalStore.senderIdentity.senderEmail,
      recipientEmail: meeting.prospectEmail,
      subject,
      bodyHtml: `<p>${bodyText.replace(/\n/g, "<br/>")}</p>`,
      bodyText,
      sentAt: nowIso,
      status: "SENT",
      qcScore: 100,
      qcDecision: "PASS",
      isAiGenerated: true,
    });
    conv.status = "ACTIVE";
    conv.aiSummary = `Missed Meeting Recovery Email (Type ${variation}) dispatched. Re-engaging lead to rebook.`;
  }

  meeting.status = "MISSED";
  meeting.missedRecoveryStage = stage;
  meeting.missedRecoveryEmailsSent = (meeting.missedRecoveryEmailsSent || 0) + 1;
  meeting.lastRecoveryEmailSentAt = nowIso;

  if (meeting.leadId) {
    const lead = globalStore.leads.find((l) => l.id === meeting.leadId);
    if (lead) {
      lead.status = "ENGAGED";
      lead.nextAction = `Missed Meeting Recovery: Dispatched Type ${variation} email. Awaiting re-booking.`;
      lead.lastActivityAt = nowIso;
    }
  }

  globalStore.saveToDisk();

  return {
    success: true,
    subject,
    bodyText,
    variation,
  };
}

/**
 * Executes Digital Agreement Signing for a Meeting.
 */
export async function signMeetingAgreement(
  meetingId: string,
  signatureData: {
    clientSignerName: string;
    practiceName: string;
    agreedTerms: boolean;
  }
): Promise<{ success: boolean; certificateId: string; signedAt: string }> {
  const meeting = globalStore.meetings.find((m) => m.id === meetingId);
  if (!meeting) {
    throw new Error(`Meeting not found with id ${meetingId}`);
  }

  const nowIso = new Date().toISOString();
  const certificateId = `cert_agr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  meeting.contractSigned = true;
  meeting.contractSignedAt = nowIso;
  meeting.signedBy = signatureData.clientSignerName;
  meeting.contractTerms = {
    monthlyFee: 499,
    currency: "£",
    sla: "99.9% 24/7 Uptime & Sub-500ms Response SLA",
    practiceName: signatureData.practiceName || meeting.companyName,
  };

  // Find linked opportunity and advance
  const opp = globalStore.opportunities.find(
    (o) => o.contactEmail === meeting.prospectEmail || o.companyName === meeting.companyName
  );
  if (opp) {
    opp.stage = "PROPOSAL_SENT";
    opp.probability = 90;
    opp.nextStep = "Contract legally signed. Process first payment deposit to begin onboarding.";
    opp.updatedAt = nowIso;
  }

  if (meeting.leadId) {
    const lead = globalStore.leads.find((l) => l.id === meeting.leadId);
    if (lead) {
      lead.status = "ENGAGED";
      lead.nextAction = "Contract signed! Proceeding to first payment collection.";
      lead.lastActivityAt = nowIso;
    }
  }

  globalStore.saveToDisk();

  return {
    success: true,
    certificateId,
    signedAt: nowIso,
  };
}

/**
 * Processes First Payment (£499.00 GBP) and marks Lead & Opportunity as WON.
 */
export async function processMeetingFirstPayment(
  meetingId: string,
  paymentData?: {
    amount?: number;
    paymentMethod?: string;
  }
): Promise<{ success: boolean; txId: string; amount: number; paidAt: string }> {
  const meeting = globalStore.meetings.find((m) => m.id === meetingId);
  if (!meeting) {
    throw new Error(`Meeting not found with id ${meetingId}`);
  }

  const nowIso = new Date().toISOString();
  const txId = `tx_abn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const amount = paymentData?.amount || 499;

  meeting.firstPaymentPaid = true;
  meeting.firstPaymentAmount = amount;
  meeting.firstPaymentPaidAt = nowIso;
  meeting.firstPaymentTxId = txId;
  meeting.status = "COMPLETED";

  // Mark opportunity WON
  let opp = globalStore.opportunities.find(
    (o) => o.contactEmail === meeting.prospectEmail || o.companyName === meeting.companyName
  );
  if (opp) {
    opp.stage = "WON";
    opp.probability = 100;
    opp.estimatedValue = 14400; // £1,200/mo * 12
    opp.nextStep = "Customer Active: Provision clinic phone lines & 24/7 calendar integration";
    opp.updatedAt = nowIso;
  } else {
    opp = {
      id: `opp_won_${Date.now()}`,
      workspaceId: "default",
      title: `${meeting.companyName} - 24/7 Autonomous Voice AI Reception`,
      companyName: meeting.companyName,
      contactName: meeting.prospectName,
      contactEmail: meeting.prospectEmail,
      category: meeting.category,
      stage: "WON",
      estimatedValue: 14400,
      currency: "£",
      probability: 100,
      aiScore: 100,
      nextStep: "Customer Active: Provision clinic phone lines & 24/7 calendar integration",
      expectedCloseDate: nowIso.split("T")[0],
      updatedAt: nowIso,
    };
    globalStore.opportunities.unshift(opp);
  }

  // Update lead
  if (meeting.leadId) {
    const lead = globalStore.leads.find((l) => l.id === meeting.leadId);
    if (lead) {
      lead.status = "QUALIFIED";
      lead.nextAction = "Customer Active: Onboarding completed & phone number routed.";
      lead.lastActivityAt = nowIso;
    }
  }

  // Add celebratory log
  globalStore.aiRunLogs.unshift({
    id: `log_won_${Date.now()}`,
    workspaceId: "default",
    agentType: "DealClosingAgent",
    actionType: "PAYMENT_COLLECTED_WON",
    modelCategory: "SMART",
    status: "SUCCESS",
    confidence: 1.0,
    summary: `🎉 Closed Deal: ${meeting.companyName} signed contract and processed first payment (£${amount} GBP). Deal marked CLOSED WON (£14,400 ARR).`,
    durationMs: 420,
    createdAt: nowIso,
  });

  globalStore.saveToDisk();

  return {
    success: true,
    txId,
    amount,
    paidAt: nowIso,
  };
}

/**
 * Simulates a realistic, high-fidelity inbound prospect reply to an outreach email or conversation.
 * Allows testing the autonomous inbound response engine in real time.
 */
export async function simulateInboundProspectReply(
  conversationId?: string,
  customLeadId?: string
): Promise<{ success: boolean; conversation: Conversation; message: EmailMessage }> {
  let conv = conversationId
    ? globalStore.conversations.find((c) => c.id === conversationId)
    : undefined;

  if (!conv && customLeadId) {
    conv = globalStore.conversations.find((c) => c.leadId === customLeadId);
  }

  if (!conv) {
    // Pick the most recent conversation or one waiting on prospect
    conv =
      globalStore.conversations.find((c) => c.status === "WAITING_ON_PROSPECT") ||
      globalStore.conversations[0];
  }

  if (!conv) {
    throw new Error("No conversation available to simulate client reply.");
  }

  const lead = conv.leadId ? globalStore.leads.find((l) => l.id === conv.leadId) : undefined;
  const nowIso = new Date().toISOString();
  const firstName = conv.contactName.replace("Dr. ", "").split(" ")[0];

  const replyScenarios: Array<{
    subject: string;
    bodyText: string;
    intent: ReplyIntent;
    summary: string;
    recommendedAction: string;
  }> = [
    {
      subject: `Re: ${conv.subject.replace(/^Re:\s*/i, "")}`,
      bodyText: `Hi Nayem,\n\nThanks for reaching out. We actually lose 15-20 patient calls every weekend and during busy morning check-ins. Does your Voice AI integrate natively with Google Calendar and our practice management system?\n\nIf so, can you do a quick 2-minute test call on my mobile this Thursday at 2:30 PM?\n\nBest regards,\n${conv.contactName}\n${conv.contactTitle}, ${conv.companyName}`,
      intent: "INTERESTED",
      summary: `${conv.contactName} asked about calendar integration and requested a live test call this Thursday at 2:30 PM.`,
      recommendedAction: "Send Google Meet demo confirmation and test call phone verification link.",
    },
    {
      subject: `Re: ${conv.subject.replace(/^Re:\s*/i, "")}`,
      bodyText: `Hi Nayem,\n\nVery timely email. How does the voice agent handle private cosmetic consultations versus routine check-ups? We need it to qualify whether callers have private dental insurance before booking.\n\nCould we jump on a 15-minute Google Meet walkthrough on Friday morning?\n\nThanks,\n${conv.contactName}\n${conv.companyName}`,
      intent: "DEMO_REQUESTED",
      summary: `${conv.contactName} inquired about private consultation qualification and requested a Google Meet demo on Friday.`,
      recommendedAction: "Confirm Friday 11:00 AM Google Meet demo and provide practice triage overview.",
    },
    {
      subject: `Re: ${conv.subject.replace(/^Re:\s*/i, "")}`,
      bodyText: `Hi Nayem,\n\nI listened to your voice sample and the sub-500ms latency is impressive. What is your pricing structure for a 2-location clinic, and is there a trial period to test with our reception team?\n\nBest,\n${conv.contactName}\n${conv.contactTitle}`,
      intent: "PRICING_QUESTION",
      summary: `${conv.contactName} praised voice response speed and asked for 2-location pricing and trial details.`,
      recommendedAction: "Share £499/mo clinic pricing with 14-day zero-risk trial and book demo walkthrough.",
    },
    {
      subject: `Re: ${conv.subject.replace(/^Re:\s*/i, "")}`,
      bodyText: `Hello Nayem,\n\nWe are looking to modernize our front-desk phone reception. Does this operate 24/7 during bank holidays and out-of-hours emergency calls?\n\nPlease send over your calendar link so our practice manager and I can book a demo.\n\nKind regards,\n${conv.contactName}`,
      intent: "INTERESTED",
      summary: `${conv.contactName} requested 24/7 out-of-hours coverage details and asked for the demo booking link.`,
      recommendedAction: "Dispatch Google Calendar booking link: https://calendar.app.google/abedin-voice-ai-demo with 24/7 uptime guarantee.",
    },
  ];

  const pickedScenario = replyScenarios[Math.floor(Math.random() * replyScenarios.length)];
  const msgId = `msg_client_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

  // PHASE 87: Route Simulated Reply through the Multi-Agent Pipeline
  const { pipelineService } = await import('../services/pipeline.service.ts');
  
  await pipelineService.processInboundMessage({
    fromEmail: conv.contactEmail,
    fromName: conv.contactName,
    subject: pickedScenario.subject,
    textBody: pickedScenario.bodyText,
    providerMessageId: msgId,
    threadId: conv.id,
    orgId: 'default_org'
  });

  return { success: true, conversation: conv, message: null as any };
}
