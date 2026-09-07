export enum EmailStatus {
  DRAFT = 'DRAFT',
  APPROVAL_REQUIRED = 'APPROVAL_REQUIRED',
  APPROVED = 'APPROVED',
  QUEUED = 'QUEUED',
  PROVIDER_ACCEPTED = 'PROVIDER_ACCEPTED',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  BOUNCED = 'BOUNCED',
  COMPLAINED = 'COMPLAINED',
  FAILED = 'FAILED',
  REPLIED = 'REPLIED',
  SUPPRESSED = 'SUPPRESSED',
  CANCELLED = 'CANCELLED'
}

export enum MeetingStatus {
  PROPOSED = 'PROPOSED',
  // P1.4 — POST /api/meetings has been persisting 'SCHEDULED' since before this enum existed,
  // so live meeting records already hold a value the domain does not define. Adding it stops
  // the divergence; removing it would make existing meetings unreadable.
  SCHEDULED = 'SCHEDULED',
  PENDING_CLIENT_CONFIRMATION = 'PENDING_CLIENT_CONFIRMATION',
  PENDING_CALENDAR_CREATION = 'PENDING_CALENDAR_CREATION',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
  NO_SHOW = 'NO_SHOW'
}

export enum PaymentStatus {
  NOT_STARTED = 'NOT_STARTED',
  CHECKOUT_CREATED = 'CHECKOUT_CREATED',
  PROCESSING = 'PROCESSING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED'
}

export enum ContractStatus {
  DRAFT = 'DRAFT',
  SENT_FOR_SIGNATURE = 'SENT_FOR_SIGNATURE',
  VIEWED = 'VIEWED',
  SIGNED = 'SIGNED',
  DECLINED = 'DECLINED',
  VOIDED = 'VOIDED'
}

export enum BuyingStage {
  NEW = 'NEW',
  CONTACTED = 'CONTACTED',
  ENGAGED = 'ENGAGED',
  DISCOVERY = 'DISCOVERY',
  SOLUTION_EVALUATION = 'SOLUTION_EVALUATION',
  SOLUTION_EXPLORING = 'SOLUTION_EXPLORING',
  PRODUCT_EVALUATING = 'PRODUCT_EVALUATING',
  TECHNICAL_EVALUATION = 'TECHNICAL_EVALUATION',
  COMMERCIAL_EVALUATION = 'COMMERCIAL_EVALUATION',
  DEMO_READY = 'DEMO_READY',
  DEMO_BOOKED = 'DEMO_BOOKED',
  TRIAL_READY = 'TRIAL_READY',
  TRIAL_ACTIVE = 'TRIAL_ACTIVE',
  PURCHASE_READY = 'PURCHASE_READY',
  NEGOTIATION = 'NEGOTIATION',
  CONTRACT_PENDING = 'CONTRACT_PENDING',
  PAYMENT_PENDING = 'PAYMENT_PENDING',
  ONBOARDING = 'ONBOARDING',
  CUSTOMER = 'CUSTOMER',
  FOLLOW_UP_LATER = 'FOLLOW_UP_LATER',
  NOT_INTERESTED = 'NOT_INTERESTED',
  UNSUBSCRIBED = 'UNSUBSCRIBED',
  CLOSED_LOST = 'CLOSED_LOST'
}

export enum MessageDirection {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND'
}

