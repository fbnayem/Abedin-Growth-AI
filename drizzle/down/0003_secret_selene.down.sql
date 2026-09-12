-- Reverses 0003_secret_selene.
-- Written as the statement-by-statement inverse of the up, in reverse order (S5).
-- scripts/lib/migration-reverse.ts checks that this still inverts the up, on every gate;
-- scripts/db-rollback.ts refuses to run it without --allow-data-loss when it drops data.
-- data: DROPS_DATA
-- affects: quote_snapshots.organization_id, question_ledger.organization_id, outbox_messages.organization_id, opportunities.organization_id, objection_ledger.organization_id, messages.organization_id, meetings.organization_id, knowledge_items.organization_id, customer_commitments.organization_id, conversation_facts.organization_id, contacts.email_key, campaigns.organization_id, attention_items.organization_id, ai_run_logs.organization_id, campaign_recipients
-- 11 statement(s) of the up (backfills, checks) have no reverse: the columns they filled are dropped.

ALTER TABLE "users" DROP CONSTRAINT "users_org_email_unique";--> statement-breakpoint
ALTER TABLE "outbox_messages" DROP CONSTRAINT "outbox_org_idempotency_unique";--> statement-breakpoint
ALTER TABLE "oauth_connections" DROP CONSTRAINT "oauth_org_provider_account_unique";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_org_provider_msg_unique";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_org_thread_unique";--> statement-breakpoint
ALTER TABLE "contacts" DROP CONSTRAINT "contacts_org_email_key_unique";--> statement-breakpoint
DROP INDEX "quote_snapshots_org_contact_idx";--> statement-breakpoint
DROP INDEX "question_ledger_org_conversation_idx";--> statement-breakpoint
DROP INDEX "outbox_org_status_idx";--> statement-breakpoint
DROP INDEX "opportunities_org_idx";--> statement-breakpoint
DROP INDEX "objection_ledger_org_conversation_idx";--> statement-breakpoint
DROP INDEX "messages_org_conversation_idx";--> statement-breakpoint
DROP INDEX "meetings_org_scheduled_idx";--> statement-breakpoint
DROP INDEX "knowledge_items_org_idx";--> statement-breakpoint
DROP INDEX "customer_commitments_org_conversation_idx";--> statement-breakpoint
DROP INDEX "conversations_org_idx";--> statement-breakpoint
DROP INDEX "conversation_facts_org_conversation_idx";--> statement-breakpoint
DROP INDEX "contacts_org_idx";--> statement-breakpoint
DROP INDEX "campaigns_org_idx";--> statement-breakpoint
DROP INDEX "attention_items_org_idx";--> statement-breakpoint
DROP INDEX "ai_run_logs_org_idx";--> statement-breakpoint
DROP INDEX "accounts_org_idx";--> statement-breakpoint
DROP INDEX "campaign_recipients_due_idx";--> statement-breakpoint
ALTER TABLE "quote_snapshots" DROP CONSTRAINT "quote_snapshots_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "question_ledger" DROP CONSTRAINT "question_ledger_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "outbox_messages" DROP CONSTRAINT "outbox_messages_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "opportunities" DROP CONSTRAINT "opportunities_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "objection_ledger" DROP CONSTRAINT "objection_ledger_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "meetings" DROP CONSTRAINT "meetings_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "knowledge_items" DROP CONSTRAINT "knowledge_items_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "customer_commitments" DROP CONSTRAINT "customer_commitments_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "conversation_facts" DROP CONSTRAINT "conversation_facts_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "attention_items" DROP CONSTRAINT "attention_items_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "ai_run_logs" DROP CONSTRAINT "ai_run_logs_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "campaign_recipients" DROP CONSTRAINT "campaign_recipients_contact_id_contacts_id_fk";--> statement-breakpoint
ALTER TABLE "campaign_recipients" DROP CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk";--> statement-breakpoint
ALTER TABLE "campaign_recipients" DROP CONSTRAINT "campaign_recipients_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "quote_snapshots" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question_ledger" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_messages" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_items" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_facts" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "email_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attention_items" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_run_logs" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
-- (no reverse for: DO $$)--> statement-breakpoint
-- (no reverse for: UPDATE "quote_snapshots" q)--> statement-breakpoint
-- (no reverse for: UPDATE "opportunities" o)--> statement-breakpoint
-- (no reverse for: UPDATE "meetings" m)--> statement-breakpoint
-- (no reverse for: UPDATE "objection_ledger" x)--> statement-breakpoint
-- (no reverse for: UPDATE "question_ledger" x)--> statement-breakpoint
-- (no reverse for: UPDATE "customer_commitments" x)--> statement-breakpoint
-- (no reverse for: UPDATE "outbox_messages" o)--> statement-breakpoint
-- (no reverse for: UPDATE "conversation_facts" f)--> statement-breakpoint
-- (no reverse for: UPDATE "messages" m)--> statement-breakpoint
-- (no reverse for: UPDATE "contacts")--> statement-breakpoint
ALTER TABLE "quote_snapshots" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "question_ledger" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "outbox_messages" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "opportunities" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "objection_ledger" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "knowledge_items" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "customer_commitments" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "conversation_facts" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN "email_key";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "attention_items" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "ai_run_logs" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_idempotency_key_unique" UNIQUE("idempotency_key");--> statement-breakpoint
DROP TABLE "campaign_recipients";
