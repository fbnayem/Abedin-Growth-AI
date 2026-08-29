export type EngineCategory = 'CUSTOMER' | 'INVESTOR' | 'PARTNER';
export type EngineType = EngineCategory;
export type PipelineStage = LeadStatus;

export type LeadStatus =
  | 'NEW'
  | 'QUALIFIED'
  | 'CONTACTED'
  | 'ENGAGED'
  | 'DEMO_SCHEDULED'
  | 'MEETING_SCHEDULED'
  | 'DEMO_COMPLETED'
  | 'PROPOSAL_SENT'
  | 'PILOT'
  | 'PROPOSAL'
  | 'NEGOTIATION'
  | 'WON'
  | 'LOST'
  | 'UNSUBSCRIBED';

export type InvestorStatus =
  | 'DISCOVERED'
  | 'QUALIFIED'
  | 'CONTACTED'
  | 'REPLIED'
  | 'MEETING_BOOKED'
  | 'DUE_DILIGENCE'
  | 'TERM_SHEET'
  | 'COMMITTED'
  | 'PASSED';

export type PartnerStatus =
  | 'DISCOVERED'
  | 'QUALIFIED'
  | 'CONTACTED'
  | 'CONVERSATION'
  | 'MEETING'
  | 'PROPOSAL'
  | 'NEGOTIATION'
  | 'ACTIVE_PARTNER'
  | 'DECLINED';

export type PartnerType =
  | 'RESELLER'
  | 'REFERRAL'
  | 'TELECOM'
  | 'AGENCY'
  | 'CRM_CONSULTANT'
  | 'BPO_CALL_CENTER'
  | 'TECHNOLOGY_INTEGRATION'
  | 'STRATEGIC';

export type ReplyIntent =
  | 'INTERESTED'
  | 'VERY_INTERESTED'
  | 'QUESTION'
  | 'PRICING'
  | 'PRICING_QUESTION'
  | 'TECHNICAL'
  | 'OBJECTION'
  | 'NOT_INTERESTED'
  | 'WRONG_PERSON'
  | 'REFERRAL'
  | 'MEETING_REQUEST'
  | 'DEMO_REQUESTED'
  | 'MEETING_CONFIRMED'
  | 'CALL_REQUEST'
  | 'FOLLOW_UP_LATER'
  | 'UNSUBSCRIBE'
  | 'OUT_OF_OFFICE'
  | 'INVESTOR_INTEREST'
  | 'INVESTOR_QUESTION'
  | 'INVESTOR_PASS'
  | 'PARTNER_INTEREST'
  | 'UNKNOWN';

export type PolicyDecision = 'ALLOW' | 'REQUIRE_APPROVAL' | 'ESCALATE' | 'BLOCK' | 'HUMAN_REVIEW_REQUIRED';

export interface PolicyStatusDetail {
  actionName?: string;
  decision: PolicyDecision;
  reason?: string;
}

export interface CompanyBrain {
  workspaceId: string;
  companyName: string;
  companyUrl: string;
  productName: string;
  productUrl: string;
  tagline: string;
  description: string;
  targetIndustries: string[];
  targetCountries: string[];
  customerProblems: string[];
  coreFeatures: string[];
  primaryBenefits: string[];
  differentiators: string[];
  targetPersonas: {
    title: string;
    department: string;
    painPoint: string;
  }[];
  customerUseCases: {
    industry: string;
    useCase: string;
    expectedROI: string;
  }[];
  salesAngles: string[];
  objectionsAndAnswers: {
    objection: string;
    recommendedResponse: string;
  }[];
  investorNarrative: {
    vision: string;
    marketOpportunity: string;
    moat: string;
    tractionHighlights: string;
  };
  partnerNarrative: {
    partnerValueProposition: string;
    revenueSharingModel: string;
    idealPartnerProfile: string;
  };
  updatedAt: string;
}

export interface ScoreBreakdown {
  icpFit: number;          // 0-30
  painProbability: number; // 0-25
  intent: number;          // 0-20
  decisionMakerQuality: number; // 0-15
  contactability: number;  // 0-10
  totalScore: number;      // 0-100
  reasons: string[];
  buyingSignals: string[];
  potentialRisks: string[];
}

