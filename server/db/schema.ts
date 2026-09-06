import { pgTable, text, timestamp, varchar, integer, boolean, jsonb, unique, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/**
 * P1.2 — TENANT COLUMNS AND COMPOSITE UNIQUES.
 *
 * WHAT WAS WRONG
 * --------------
 * Thirteen of the nineteen tables had no `organization_id` at all. `messages`,
 * `outbox_messages`, `campaigns`, `meetings`, `opportunities`, every ledger and every
 * knowledge row belonged to no tenant, which meant:
 *
 *   - A tenant predicate could not be written for them. Not "was not written" — could not be.
 *     There was no column to filter on, so `select ... where id = $1` was the only shape
 *     available, and any caller holding an id could read any tenant's row.
 *   - The uniqueness that actually prevents duplicate work did not exist. There was no
 *     constraint on (organisation, provider message id), so the same inbound email could be
 *     ingested twice and answered twice; none on (organisation, thread id), so one thread
 *     could fork into several conversations; none on (organisation, contact email), so the
 *     same person could exist many times and accumulate contradictory state.
 *
 * WHAT IS HERE NOW
 * ----------------
 * Every tenant-owned table carries `organization_id NOT NULL` with a foreign key, and the five
 * composite uniques the roadmap requires are declared. `users.email` is now unique per
 * organisation rather than globally, because a global unique on email means one person cannot
 * hold accounts in two tenants — which is a tenancy bug wearing a data-integrity costume.
 *
 * The uniques are deliberately TENANT-FIRST — `(organization_id, x)` rather than `(x)`. A
 * global unique on a provider message id would let one tenant's ingestion silently block
 * another's, which is a cross-tenant information leak as well as an outage.
 *
 * WHAT THIS DOES *NOT* PROVE
 * --------------------------
 * A constraint constrains nothing until something writes through it. This schema is Drizzle
 * over PostgreSQL, and `DATABASE_URL` is unset: the live datastore is Firestore, and the
 * Firestore write paths do not go through here. So these declarations are correct and
 * necessary, and they are not yet evidence that duplicates cannot occur in production. The
 * equivalent Firestore-side enforcement — deterministic document ids derived from the same
 * keys — is P1.5, and the store unification question is P1.13/P3.9.
 */

export const organizations = pgTable('organizations', {
  id: varchar('id', { length: 255 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).unique().notNull(),
  status: varchar('status', { length: 50 }).default('ACTIVE').notNull(),
  plan: varchar('plan', { length: 50 }).default('FREE').notNull(),
  timezone: varchar('timezone', { length: 50 }).default('UTC').notNull(),
  locale: varchar('locale', { length: 20 }).default('en-US').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  version: integer('version').default(0).notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  observedAt: timestamp('observed_at').defaultNow(),
  lastVerifiedAt: timestamp('last_verified_at'),
  validFrom: timestamp('valid_from'),
  validUntil: timestamp('valid_until'),
  supersededBy: varchar('superseded_by', { length: 255 }),
});

export const users = pgTable(
  'users',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    // P1.2 — Was `.unique()`, i.e. globally unique across every tenant. That is wrong twice
    // over: it stops one person holding an account in two organisations, and it turns
    // "is this address taken?" into a probe for the existence of a user in someone else's
    // tenant. Uniqueness is per organisation.
    email: varchar('email', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }),
    role: varchar('role', { length: 50 }).default('VIEWER').notNull(),
    status: varchar('status', { length: 50 }).default('ACTIVE').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
  },
  (t) => [unique('users_org_email_unique').on(t.organizationId, t.email)]
);

