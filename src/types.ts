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

// ==========================================
// PART 1 & 2: CLIENT IDENTITY & INTELLIGENCE PROFILE
// ==========================================
export interface ClientIdentityResolution {
  contactId?: string;
  leadId?: string;
  companyId?: string;
  campaignId?: string;
  email: string;
  name: string;
  company: string;
  jobTitle?: string;
  domain: string;
  identityConfidence: number; // 0.0 - 1.0
  resolutionMethod: "EXACT_EMAIL" | "DOMAIN_MATCH" | "THREAD_CONTINUITY" | "CRM_LOOKUP" | "UNRESOLVED_NEW";
  sourceProvenance?: string;
}

export interface ClientIntelligenceProfile {
  identity: {
    name: string;
    email: string;
    title?: string;
    company: string;
    website?: string;
    industry?: string;
    country?: string;
    timezone?: string;
  };
  leadInfo: {
    source: string;
    campaignId?: string;
    campaignName?: string;
    firstTouchDate?: string;
    firstOutreachSubject?: string;
    assignedOwner: string;
  };
  productInterest: {
    productName: string;
    featuresDiscussed: string[];
    useCases: string[];
    desiredOutcomes: string[];
  };
  businessProblem: {
    statedProblems: string[];
    operationalPain?: string;
    currentWorkflow?: string;
    currentVendor?: string;
    urgency: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "EXPLORATORY";
  };
  requirements: {
    inboundCalling: boolean;
    outboundCalling: boolean;
    expectedCallVolume?: string;
    averageCallDuration?: string;
    concurrency?: string;
    crmIntegration?: string;
    calendarProvider?: string;
    languageRequirements?: string[];
    complianceNeeds?: string[];
    customRequirements?: string[];
  };
  commercialInfo: {
    pricesAlreadyDiscussed: string[];
    packageDiscussed?: string;
    discountsMentioned?: string;
    customQuoteRequired: boolean;
    trialDiscussed: boolean;
    budgetSignals?: string;
    purchasingTimeline?: string;
  };
  buyingState: {
    buyingStage: BuyingStage;
    purchaseReadiness: number; // 0 - 100
    meetingReadiness: number;  // 0 - 100
    decisionAuthority: "SOLE_DECISION_MAKER" | "INFLUENCER" | "TECHNICAL_EVALUATOR" | "GATEKEEPER" | "UNKNOWN";
    buyingProbability: number; // 0 - 100
  };
  objections: {
    type: string;
    severity: "BLOCKER" | "HIGH" | "MEDIUM" | "RESOLVED";
    details: string;
    resolved: boolean;
  }[];
  meetingRecord: {
    meetingOffered: boolean;
    bookingCtaSent: boolean;
    bookingDate?: string;
    bookedStatus: "NONE" | "OFFERED" | "BOOKED" | "COMPLETED" | "CANCELLED" | "MISSED";
    meetingUrl?: string;
  };
  conversationMemory: {
    importantFacts: string[];
    promisesMade: string[];
    questionsAwaitingResponse: string[];
    informationRequestedFromClient: string[];
    nextFollowUpDate?: string;
    rollingSummary: string;
    lastUpdated: string;
  };
}

// ==========================================
// PART 6 & 7: MULTI-DIMENSIONAL INTENT & BUYING STAGE
// ==========================================
export type ComprehensiveIntent =
  | "INFORMATION_REQUEST"
  | "FEATURE_QUESTION"
  | "TECHNICAL_QUESTION"
  | "INTEGRATION_QUESTION"
  | "SECURITY_QUESTION"
  | "COMPLIANCE_QUESTION"
  | "PRICING_QUESTION"
  | "PRICE_COMPARISON"
  | "DISCOUNT_REQUEST"
  | "TRIAL_REQUEST"
  | "DEMO_REQUEST"
  | "IMPLEMENTATION_QUESTION"
  | "PURCHASE_INTENT"
  | "READY_TO_START"
  | "NEGOTIATION"
  | "OBJECTION"
  | "COMPETITOR_COMPARISON"
  | "PARTNERSHIP"
  | "INVESTMENT"
  | "REFERRAL"
  | "SUPPORT"
  | "FOLLOW_UP_REQUEST"
  | "NOT_INTERESTED"
  | "UNSUBSCRIBE"
  | "WRONG_PERSON"
  | "OUT_OF_OFFICE"
  | "BOUNCE"
  | "AUTOMATED_MESSAGE"
  | "UNKNOWN";

export type BuyingStage =
  | "DISCOVERY"
  | "PROBLEM_AWARE"
  | "SOLUTION_EXPLORING"
  | "PRODUCT_EVALUATING"
  | "TECHNICAL_EVALUATION"
  | "COMMERCIAL_EVALUATION"
  | "DEMO_READY"
  | "BUYING_INTENT"
  | "PURCHASE_READY"
  | "NEGOTIATION"
  | "ONBOARDING"
  | "CUSTOMER"
  | "CLOSED_LOST"
  | "NOT_INTERESTED"
  | "UNSUBSCRIBED";

