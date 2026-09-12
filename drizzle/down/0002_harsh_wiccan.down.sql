-- Reverses 0002_harsh_wiccan.
-- Written as the statement-by-statement inverse of the up, in reverse order (S5).
-- scripts/lib/migration-reverse.ts checks that this still inverts the up, on every gate;
-- scripts/db-rollback.ts refuses to run it without --allow-data-loss when it drops data.
-- data: DROPS_DATA
-- affects: organizations.superseded_by, organizations.valid_until, organizations.valid_from, organizations.last_verified_at, organizations.observed_at, conversations.superseded_by, conversations.valid_until, conversations.valid_from, conversations.last_verified_at, conversations.observed_at, conversation_facts.superseded_by, conversation_facts.valid_until, conversation_facts.valid_from, conversation_facts.last_verified_at, conversation_facts.observed_at, contacts.superseded_by, contacts.valid_until, contacts.valid_from, contacts.last_verified_at, contacts.observed_at, contacts.stakeholder_role, accounts.superseded_by, accounts.valid_until, accounts.valid_from, accounts.last_verified_at, accounts.observed_at, quote_snapshots, question_ledger, objection_ledger, oauth_connections, customer_commitments

ALTER TABLE "quote_snapshots" DROP CONSTRAINT "quote_snapshots_contact_id_contacts_id_fk";--> statement-breakpoint
ALTER TABLE "question_ledger" DROP CONSTRAINT "question_ledger_source_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "question_ledger" DROP CONSTRAINT "question_ledger_conversation_id_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "objection_ledger" DROP CONSTRAINT "objection_ledger_source_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "objection_ledger" DROP CONSTRAINT "objection_ledger_conversation_id_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "oauth_connections" DROP CONSTRAINT "oauth_connections_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "customer_commitments" DROP CONSTRAINT "customer_commitments_source_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "customer_commitments" DROP CONSTRAINT "customer_commitments_conversation_id_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "customer_commitments" DROP CONSTRAINT "customer_commitments_contact_id_contacts_id_fk";--> statement-breakpoint
ALTER TABLE "customer_commitments" DROP CONSTRAINT "customer_commitments_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "superseded_by";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "valid_until";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "valid_from";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "last_verified_at";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "observed_at";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "superseded_by";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "valid_until";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "valid_from";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "last_verified_at";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "observed_at";--> statement-breakpoint
ALTER TABLE "conversation_facts" DROP COLUMN "superseded_by";--> statement-breakpoint
ALTER TABLE "conversation_facts" DROP COLUMN "valid_until";--> statement-breakpoint
ALTER TABLE "conversation_facts" DROP COLUMN "valid_from";--> statement-breakpoint
ALTER TABLE "conversation_facts" DROP COLUMN "last_verified_at";--> statement-breakpoint
ALTER TABLE "conversation_facts" DROP COLUMN "observed_at";--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN "superseded_by";--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN "valid_until";--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN "valid_from";--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN "last_verified_at";--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN "observed_at";--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN "stakeholder_role";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "superseded_by";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "valid_until";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "valid_from";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "last_verified_at";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "observed_at";--> statement-breakpoint
DROP TABLE "quote_snapshots";--> statement-breakpoint
DROP TABLE "question_ledger";--> statement-breakpoint
DROP TABLE "objection_ledger";--> statement-breakpoint
DROP TABLE "oauth_connections";--> statement-breakpoint
DROP TABLE "customer_commitments";