export const accounts = pgTable(
  'accounts',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    domain: varchar('domain', { length: 255 }),
    website: varchar('website', { length: 255 }),
    industry: varchar('industry', { length: 100 }),
    employeeCount: integer('employee_count'),
    country: varchar('country', { length: 100 }),
    metadata: jsonb('metadata'),
    lifecycleStage: varchar('lifecycle_stage', { length: 50 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    observedAt: timestamp('observed_at').defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at'),
    validFrom: timestamp('valid_from'),
    validUntil: timestamp('valid_until'),
    supersededBy: varchar('superseded_by', { length: 255 }),
  },
  (t) => [index('accounts_org_idx').on(t.organizationId)]
);

export const contacts = pgTable(
  'contacts',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    accountId: varchar('account_id', { length: 255 }).references(() => accounts.id),
    firstName: varchar('first_name', { length: 255 }),
    lastName: varchar('last_name', { length: 255 }),
    name: varchar('name', { length: 255 }),
    primaryEmail: varchar('primary_email', { length: 255 }).notNull(),
    /**
     * P1.2 — The normalised form of primaryEmail, and the column the uniqueness constraint
     * actually uses.
     *
     * Constraining `primary_email` directly would not work: `Alice@Example.com ` and
     * `alice@example.com` are different strings and the same person, so a unique on the raw
     * value permits exactly the duplicates it appears to prevent. The derived key is what
     * makes the constraint mean what it says.
     *
     * Normalisation itself (the shared module every writer must use) is P1.5. Until that
     * lands this column exists and is constrained, but nothing populates it.
     */
    emailKey: varchar('email_key', { length: 255 }).notNull(),
    title: varchar('title', { length: 255 }),
    phone: varchar('phone', { length: 50 }),
    linkedinUrl: varchar('linkedin_url', { length: 255 }),
    timezone: varchar('timezone', { length: 50 }),
    language: varchar('language', { length: 20 }),
    stakeholderRole: varchar('stakeholder_role', { length: 50 }).default('UNKNOWN'),
    status: varchar('status', { length: 50 }).default('ACTIVE').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    observedAt: timestamp('observed_at').defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at'),
    validFrom: timestamp('valid_from'),
    validUntil: timestamp('valid_until'),
    supersededBy: varchar('superseded_by', { length: 255 }),
  },
  (t) => [
    // REQUIRED UNIQUE 1 of 5 — contact normalised email, per tenant.
    unique('contacts_org_email_key_unique').on(t.organizationId, t.emailKey),
    index('contacts_org_idx').on(t.organizationId),
  ]
);

export const conversations = pgTable(
  'conversations',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    accountId: varchar('account_id', { length: 255 }).references(() => accounts.id),
    contactId: varchar('contact_id', { length: 255 }).references(() => contacts.id).notNull(),
    providerThreadId: varchar('provider_thread_id', { length: 255 }),
    subject: text('subject'),
    status: varchar('status', { length: 50 }).notNull(),
    category: varchar('category', { length: 50 }),
    lastMessageAt: timestamp('last_message_at').defaultNow().notNull(),
    latestIntent: varchar('latest_intent', { length: 100 }),
    buyingStage: varchar('buying_stage', { length: 50 }),
    meetingReadiness: integer('meeting_readiness'),
    purchaseReadiness: integer('purchase_readiness'),
    nextBestAction: varchar('next_best_action', { length: 100 }),
    assignedTo: varchar('assigned_to', { length: 255 }).references(() => users.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    observedAt: timestamp('observed_at').defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at'),
    validFrom: timestamp('valid_from'),
    validUntil: timestamp('valid_until'),
    supersededBy: varchar('superseded_by', { length: 255 }),
  },
  (t) => [
    // REQUIRED UNIQUE 2 of 5 — one conversation per provider thread, per tenant.
    // Without it a thread forks: two conversations, two histories, two drafts, and the §8
    // inbound-version check protecting each one is blind to the other.
    // NULL provider_thread_id rows are exempt in PostgreSQL, which is correct here: a
    // conversation not yet linked to a provider thread is not a duplicate of another one.
    unique('conversations_org_thread_unique').on(t.organizationId, t.providerThreadId),
    index('conversations_org_idx').on(t.organizationId),
  ]
);