export interface Lead {
  id: string;
  workspaceId: string;
  type: EngineCategory;
  name: string;
  title: string;
  email: string;
  phone?: string;
  linkedinUrl?: string;
  companyName: string;
  companyWebsite: string;
  industry: string;
  country: string;
  employeeCount?: string;
  status: LeadStatus;
  aiScore: number;
  scoreBreakdown: ScoreBreakdown;
  inboundCallVolumeLikelihood?: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendedPitch: string;
  bestOutreachAngle: string;
  personalizationSnippets: {
    text: string;
    sourceType: string;
    confidence: number;
  }[];
  lastActivityAt: string;
  discoveredAt?: string;
  contactedAt?: string;
  lastOutreachSubject?: string;
  lastOutreachBody?: string;
  lastOutreachChannel?: 'EMAIL' | 'LINKEDIN';
  emailStatus?: 'DELIVERED' | 'OPENED' | 'CLICKED' | 'REPLIED' | 'BOUNCED' | 'SPAM_CHECK_CLEAN';
  openCount?: number;
  lastOpenedAt?: string;
  clickedAt?: string;
  spamScore?: number;
  recommendedActionLabel?: string;
  recommendedActionReason?: string;
  actionUrgency?: 'HIGH' | 'MEDIUM' | 'LOW';
  nextAction?: string;
  assignedCampaignId?: string;
  isDemo?: boolean;
  notes?: string;
  createdAt: string;
}

export type InvestorStage = 'PRE_SEED' | 'SEED' | 'SERIES_A' | 'SERIES_B' | 'GROWTH' | 'ANGEL';

export type KnowledgeCategory =
  | 'PRODUCT'
  | 'FEATURES'
  | 'PRICING'
  | 'INTEGRATIONS'
  | 'SALES'
  | 'OBJECTIONS'
  | 'CUSTOMER_STORIES'
  | 'INVESTOR'
  | 'FINANCIAL'
  | 'LEGAL';

export interface Investor {
  id: string;
  workspaceId: string;
  name: string;
  fundName: string;
  role: string;
  email: string;
  linkedinUrl?: string;
  country: string;
  stage: InvestorStage;
  typicalCheckSize: string;
  targetSectors: string[];
  investorFitScore: number;
  status: InvestorStatus;
  thesisMatchReason: string;
  portfolioFitExample: string;
  recommendedPitchAngle: string;
  sensitiveRestrictions: string[];
  lastContactAt?: string;
  discoveredAt?: string;
  contactedAt?: string;
  lastOutreachSubject?: string;
  lastOutreachBody?: string;
  lastOutreachChannel?: 'EMAIL' | 'LINKEDIN';
  isDemo?: boolean;
  notes?: string;
  createdAt?: string;
}

export interface Partner {
  id: string;
  workspaceId: string;
  name: string;
  companyName: string;
  partnerType: PartnerType;
  role: string;
  email: string;
  country: string;
  partnerFitScore: number;
  status: PartnerStatus;
  potentialCollaboration: string;
  revenueModel: string;
  targetDecisionMaker: string;
  lastContactAt?: string;
  discoveredAt?: string;
  createdAt?: string;
  isDemo?: boolean;
}

export interface CampaignStep {
  id: string;
  dayOffset: number;
  stepType: 'EMAIL' | 'LINKEDIN_TASK' | 'VOICE_CALL_TRIGGER';
  subjectTemplate: string;
  bodyTemplate: string;
  objective: string;
}

export interface Campaign {
  id: string;
  workspaceId: string;
  name: string;
  engineType: EngineCategory;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';
  targetAudience: string;
  targetIndustries: string[];
  targetLocations: string[];
  steps: CampaignStep[];
  enrolledCount: number;
  sentCount: number;
  openedCount: number;
  repliedCount: number;
  convertedCount: number;
  autonomyMode: 'MANUAL_APPROVAL' | 'SEMI_AUTONOMOUS' | 'FULL_AUTOPILOT';
  aiStrategySummary: string;
  createdAt: string;
}

export interface EmailMessage {
  id: string;
  conversationId: string;
  sender: 'AGENT' | 'PROSPECT' | 'USER';
  senderName: string;
  senderEmail: string;
  recipientEmail: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  sentAt: string;
  isAiGenerated?: boolean;
  status: 'DRAFT' | 'APPROVED' | 'SENT' | 'FAILED';
  qcScore?: number;
  qcDecision?: 'PASS' | 'REWRITE' | 'HUMAN_REVIEW' | 'BLOCK';
}

export type Message = EmailMessage;