export enum NextBestAction {
  ANSWER_ONLY = 'ANSWER_ONLY',
  ANSWER_AND_QUALIFY = 'ANSWER_AND_QUALIFY',
  ASK_ONE_CLARIFYING_QUESTION = 'ASK_ONE_CLARIFYING_QUESTION',
  PROVIDE_TECHNICAL_INFORMATION = 'PROVIDE_TECHNICAL_INFORMATION',
  PROVIDE_PRICING = 'PROVIDE_PRICING',
  PREPARE_CUSTOM_QUOTE = 'PREPARE_CUSTOM_QUOTE',
  HANDLE_OBJECTION = 'HANDLE_OBJECTION',
  PROVIDE_CASE_STUDY = 'PROVIDE_CASE_STUDY',
  PROVIDE_DOCUMENT = 'PROVIDE_DOCUMENT',
  OFFER_DEMO = 'OFFER_DEMO',
  OFFER_MEETING = 'OFFER_MEETING',
  SEND_BOOKING_LINK = 'SEND_BOOKING_LINK',
  CREATE_CONFIRMED_MEETING = 'CREATE_CONFIRMED_MEETING',
  REQUEST_HUMAN_REVIEW = 'REQUEST_HUMAN_REVIEW',
  REQUEST_FOUNDER_REVIEW = 'REQUEST_FOUNDER_REVIEW',
  START_TRIAL = 'START_TRIAL',
  START_ONBOARDING = 'START_ONBOARDING',
  SEND_AGREEMENT = 'SEND_AGREEMENT',
  SEND_PAYMENT_LINK = 'SEND_PAYMENT_LINK',
  WAIT = 'WAIT',
  FOLLOW_UP_LATER = 'FOLLOW_UP_LATER',
  CLOSE_LOST = 'CLOSE_LOST',
  SUPPRESS = 'SUPPRESS',
  NO_REPLY = 'NO_REPLY'
}

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
  /**
   * P1.3 — Optimistic concurrency. Returned by every read and required by every write, so a
   * mutation states which revision it believes it is updating and a concurrent edit is a 409
   * rather than a silently discarded change.
   */
  version?: number;
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
  projectedMetrics?: { reach: number; engagement: number; conversion: number; };
  autonomyMode: 'MANUAL_APPROVAL' | 'SEMI_AUTONOMOUS' | 'FULL_AUTOPILOT';
  aiStrategySummary: string;
  isABTestingEnabled?: boolean;
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
  /**
   * S23 — `UNASSESSED` is the value for "no model read this conversation".
   *
   * The extractor used to fall back to `HIGHLY_INTERESTED` whenever the thread contained a
   * prospect message at all, so a model outage produced a confident sentiment reading of a
   * conversation nothing had read. Every other member is a claim; this one is its absence.
   */
  prospectSentiment: 'HIGHLY_INTERESTED' | 'EVALUATING' | 'PRICE_CONSCIOUS' | 'TECHNICAL_DEEP_DIVE' | 'SKEPTICAL' | 'READY_TO_BOOK' | 'UNASSESSED';
  keyFactsExtracted: Record<string, string>;
  threadSummaryChronological: string[];
  followUpCount: number;
  lastUpdated: string;
  /**
   * S23 — present when NO model read this conversation.
   *
   * Its absence is the claim. Downstream code that turns this memory into durable FACTS
   * must check it: a fact recorded from an abstention has no source, and it re-enters every
   * later prompt as though a customer had said it.
   */
  abstention?: { reason: string; detail: string };
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
  /** P1.3 — See Campaign.version. */
  version?: number;
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
  /**
   * P1.9 — `scheduledTime` alone was an instant with no record of what was agreed. It is kept
   * so existing readers keep working, and it now carries the same value as `startAtUtc`.
   *
   * `startAtUtc` + `timeZone` is the pair that means something: the instant is what a calendar
   * needs, and the zone is what lets the meeting be restated as "Tuesday at 2 your time" later,
   * re-rendered correctly after a tz-database update, or explained to a prospect in a different
   * country. Dropping the zone is not a compression — it is a fact we cannot recover.
   *
   * `null` on `startAtUtc` means no slot could be proposed. It is not a stand-in for "now".
   */
  scheduledTime: string | null;
  startAtUtc?: string | null;
  /** IANA identifier. Never an abbreviation: "BST" resolves to Asia/Dhaka, five hours out. */
  timeZone?: string;
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
    /**
     * P1.7 — Was `monthlyFee: number` beside `currency: string`, which let a bare 499 be
     * written with a "£" next to it and never checked against anything. Minor units, so a
     * float cannot drift a contract total by a penny, and the currency is a closed set.
     */
    monthlyFeeMinor: number;
    currency: 'GBP';
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
  /**
   * S27 — SIMULATED is a first-class outcome, and it is what a seeded or flag-disabled send
   * actually is.
   *
   * Without it the only available answers were SENT and DELIVERED, so a send that never left
   * the process was recorded as one that had. DELIVERED in particular is a claim about what a
   * recipient mail server did, and nothing in this system has ever heard from one — there is
   * no bounce or complaint webhook, so 'accepted by Gmail' and 'delivered' are not
   * distinguishable here either.
   */
  status: 'SIMULATED' | 'SENT' | 'DELIVERED' | 'OPENED' | 'REPLIED' | 'FAILED';
  /**
   * Optional, because it was fabricated wherever it was set — `97 + (i % 3)`, in the high
   * nineties by construction. A required score forces every writer to invent one.
   */
  qcScore?: number;
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
  autoReengageStaleLeads?: boolean;
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

