-- Reverses 0004_ancient_tony_stark.
-- Written as the statement-by-statement inverse of the up, in reverse order (S5).
-- scripts/lib/migration-reverse.ts checks that this still inverts the up, on every gate;
-- scripts/db-rollback.ts refuses to run it without --allow-data-loss when it drops data.
-- data: DROPS_DATA
-- affects: users.version, question_ledger.version, outbox_messages.version, organizations.version, opportunities.version, objection_ledger.version, meetings.version, knowledge_items.version, customer_commitments.version, conversations.version, conversation_facts.version, contacts.version, campaigns.version, campaign_recipients.version, attention_items.version, accounts.version

ALTER TABLE "users" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "question_ledger" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "outbox_messages" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "opportunities" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "objection_ledger" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "knowledge_items" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "customer_commitments" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "conversation_facts" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "campaign_recipients" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "attention_items" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "version";
