-- Reverses 0000_jittery_talon.
-- Written as the statement-by-statement inverse of the up, in reverse order (S5).
-- scripts/lib/migration-reverse.ts checks that this still inverts the up, on every gate;
-- scripts/db-rollback.ts refuses to run it without --allow-data-loss when it drops data.
-- data: DROPS_DATA
-- affects: users, outbox_messages, organizations, messages, conversations, conversation_facts, contacts, accounts

ALTER TABLE "users" DROP CONSTRAINT "users_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "outbox_messages" DROP CONSTRAINT "outbox_messages_conversation_id_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_conversation_id_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_assigned_to_users_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_contact_id_contacts_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "conversation_facts" DROP CONSTRAINT "conversation_facts_source_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "conversation_facts" DROP CONSTRAINT "conversation_facts_contact_id_contacts_id_fk";--> statement-breakpoint
ALTER TABLE "conversation_facts" DROP CONSTRAINT "conversation_facts_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "conversation_facts" DROP CONSTRAINT "conversation_facts_conversation_id_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "contacts" DROP CONSTRAINT "contacts_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "contacts" DROP CONSTRAINT "contacts_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_organization_id_organizations_id_fk";--> statement-breakpoint
DROP TABLE "users";--> statement-breakpoint
DROP TABLE "outbox_messages";--> statement-breakpoint
DROP TABLE "organizations";--> statement-breakpoint
DROP TABLE "messages";--> statement-breakpoint
DROP TABLE "conversations";--> statement-breakpoint
DROP TABLE "conversation_facts";--> statement-breakpoint
DROP TABLE "contacts";--> statement-breakpoint
DROP TABLE "accounts";