export const messages = pgTable(
  'messages',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    conversationId: varchar('conversation_id', { length: 255 }).references(() => conversations.id).notNull(),
    provider: varchar('provider', { length: 50 }), // GMAIL
    providerMessageId: varchar('provider_message_id', { length: 255 }),
    providerThreadId: varchar('provider_thread_id', { length: 255 }),
    messageIdHeader: varchar('message_id_header', { length: 255 }),
    inReplyTo: varchar('in_reply_to', { length: 255 }),
    references: text('references'),
    direction: varchar('direction', { length: 50 }).notNull(),
    sender: varchar('sender', { length: 255 }).notNull(),
    recipients: jsonb('recipients'),
    cc: jsonb('cc'),
    bcc: jsonb('bcc'),
    subject: text('subject'),
    textBody: text('text_body'),
    sanitizedHtmlBody: text('sanitized_html_body'),
    rawMetadata: jsonb('raw_metadata'),
    receivedAt: timestamp('received_at'),
    sentAt: timestamp('sent_at'),
    status: varchar('status', { length: 50 }).notNull(),
    isAutomated: boolean('is_automated').default(false).notNull(),
    automationClassification: varchar('automation_classification', { length: 50 }),
    source: varchar('source', { length: 50 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    // REQUIRED UNIQUE 3 of 5 — a provider message is ingested at most once, per tenant.
    // Gmail push delivery is at-least-once and replays on redelivery, so without this the
    // same customer email is processed twice, advancing the inbound version twice and
    // producing two replies.
    unique('messages_org_provider_msg_unique').on(t.organizationId, t.provider, t.providerMessageId),
    index('messages_org_conversation_idx').on(t.organizationId, t.conversationId),
  ]
);

export const conversationFacts = pgTable(
  'conversation_facts',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    conversationId: varchar('conversation_id', { length: 255 }).references(() => conversations.id).notNull(),
    accountId: varchar('account_id', { length: 255 }).references(() => accounts.id),
    contactId: varchar('contact_id', { length: 255 }).references(() => contacts.id),
    key: varchar('key', { length: 255 }).notNull(),
    value: text('value').notNull(),
    sourceType: varchar('source_type', { length: 50 }).notNull(),
    sourceMessageId: varchar('source_message_id', { length: 255 }).references(() => messages.id),
    confidence: integer('confidence'),
    verificationStatus: varchar('verification_status', { length: 50 }).default('UNVERIFIED').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    observedAt: timestamp('observed_at').defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at'),
    validFrom: timestamp('valid_from'),
    validUntil: timestamp('valid_until'),
    supersededBy: varchar('superseded_by', { length: 255 }),
  },
  (t) => [index('conversation_facts_org_conversation_idx').on(t.organizationId, t.conversationId)]
);

export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    // P1.2 — Was globally unique. An idempotency key is only meaningful within the tenant that
    // minted it; globally unique means one tenant's key can suppress another tenant's send,
    // which is a silent non-delivery that looks like successful deduplication.
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    conversationId: varchar('conversation_id', { length: 255 }).references(() => conversations.id).notNull(),
    payload: jsonb('payload').notNull(),
    status: varchar('status', { length: 50 }).default('PENDING').notNull(),
    error: text('error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    processedAt: timestamp('processed_at'),
  },
  (t) => [
    unique('outbox_org_idempotency_unique').on(t.organizationId, t.idempotencyKey),
    index('outbox_org_status_idx').on(t.organizationId, t.status),
  ]
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    status: varchar('status', { length: 50 }).notNull(),
    targetAudience: varchar('target_audience', { length: 255 }),
    type: varchar('type', { length: 50 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
  },
  (t) => [index('campaigns_org_idx').on(t.organizationId)]
);

/**
 * P1.2 — REQUIRED UNIQUE 4 of 5: campaign recipient.
 *
 * This table did not exist. Campaigns had no recipients: `server.ts` generated step text and
 * wrote it to Firestore, and a grep for `stepNumber` or `delayDays` across the workers and
 * services returned nothing, so campaign execution had no owner at all.
 *
 * The constraint the roadmap requires is "one enrolment per (campaign, contact) per tenant",
 * and it needs somewhere to live. It is declared here so that when campaign execution is
 * built (P1.4) it cannot be built without it — enrolling the same contact twice, or replaying
 * an enrolment after a crash, has to fail at the database rather than send a second sequence.
 *
 * BE CLEAR ABOUT WHAT THIS IS: nothing writes to this table yet. The constraint is unexercised
 * and proves nothing about the running system. It is scaffolding placed deliberately, not
 * evidence of a working control.
 */