/**
 * One recorded run of the autonomous pipeline (addendum §21, §46, §18).
 *
 * Nothing wrote one of these until the writer landed: `/api/logs` read a collection with no
 * producer, ordered by a field this shape does not have. The fields below the divider are what
 * makes a run reproducible — without them "why did it say that?" has no answer, because the
 * prompt was assembled from whatever was in scope and then discarded.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 * The customer's email text, the assembled prompt, and the drafted reply are NOT stored here.
 * A run log is read by operators and could be re-fed to a model; putting untrusted customer
 * text in it is how one injected sentence becomes a durable record the system quotes back to
 * itself (§18). `promptHashes` proves which prompt ran without retaining it, and
 * `conversationId`/`messageId` address the real content where it already lives.
 */
export interface AIRunLog {
  id: string;
  workspaceId: string;
  agentType: string;
  actionType: string;
  /** null when no model was called, or when the category was never established. */
  modelCategory: 'FAST' | 'SMART' | 'DEEP' | null;
  /** Did the run COMPLETE? What it decided is `disposition`. */
  status: 'SUCCESS' | 'FAILED';
  /**
   * `null` unless something actually computed one.
   *
   * This was a bare `number`, which invites a placeholder. A confidence nobody measured, shown
   * to an operator as a number, is worse than no confidence at all (§2).
   */
  confidence: number | null;
  summary: string;
  durationMs: number;
  createdAt: string;

  // --- §21 reproducibility. Optional so existing readers keep working.

