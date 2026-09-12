import { pgTable, text, timestamp, varchar, integer, boolean, jsonb, unique, index, primaryKey, check, pgPolicy } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

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
 * A constraint constrains nothing until something writes through it.
 *
 * When this was written the paragraph here said the live datastore was Firestore and these
 * declarations had no writer. **That is no longer true (2026-09-08).** PostgreSQL is the only
 * datastore; `documents` below holds the collections that used to live in Firestore.
 *
 * The caution survives the change, in a narrower form. These uniques still bind only the
 * tables that something writes THROUGH — the relational path (`inboundPipeline` for
 * conversations and messages, `privacy` and `suppression` for contacts). Records written as
 * DOCUMENTS are constrained by their path and primary key, not by the composite uniques above,
 * so the equivalent enforcement there is still the deterministic document id (P1.5). Folding
 * the collections into these tables is outstanding and is not what the document store did.
 */

export const organizations = pgTable('organizations', {
  id: varchar('id', { length: 255 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).unique().notNull(),
  status: varchar('status', { length: 50 }).default('ACTIVE').notNull(),
  plan: varchar('plan', { length: 50 }).default('FREE').notNull(),
  timezone: varchar('timezone', { length: 50 }).default('UTC').notNull(),
  locale: varchar('locale', { length: 20 }).default('en-US').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  version: integer('version').default(0).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  validFrom: timestamp('valid_from', { withTimezone: true }),
  validUntil: timestamp('valid_until', { withTimezone: true }),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
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
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).defaultNow().notNull(),
    latestIntent: varchar('latest_intent', { length: 100 }),
    buyingStage: varchar('buying_stage', { length: 50 }),
    meetingReadiness: integer('meeting_readiness'),
    purchaseReadiness: integer('purchase_readiness'),
    nextBestAction: varchar('next_best_action', { length: 100 }),
    assignedTo: varchar('assigned_to', { length: 255 }).references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
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
    // S16/S35 — renamed 2026-09-07. It was `sanitizedHtmlBody`/`sanitized_html_body`,
    // and it held raw provider HTML: the name asserted a property that no code in the
    // repository provided, and a reviewer reading the schema would reasonably conclude a
    // sanitizer existed. `htmlAsText` is the rendering that is safe to read.
    rawHtmlBody: text('raw_html_body'),
    htmlAsText: text('html_as_text'),
    rawMetadata: jsonb('raw_metadata'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    status: varchar('status', { length: 50 }).notNull(),
    isAutomated: boolean('is_automated').default(false).notNull(),
    automationClassification: varchar('automation_classification', { length: 50 }),
    source: varchar('source', { length: 50 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    supersededBy: varchar('superseded_by', { length: 255 }),
  },
  (t) => [index('conversation_facts_org_conversation_idx').on(t.organizationId, t.conversationId)]
);

/**
 * RETIRED. THE LIVE QUEUE IS `server/services/outbox.service.ts`, IN THE DOCUMENT STORE.
 *
 * This table is kept, not dropped, and neither is a neutral choice — so here is the reasoning.
 *
 * WHY IT IS DEAD
 * --------------
 * P0.7 found the producer writing THIS table while `outbox.worker` polled a different store
 * entirely, so nothing enqueued here was ever consumed. Both sides were moved onto one store,
 * and that store is the document store (§1x). Since then this table has had no writer, no
 * reader, and — after the two shadow services were deleted — no importer.
 *
 * WHY IT IS STILL HERE
 * --------------------
 * P0.7 established that the producer DID write it for some period, so a deployed database may
 * hold rows. Dropping a table that might contain a record of real mail, to tidy a schema, is
 * not a trade worth making; the rows cost nothing and are evidence.
 *
 * WHY THAT IS DANGEROUS, AND WHAT GUARDS IT
 * -----------------------------------------
 * A table with a tenant index and an idempotency constraint READS as the live outbox. Someone
 * will write to it, the worker will not see it, and the message will silently never send —
 * which is P0.7 returning, in a form that looks like working code.
 *
 * `deadSchema.invariant.test.ts` fails if anything inserts into or updates it. Reviving it is
 * then a deliberate act with an argument attached, rather than an afternoon's misunderstanding.
 */
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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
/**
 * RETIRED (S26, 2026-09-12). Declared under P1.2 for the campaign engine, with the right unique
 * constraint; never written. It cannot be used for the engine: its foreign keys point at the
 * relational `campaigns` and `contacts` tables, and both campaigns and contacts are documents.
 * The live records are documents under `organizations/<org>/campaignEnrolments`, written by
 * server/services/campaignEngine.service.ts with the id derived from (campaign, contact). Do
 * not write here; a row here is read by nothing.
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
    lastStepSentAt: timestamp('last_step_sent_at', { withTimezone: true }),
    nextStepDueAt: timestamp('next_step_due_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
    // P1.9 — a meeting is an instant PLUS the zone it was agreed in. The instant is what the
    // calendar needs; the zone is what lets us say "Tuesday at 2 your time" a year later,
    // re-render correctly after a tz-database update, and tell a prospect in Dhaka what their
    // London meeting means for them. Storing only the instant throws the agreement away.
    startAtUtc: timestamp('start_at_utc', { withTimezone: true }),
    timeZone: varchar('time_zone', { length: 64 }),
    durationMinutes: integer('duration_minutes'),
    meetUrl: text('meet_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
  },
  (t) => [index('meetings_org_scheduled_idx').on(t.organizationId, t.startAtUtc)]
);

export const opportunities = pgTable(
  'opportunities',
  {
    id: varchar('id', { length: 255 }).primaryKey(),
    organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
    contactId: varchar('contact_id', { length: 255 }).references(() => contacts.id).notNull(),
    value: integer('value'),
    stage: varchar('stage', { length: 50 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    status: varchar('status', { length: 50 }).default('ACTIVE').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    supersededBy: varchar('superseded_by', { length: 255 }),
  },
  (t) => [
    // REQUIRED UNIQUE 5 of 5 — one connection per (tenant, provider, account).
    // Duplicate rows here are how a token refresh updates one row while the sync worker keeps
    // reading another, so a connection appears healthy and healthy-looking sends fail.
    unique('oauth_org_provider_account_unique').on(t.organizationId, t.provider, t.accountEmail),
  ]
);

/*
 * `ai_run_logs` was declared here from 0001 to 0007 and never had a writer: the run log has been
 * written to the document collection of the same name since §1p (server/lib/runLog.ts). It was
 * RETIRED in S22 and guarded by deadSchema.invariant until S5 could drop it properly — migration
 * 0008 is the contract step, and drizzle/down/0008_*.down.sql is the reverse that recreates it.
 * The guard now holds the symbol absent rather than retired.
 */


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
    dueDate: timestamp('due_date', { withTimezone: true }),
    status: varchar('status', { length: 50 }).notNull(),
    riskLevel: varchar('risk_level', { length: 50 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
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
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
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
    quotedAt: timestamp('quoted_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    status: varchar('status', { length: 50 }).notNull(),
  },
  (t) => [index('quote_snapshots_org_contact_idx').on(t.organizationId, t.contactId)]
);

/**
 * THE DOCUMENT COLLECTIONS — the other half of the store, now in the same database.
 *
 * Firestore held thirteen collections that no relational table above ever received: the outbox
 * and its operator actions, the identity and fact stores, circuit-breaker state, action logs,
 * members, settings and the company brain. The producer wrote PostgreSQL and the consumer read
 * Firestore, so every guard in this repository enforced against a store the send path did not
 * write. `server/store/index.ts` explains that split in full.
 *
 * This table ends it. One database, one transaction manager — a relational write and a
 * document write can now commit or fail together, because they are the same transaction.
 *
 * IT IS A DOCUMENT STORE, NOT A NORMALISATION, and saying so is the point. The twenty tables
 * above are unchanged and these collections are not folded into them; that per-entity
 * migration is outstanding and recorded as outstanding. A shim described as a unified schema
 * would be exactly the unchecked completion claim this codebase's audit exists to catch.
 *
 * `org_id` is DERIVED from the path (`organizations/{orgId}/...`) rather than passed, so it
 * cannot disagree with the path stored beside it, and it is a column rather than a string
 * prefix so that tenancy is a question SQL can answer. It carries no foreign key: top-level
 * collections (`oauth_connections`, `system_settings`) legitimately have no tenant, and the
 * `organizations` collection itself would be circular at bootstrap.
 */
export const documents = pgTable(
  'documents',
  {
    path: text('path').notNull(),
    id: text('id').notNull(),
    organizationId: varchar('org_id', { length: 255 }),
    data: jsonb('data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.path, t.id] }),
    index('documents_org_idx').on(t.organizationId),
    index('documents_path_idx').on(t.path),
    // S4 — `org_id` is the tenant the path names, or null for a top-level collection, and the
    // database holds that rather than trusting the writer: the same rule as `tenantOf` in
    // server/store/index.ts, in SQL.
    check(
      'documents_org_matches_path',
      sql`org_id IS NOT DISTINCT FROM (CASE WHEN split_part(path, '/', 1) = 'organizations' AND split_part(path, '/', 3) <> '' THEN split_part(path, '/', 2) ELSE NULL END)`
    ),
    // S4 — a connection sees, and may write, only the tenant it has NAMED through `app.org_id`
    // (set by the store, per statement, from the path), plus the tenantless documents. A
    // connection that names no tenant sees no tenant. Row security is FORCED by the migration
    // so the owning role is subject to it too; the application role is neither owner nor
    // superuser, which db-verify checks.
    pgPolicy('documents_tenant', {
      for: 'all',
      to: 'public',
      using: sql`org_id IS NULL OR org_id = current_setting('app.org_id', true)`,
      withCheck: sql`org_id IS NULL OR org_id = current_setting('app.org_id', true)`,
    }),
  ]
).enableRLS();