export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    campaignId: varchar('campaign_id', { length: 255 }).references(() => campaigns.id).notNull(),
    contactId: varchar('contact_id', { length: 255 }).references(() => contacts.id).notNull(),
    stepNumber: integer('step_number').default(0).notNull(),
    status: varchar('status', { length: 50 }).default('ENROLLED').notNull(),
    lastStepSentAt: timestamp('last_step_sent_at'),
    nextStepDueAt: timestamp('next_step_due_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    unique('campaign_recipients_org_campaign_contact_unique').on(
      t.organizationId,
      t.campaignId,
      t.contactId
    ),
    index('campaign_recipients_due_idx').on(t.organizationId, t.status, t.nextStepDueAt),
  ]
);

export const meetings = pgTable(
  'meetings',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    contactId: varchar('contact_id', { length: 255 }).references(() => contacts.id).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    status: varchar('status', { length: 50 }).notNull(),
    scheduledTime: timestamp('scheduled_time'),
    meetUrl: text('meet_url'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
  },
  (t) => [index('meetings_org_scheduled_idx').on(t.organizationId, t.scheduledTime)]
);

export const opportunities = pgTable(
  'opportunities',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    contactId: varchar('contact_id', { length: 255 }).references(() => contacts.id).notNull(),
    value: integer('value'),
    stage: varchar('stage', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
  },
  (t) => [index('opportunities_org_idx').on(t.organizationId)]
);