  /** What the run decided, as distinct from whether it finished. */
  /**
   * S28 — AUTOMATED means the message was classified as machine-generated (a bounce, an
   * auto-reply, a mailing list) and NO model was asked about it. Distinct from SUPPRESSED,
   * which is a decision a model participated in: collapsing them would hide a bounce loop
   * inside the ordinary suppression count.
   */
  disposition?: 'QUEUED' | 'SUPPRESSED' | 'BLOCKED' | 'AUTOMATED' | 'ABSTAINED' | 'FAILED';
  /** Where a failed run stopped. */
  stage?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  /**
   * Every model that answered, in call order. A `null` entry is a total failover where the
   * caller received `fallbackData` — a failure that type-checks, and the one case where naming
   * a model would attribute an answer to one that never produced it.
   */
  models?: (string | null)[];
  /** sha256 of what was sent to each model. The prompt itself is never stored. */
  promptHashes?: (string | null)[];
  /**
   * The identity of the selected context (§21). `contextIds` is the manifest — every record
   * the model was shown, addressable — so the exact input can be reconstructed afterwards.
   * Null means no bundle was built, which is not the same as an empty one.
   */
  contextHash?: string | null;
  contextIds?: string[] | null;
  modelCalls?: number;
  /** Sum of PROVIDER-REPORTED tokens. A lower bound whenever `tokensArePartial` is true. */
  reportedTokens?: number;
  tokensArePartial?: boolean;
  unmeasuredCalls?: number;
  /**
   * Null, and it says why in `costEnforcement`. Converting tokens to pounds needs a per-model
   * price table that does not exist in this repository; a zero here would read as "free".
   */
  costMinor?: number | null;
  currency?: string | null;
  costEnforcement?: string | null;
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

/**
 * Whether each action means "send nothing at all".
 *
 * WHY THIS IS A RECORD OVER THE UNION, NOT A SET OF THE SUPPRESSING ONES
 * ---------------------------------------------------------------------
 * The inbound pipeline's suppression guard read:
 *
 *     if (nbaResult.action === 'DO_NOTHING' as any || nbaResult.action === 'SUPPRESS_NO_ACTION' as any)
 *
 * Neither string is a member of this union. The two casts are the only reason the compiler did
 * not report the comparison as impossible, and the guard was therefore dead: measured by
 * running the decision engine, an unsubscribe request returns `SUPPRESS` and an out-of-office
 * autoresponder returns `NO_REPLY`, and both fell straight through into composition and outbox
 * queueing. The one branch in the system that says "do not reply" could never fire, so the
 * pipeline's effective default was always to draft — §14 with the sign inverted.
 *
 * A `Record` keyed by the whole union means adding a member to `NextBestActionType` is a
 * COMPILE ERROR until somebody decides whether it replies. A `Set` of the suppressing ones
 * would silently classify every new action as "reply", which is the permissive direction.
 */
export const ACTION_SUPPRESSES_REPLY: Readonly<Record<NextBestActionType, boolean>> = Object.freeze({
  ANSWER_ONLY: false,
  ANSWER_AND_QUALIFY: false,
  ANSWER_AND_ASK_ONE_QUESTION: false,
  ANSWER_AND_OFFER_DEMO: false,
  SEND_BOOKING_CTA: false,
  PROVIDE_PRICING: false,
  REQUEST_PRICING_REQUIREMENTS: false,
  PROVIDE_TECHNICAL_EXPLANATION: false,
  REQUEST_TECHNICAL_REQUIREMENTS: false,
  HANDLE_OBJECTION: false,
  PROVIDE_ROI_CONTEXT: false,
  PROVIDE_TRIAL_INFORMATION: false,
  START_ONBOARDING: false,
  REQUEST_ONBOARDING_INFORMATION: false,
  ESCALATE_TO_SALES: false,
  ESCALATE_TO_TECHNICAL: false,
  ESCALATE_TO_FOUNDER: false,
  SCHEDULE_FOLLOW_UP: false,
  NO_REPLY: true,
  SUPPRESS: true,
});

/**
 * Does this action mean we send nothing?
 *
 * Takes `unknown` and FAILS CLOSED. An action that arrives from a model, a stored row or a
 * future member nobody classified is not a licence to email a customer: sending is the
 * permission here, so anything unrecognised suppresses (§14). The alternative —
 * `MAP[action] === true` on a plain lookup — returns `false` for an unknown string and sends.
 */
export function suppressesReply(action: unknown): boolean {
  if (typeof action !== 'string') return true;
  if (!Object.prototype.hasOwnProperty.call(ACTION_SUPPRESSES_REPLY, action)) return true;
  return ACTION_SUPPRESSES_REPLY[action as NextBestActionType];
}

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

/**
 * S24 — `ConversationDecisionLog` was DELETED here, not left in place.
 *
 * It was a 46-field interface with zero constructions and zero readers repo-wide: nothing
 * ever built one and nothing ever read one. Its only reference was a dead import in
 * independentAuditor.ts.
 *
 * The reason to remove it rather than leave it is that it declared a SECOND copy of the
 * auditor result — `auditorResult: { decision, score, checksPassed, issuesDetected }` plus
 * its own six-boolean `deterministicSafetyResult` — and that copy had already drifted from
 * the real one. The real `AuditResult` no longer has a `score` at all (severity is not
 * summed; see server/domain/adjudication.ts) and its safety record is tri-state, because a
 * boolean cannot say that a check did not run. A type nobody builds cannot be caught
 * drifting by the compiler, so it would have gone on describing an auditor that no longer
 * exists until someone believed it.
 *
 * `specialistsConsulted` went with it. It described four specialist agents; one exists
 * (technical.agent.ts) and its only call site is inside pipeline.service.ts, a second
 * inbound pipeline nothing imports.
 */

export interface CircuitBreakerState {
  globalAutonomousSendEnabled: boolean;
  pausedReason?: string;
  consecutiveErrorCount: number;
  duplicateSendAlertTriggered: boolean;
  bounceRateSpikeDetected: boolean;
  lastSafetyTripTimestamp?: string;
}