export interface ConversationMemory {
  keyPainPoints: string[];
  mentionedPreferences: string[];
  objectionsResolved: string[];
  commitmentsMade: string[];
  agreedTimeSlots: string[];
  prospectSentiment: 'HIGHLY_INTERESTED' | 'EVALUATING' | 'PRICE_CONSCIOUS' | 'TECHNICAL_DEEP_DIVE' | 'SKEPTICAL' | 'READY_TO_BOOK';
  keyFactsExtracted: Record<string, string>;
  threadSummaryChronological: string[];
  followUpCount: number;
  lastUpdated: string;
}

export interface Conversation {
  id: string;
  workspaceId: string;
  leadId?: string;
  subject?: string;
  contactName: string;
  contactEmail: string;
  contactTitle?: string;
  companyName: string;
  category: EngineCategory;
  status: 'ACTIVE' | 'WAITING_ON_PROSPECT' | 'HUMAN_NEEDED' | 'MEETING_REQUESTED' | 'DEMO_BOOKED' | 'CLOSED';
  lastReplyIntent: ReplyIntent;
  intentConfidence: number;
  aiSummary: string;
  aiRecommendedAction: string;
  memory?: ConversationMemory;
  proposedAiDraft?: {
    subject: string;
    body: string;
    rationale: string;
    policyStatus: PolicyStatusDetail | PolicyDecision;
  };
  thread: EmailMessage[];
  unread: boolean;
  updatedAt: string;
}

export interface Opportunity {
  id: string;
  workspaceId: string;
  title: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  category: EngineCategory;
  stage: LeadStatus;
  estimatedValue: number;
  currency: string;
  probability: number;
  aiScore: number;
  nextStep: string;
  expectedCloseDate: string;
  updatedAt: string;
}

export interface Meeting {
  id: string;
  workspaceId: string;
  leadId?: string;
  title: string;
  prospectName: string;
  prospectEmail: string;
  companyName: string;
  category: EngineCategory;
  scheduledTime: string;
  durationMinutes: number;
  meetUrl?: string;
  status: 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'MISSED';
  dealValue?: number;
  reminders?: {
    reminder24hSent: boolean;
    reminder24hSentAt?: string;
    reminder1hSent: boolean;
    reminder1hSentAt?: string;
  };
  contractSigned?: boolean;
  contractSignedAt?: string;
  signedBy?: string;
  contractTerms?: {
    monthlyFee: number;
    currency: string;
    sla: string;
    practiceName: string;
  };
  firstPaymentPaid?: boolean;
  firstPaymentAmount?: number;
  firstPaymentPaidAt?: string;
  firstPaymentTxId?: string;
  missedRecoveryStage?: 'NONE' | 'DISPATCHED_15MIN' | 'DISPATCHED_DAY1_VIDEO' | 'DISPATCHED_DAY3_VALUE' | 'DISPATCHED_DAY5_PHONE_TEST';
  missedRecoveryEmailsSent?: number;
  lastRecoveryEmailSentAt?: string;
  aiBrief: {
    keyGoals: string[];
    potentialPains: string[];
    recommendedDemoFlow: string[];
    objectionsToAnticipate: string[];
    questionsToAsk: string[];
    topicsToAvoid: string[];
  };
}

export interface KnowledgeItem {
  id: string;
  workspaceId: string;
  category:
    | 'PRODUCT'
    | 'FEATURES'
    | 'PRICING'
    | 'INTEGRATIONS'
    | 'SALES'
    | 'OBJECTIONS'
    | 'CUSTOMER_STORIES'
    | 'INVESTOR'
    | 'FINANCIAL'
    | 'LEGAL';
  title: string;
  content: string;
  source: string;
  approvedForAI: boolean;
  isSensitive: boolean;
  updatedAt: string;
}

export interface SenderIdentity {
  senderName: string;
  senderEmail: string;
  jobTitle: string;
  companyName: string;
  replyToEmail?: string;
  emailSignature?: string;
  provider: 'GMAIL_OAUTH' | 'CUSTOM_SMTP' | 'OUTLOOK';
  status: 'CONNECTED' | 'DISCONNECTED';
  lastVerifiedAt?: string;
}

export interface LinkedInConfig {
  connected: boolean;
  profileName: string;
  profileHeadline: string;
  profileUrl: string;
  dailyConnectionLimit: number;
  dailyMessageLimit: number;
  connectionsSentToday: number;
  messagesSentToday: number;
  autoConnectLeads: boolean;
  autoMessageInvestors: boolean;
  connectionNoteTemplate: string;
  inmailTemplate: string;
  status: 'CONNECTED' | 'DISCONNECTED' | 'SYNCING';
  lastSyncAt: string;
}