export const knowledgeItems = pgTable(
  'knowledge_items',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    content: text('content').notNull(),
    category: varchar('category', { length: 50 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
  },
  (t) => [index('knowledge_items_org_idx').on(t.organizationId)]
);

export const attentionItems = pgTable(
  'attention_items',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    priority: varchar('priority', { length: 50 }),
    type: varchar('type', { length: 50 }),
    actionType: varchar('action_type', { length: 50 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
  },
  (t) => [index('attention_items_org_idx').on(t.organizationId)]
);

export const oauthConnections = pgTable(
  'oauth_connections',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    provider: varchar('provider', { length: 50 }).notNull(),
    accountEmail: varchar('account_email', { length: 255 }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    expiresAt: timestamp('expires_at'),
    status: varchar('status', { length: 50 }).default('ACTIVE').notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    observedAt: timestamp('observed_at').defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at'),
    validFrom: timestamp('valid_from'),
    validUntil: timestamp('valid_until'),
    supersededBy: varchar('superseded_by', { length: 255 }),
  },
  (t) => [
    // REQUIRED UNIQUE 5 of 5 — one connection per (tenant, provider, account).
    // Duplicate rows here are how a token refresh updates one row while the sync worker keeps
    // reading another, so a connection appears healthy and healthy-looking sends fail.
    unique('oauth_org_provider_account_unique').on(t.organizationId, t.provider, t.accountEmail),
  ]
);

export const aiRunLogs = pgTable(
  'ai_run_logs',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    agentType: varchar('agent_type', { length: 50 }).notNull(),
    actionType: varchar('action_type', { length: 50 }),
    summary: text('summary'),
    status: varchar('status', { length: 50 }),

    /**
     * P1.8 — What the model was actually shown, and what it cost (§21).
     *
     * Without these a bad reply cannot be explained. "Why did it say that?" has no answer
     * when the prompt was assembled by concatenating whatever happened to be in scope and
     * then discarded. `contextIds` is the manifest from buildContextBundle: every record that
     * went in, addressable, so the exact input can be reconstructed afterwards.
     *
     * `promptHash` and `contextHash` are separate on purpose. The same context can produce a
     * different prompt if the template changes, and the same prompt can be built from
     * different context if selection changes — telling those two apart is the difference
     * between "we changed the wording" and "we showed it different facts".
     */
    model: varchar('model', { length: 100 }),
    promptHash: varchar('prompt_hash', { length: 64 }),
    contextHash: varchar('context_hash', { length: 64 }),
    contextIds: text('context_ids'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    /** Cost in minor units, so a fraction of a penny cannot drift a total (see P1.7). */
    costMinor: integer('cost_minor'),
    currency: varchar('currency', { length: 3 }),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  // Per-tenant cost and usage attribution is impossible without organization_id; that it was
  // missing is part of why S46 (budgets) has nothing to enforce against. The reproducibility
  // fields above landed with P1.8; what remains for P3.5 is the prompt VERSION (the template
  // identity, as distinct from the hash of one rendering of it).
  (t) => [index('ai_run_logs_org_idx').on(t.organizationId, t.createdAt)]
);

export const customerCommitments = pgTable(
  'customer_commitments',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    accountId: varchar('account_id', { length: 255 }).references(() => accounts.id),
    contactId: varchar('contact_id', { length: 255 }).references(() => contacts.id).notNull(),
    conversationId: varchar('conversation_id', { length: 255 }).references(() => conversations.id).notNull(),
    commitment: text('commitment').notNull(),
    sourceMessageId: varchar('source_message_id', { length: 255 }).references(() => messages.id),
    madeBy: varchar('made_by', { length: 255 }),
    dueDate: timestamp('due_date'),
    status: varchar('status', { length: 50 }).notNull(),
    riskLevel: varchar('risk_level', { length: 50 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    observedAt: timestamp('observed_at').defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at'),
    validFrom: timestamp('valid_from'),
    validUntil: timestamp('valid_until'),
    supersededBy: varchar('superseded_by', { length: 255 }),
  },
  (t) => [index('customer_commitments_org_conversation_idx').on(t.organizationId, t.conversationId)]
);

export const questionLedger = pgTable(
  'question_ledger',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    conversationId: varchar('conversation_id', { length: 255 }).references(() => conversations.id).notNull(),
    questionText: text('question_text').notNull(),
    status: varchar('status', { length: 50 }).notNull(), // OPEN, PARTIALLY_ANSWERED, ANSWERED, DEFERRED, HUMAN_REQUIRED
    sourceMessageId: varchar('source_message_id', { length: 255 }).references(() => messages.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    observedAt: timestamp('observed_at').defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at'),
    validFrom: timestamp('valid_from'),
    validUntil: timestamp('valid_until'),
    supersededBy: varchar('superseded_by', { length: 255 }),
  },
  (t) => [index('question_ledger_org_conversation_idx').on(t.organizationId, t.conversationId)]
);

export const objectionLedger = pgTable(
  'objection_ledger',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    conversationId: varchar('conversation_id', { length: 255 }).references(() => conversations.id).notNull(),
    type: varchar('type', { length: 100 }),
    statement: text('statement').notNull(),
    sourceMessageId: varchar('source_message_id', { length: 255 }).references(() => messages.id),
    severity: varchar('severity', { length: 50 }),
    status: varchar('status', { length: 50 }).notNull(),
    resolution: text('resolution'),
    resolvedAt: timestamp('resolved_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    observedAt: timestamp('observed_at').defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at'),
    validFrom: timestamp('valid_from'),
    validUntil: timestamp('valid_until'),
    supersededBy: varchar('superseded_by', { length: 255 }),
  },
  (t) => [index('objection_ledger_org_conversation_idx').on(t.organizationId, t.conversationId)]
);

export const quoteSnapshots = pgTable(
  'quote_snapshots',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    contactId: varchar('contact_id', { length: 255 }).references(() => contacts.id).notNull(),
    pricingVersion: varchar('pricing_version', { length: 100 }),
    details: jsonb('details'),
    quotedAt: timestamp('quoted_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at'),
    status: varchar('status', { length: 50 }).notNull(),
  },
  (t) => [index('quote_snapshots_org_contact_idx').on(t.organizationId, t.contactId)]
);
