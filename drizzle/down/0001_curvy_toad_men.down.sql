-- Reverses 0001_curvy_toad_men.
-- Written as the statement-by-statement inverse of the up, in reverse order (S5).
-- scripts/lib/migration-reverse.ts checks that this still inverts the up, on every gate;
-- scripts/db-rollback.ts refuses to run it without --allow-data-loss when it drops data.
-- data: DROPS_DATA
-- affects: opportunities, meetings, knowledge_items, campaigns, attention_items, ai_run_logs

ALTER TABLE "opportunities" DROP CONSTRAINT "opportunities_contact_id_contacts_id_fk";--> statement-breakpoint
ALTER TABLE "meetings" DROP CONSTRAINT "meetings_contact_id_contacts_id_fk";--> statement-breakpoint
DROP TABLE "opportunities";--> statement-breakpoint
DROP TABLE "meetings";--> statement-breakpoint
DROP TABLE "knowledge_items";--> statement-breakpoint
DROP TABLE "campaigns";--> statement-breakpoint
DROP TABLE "attention_items";--> statement-breakpoint
DROP TABLE "ai_run_logs";
