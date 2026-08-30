import { pgTable, text, timestamp, varchar, integer, boolean, jsonb } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const organizations = pgTable('organizations', {
  id: varchar('id', { length: 255 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).unique().notNull(),
  status: varchar('status', { length: 50 }).default('ACTIVE').notNull(),
  plan: varchar('plan', { length: 50 }).default('FREE').notNull(),
  timezone: varchar('timezone', { length: 50 }).default('UTC').notNull(),
  locale: varchar('locale', { length: 20 }).default('en-US').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const users = pgTable('users', {
  id: varchar('id', { length: 255 }).primaryKey(),
  organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
  email: varchar('email', { length: 255 }).unique().notNull(),
  name: varchar('name', { length: 255 }),
  role: varchar('role', { length: 50 }).default('VIEWER').notNull(),
  status: varchar('status', { length: 50 }).default('ACTIVE').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const accounts = pgTable('accounts', {
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
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const contacts = pgTable('contacts', {
  id: varchar('id', { length: 255 }).primaryKey(),
  organizationId: varchar('organization_id', { length: 255 }).references(() => organizations.id).notNull(),
  accountId: varchar('account_id', { length: 255 }).references(() => accounts.id),
  firstName: varchar('first_name', { length: 255 }),
  lastName: varchar('last_name', { length: 255 }),
  name: varchar('name', { length: 255 }),
  primaryEmail: varchar('primary_email', { length: 255 }).notNull(),
  title: varchar('title', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  linkedinUrl: varchar('linkedin_url', { length: 255 }),
  timezone: varchar('timezone', { length: 50 }),
  language: varchar('language', { length: 20 }),
  status: varchar('status', { length: 50 }).default('ACTIVE').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const conversations = pgTable('conversations', {
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
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const messages = pgTable('messages', {
  id: varchar('id', { length: 255 }).primaryKey(),
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
});

export const conversationFacts = pgTable('conversation_facts', {
  id: varchar('id', { length: 255 }).primaryKey(),
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
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const outboxMessages = pgTable('outbox_messages', {
  id: varchar('id', { length: 255 }).primaryKey(),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).unique().notNull(),
  conversationId: varchar('conversation_id', { length: 255 }).references(() => conversations.id).notNull(),
  payload: jsonb('payload').notNull(),
  status: varchar('status', { length: 50 }).default('PENDING').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  processedAt: timestamp('processed_at'),
});

export const campaigns = pgTable('campaigns', {
  id: varchar('id', { length: 255 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }).notNull(),
  targetAudience: varchar('target_audience', { length: 255 }),
  type: varchar('type', { length: 50 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const meetings = pgTable('meetings', {
  id: varchar('id', { length: 255 }).primaryKey(),
  contactId: varchar('contact_id', { length: 255 }).references(() => contacts.id).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }).notNull(),
  scheduledTime: timestamp('scheduled_time'),
  meetUrl: text('meet_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const opportunities = pgTable('opportunities', {
  id: varchar('id', { length: 255 }).primaryKey(),
  contactId: varchar('contact_id', { length: 255 }).references(() => contacts.id).notNull(),
  value: integer('value'),
  stage: varchar('stage', { length: 50 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const knowledgeItems = pgTable('knowledge_items', {
  id: varchar('id', { length: 255 }).primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  content: text('content').notNull(),
  category: varchar('category', { length: 50 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const attentionItems = pgTable('attention_items', {
  id: varchar('id', { length: 255 }).primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  priority: varchar('priority', { length: 50 }),
  type: varchar('type', { length: 50 }),
  actionType: varchar('action_type', { length: 50 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const aiRunLogs = pgTable('ai_run_logs', {
  id: varchar('id', { length: 255 }).primaryKey(),
  agentType: varchar('agent_type', { length: 50 }).notNull(),
  actionType: varchar('action_type', { length: 50 }),
  summary: text('summary'),
  status: varchar('status', { length: 50 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