export interface OutboxLogItem {
  id: string;
  recipientName: string;
  recipientEmail: string;
  recipientTitle?: string;
  companyName: string;
  channel: 'EMAIL' | 'LINKEDIN';
  senderEmail: string;
  senderName: string;
  subject: string;
  bodyText: string;
  sentAt: string;
  status: 'SENT' | 'DELIVERED' | 'OPENED' | 'REPLIED' | 'FAILED';
  qcScore: number;
  openCount?: number;
  lastOpenedAt?: string;
  clickedAt?: string;
  spamScore?: number;
  deliverabilityStatus?: 'VERIFIED_CLEAN' | 'INBOX_LANDED' | 'PROMOTION' | 'SPAM';
  campaignName?: string;
  category: EngineCategory;
  leadId?: string;
  investorId?: string;
}

export interface AutopilotSettings {
  workspaceId: string;
  researchProspects: boolean;
  scoreLeads: boolean;
  writeOutreach: boolean;
  sendApprovedCampaigns: boolean;
  sendFollowups: boolean;
  replyToSimpleQuestions: boolean;
  bookMeetingsAutomatically: boolean;
  discussPricingAutonomously: boolean;
  negotiateContractsAutonomously: boolean;
  discussInvestorValuationAutonomously: boolean;
  minAiConfidenceToSend: number; // 0.0 - 1.0 (default 0.90)
  dailyEmailSendingLimit: number;
  maxOutreachPerDay?: number;
  autonomyLevel?: 'ASSISTED' | 'SEMI_AUTONOMOUS' | 'FULLY_AUTONOMOUS';
  requireApprovalForInvestors?: boolean;
  autoCheckQualityControl?: boolean;
  senderName?: string;
  senderEmail?: string;
  senderJobTitle?: string;
  emailSignature?: string;
  linkedInAutoConnect?: boolean;
  linkedInAutoMessage?: boolean;
  linkedInDailyLimit?: number;
}

export interface NeedsAttentionItem {
  id: string;
  type: 'INVESTOR_QUESTION' | 'CUSTOMER_DEMO_REQUEST' | 'PRICING_INQUIRY' | 'HIGH_VALUE_OBJECTION' | 'QC_ESCALATION';
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  description: string;
  contactName: string;
  companyName: string;
  suggestedAction: string;
  relatedEntityId: string;
  actionType: 'REVIEW_REPLY' | 'SCHEDULE_DEMO' | 'FOUNDER_REVIEW' | 'VIEW_LEAD';
}

export interface DailyGrowthBrief {
  date: string;
  prospectsResearched: number;
  qualifiedCount: number;
  contactedCount: number;
  repliesCount: number;
  positiveConversationsCount: number;
  demosBooked: number;
  investorsInterested: number;
  strategicRecommendation: string;
  topPerformingSegment: string;
}

export interface AIRunLog {
  id: string;
  workspaceId: string;
  agentType: string;
  actionType: string;
  modelCategory: 'FAST' | 'SMART' | 'DEEP';
  status: 'SUCCESS' | 'FAILED';
  confidence: number;
  summary: string;
  durationMs: number;
  createdAt: string;
}

export interface AutopilotCycleLog {
  id: string;
  timestamp: string;
  type: "DISCOVERY_LEAD" | "DISCOVERY_INVESTOR" | "OUTREACH_SENT" | "FOLLOWUP_SENT" | "LIMIT_ALERT" | "CYCLE_SUMMARY";
  title: string;
  detail: string;
  status: "SUCCESS" | "WARNING" | "INFO";
}

export interface AutopilotStatusState {
  isActive: boolean;
  dailyEmailLimit: number;
  emailsSentToday: number;
  currentDate: string;
  leadsDiscoveredToday: number;
  investorsDiscoveredToday: number;
  status: "RUNNING" | "PAUSED" | "LIMIT_REACHED" | "IDLE" | "DISCOVERING" | "DISPATCHING";
  currentLiveTask: string;
  activeStage: "IDLE_MONITORING" | "PROSPECT_DISCOVERY" | "ICP_SCORING" | "DELIVERABILITY_AUDIT" | "CADENCE_DISPATCH" | "PAUSED";
  stageDetail: string;
  progressPercent: number;
  lastCycleTimestamp: string;
  nextCycleTimestamp: string;
  autoDiscoverLeads: boolean;
  autoDiscoverInvestors: boolean;
  autoDispatchOutreach: boolean;
  autoProgressCadence: boolean;
  recentLogs: AutopilotCycleLog[];
}