export type NextBestActionType =
  | "ANSWER_ONLY"
  | "ANSWER_AND_QUALIFY"
  | "ANSWER_AND_ASK_ONE_QUESTION"
  | "ANSWER_AND_OFFER_DEMO"
  | "SEND_BOOKING_CTA"
  | "PROVIDE_PRICING"
  | "REQUEST_PRICING_REQUIREMENTS"
  | "PROVIDE_TECHNICAL_EXPLANATION"
  | "REQUEST_TECHNICAL_REQUIREMENTS"
  | "HANDLE_OBJECTION"
  | "PROVIDE_ROI_CONTEXT"
  | "PROVIDE_TRIAL_INFORMATION"
  | "START_ONBOARDING"
  | "REQUEST_ONBOARDING_INFORMATION"
  | "ESCALATE_TO_SALES"
  | "ESCALATE_TO_TECHNICAL"
  | "ESCALATE_TO_FOUNDER"
  | "SCHEDULE_FOLLOW_UP"
  | "NO_REPLY"
  | "SUPPRESS";

export interface NextBestActionResult {
  action: NextBestActionType;
  reason: string;
  meetingLinkAllowed: boolean;
  pricingAllowed: boolean;
  technicalAgentRequired: boolean;
  pricingAgentRequired: boolean;
  objectionAgentRequired: boolean;
  roiAgentRequired: boolean;
  humanReviewRequired: boolean;
  escalationReason?: string;
  questionsToAnswer: string[];
  questionsToAsk: string[];
  missingInformation: string[];
  confidence: number;
}

export interface ReplyPlan {
  contact: {
    name: string;
    company: string;
    email: string;
  };
  product: string;
  primaryIntent: ComprehensiveIntent;
  secondaryIntents: ComprehensiveIntent[];
  buyingStage: BuyingStage;
  purchaseReadiness: number;
  meetingReadiness: number;
  questionsToAnswer: string[];
  knownRelevantFacts: string[];
  objections: string[];
  missingInformation: string[];
  specialistsRequired: ("TECHNICAL" | "PRICING" | "OBJECTION" | "ROI")[];
  nextBestAction: NextBestActionType;
  sendBookingLink: boolean;
  sendOnboardingLink: boolean;
  reason: string;
}

export interface CTARegistryEntry {
  id: string;
  type: "BOOK_DEMO" | "WEBSITE" | "CUSTOMER_ONBOARDING" | "DOCUMENTATION" | "CONFIRMED_MEETING";
  provider: "GOOGLE_CALENDAR" | "WEBSITE" | "STRIPE_ONBOARDING" | "GOOGLE_MEET" | "CUSTOM";
  url: string;
  title: string;
  enabled: boolean;
  verificationStatus: "VERIFIED_ACTIVE" | "PENDING_VERIFICATION" | "DISABLED";
  lastVerifiedAt: string;
}

export interface EmailUnderstanding {
  primaryIntent: ComprehensiveIntent;
  secondaryIntents: ComprehensiveIntent[];
  explicitQuestions: string[];
  hiddenQuestions: string[];
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "FRUSTRATED" | "SKEPTICAL" | "ENTHUSIASTIC";
  urgency: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  commercialIntent: "HIGH" | "MEDIUM" | "LOW" | "NONE" | "IMMEDIATE";
  technicalDepth: "NONE" | "GENERAL" | "DETAILED" | "ARCHITECTURAL" | "DEEP" | "MODERATE" | "SURFACE";
  buyingSignals: string[];
  objections: string[];
  isOutOfOffice?: boolean;
  isAutomatedSystemMessage?: boolean;
  isUnsubscribeRequest?: boolean;
  isUnsubscribe?: boolean;
  isReferral?: boolean;
  referralContact?: { name: string; email: string };
}

export interface PurchaseReadinessResult {
  score: number; // 0 - 100
  signals: string[];
  reasoning: string;
}

export interface MeetingReadinessResult {
  score: number; // 0 - 100
  shouldOfferBooking: boolean;
  signals: string[];
  reasoning: string;
}

export interface ConversationDecisionLog {
  id: string;
  timestamp: string;
  conversationId: string;
  contactEmail: string;
  contactName: string;
  companyName: string;
  inboundMessageSnippet: string;
  identityResolution: ClientIdentityResolution;
  emailUnderstanding: EmailUnderstanding;
  buyingStage: {
    previous: BuyingStage;
    current: BuyingStage;
  };
  purchaseReadiness: PurchaseReadinessResult;
  meetingReadiness: MeetingReadinessResult;
  specialistsConsulted: {
    technical?: { verifiedCapabilities: string[]; answerSummary: string };
    pricing?: { packageOffered: string; pricingConfidence: number; customQuoteNeeded: boolean };
    objection?: { handledObjection: string; strategy: string };
    roi?: { metricEstimated: string; annualValueEstimated?: string };
  };
  nextBestAction: NextBestActionResult;
  replyPlan: ReplyPlan;
  generatedDraft: {
    subject: string;
    body: string;
  };
  auditorResult: {
    decision: "PASS" | "REWRITE" | "ESCALATE" | "BLOCK";
    score: number; // 0-100
    checksPassed: string[];
    issuesDetected: string[];
  };
  deterministicSafetyResult: {
    zeroPhoneClean: boolean;
    semanticLinkClean: boolean;
    mergeTagsClean: boolean;
    suppressionClean: boolean;
    duplicateLockClean: boolean;
    circuitBreakerClean: boolean;
  };
  finalDecision: "SEND_AUTONOMOUS" | "AWAITING_HUMAN_APPROVAL" | "SUPPRESSED_NO_ACTION" | "BLOCKED_BY_SAFETY";
  finalEmailBody?: string;
  whyExplanation: string;
}

export interface CircuitBreakerState {
  globalAutonomousSendEnabled: boolean;
  pausedReason?: string;
  consecutiveErrorCount: number;
  duplicateSendAlertTriggered: boolean;
  bounceRateSpikeDetected: boolean;
  lastSafetyTripTimestamp?: string;
}


