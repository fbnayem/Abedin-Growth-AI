-- Reverses 0006_document_store.
-- Written as the statement-by-statement inverse of the up, in reverse order (S5).
-- scripts/lib/migration-reverse.ts checks that this still inverts the up, on every gate;
-- scripts/db-rollback.ts refuses to run it without --allow-data-loss when it drops data.
-- data: DROPS_DATA
-- affects: documents

DROP INDEX "meetings_org_scheduled_idx";--> statement-breakpoint
DROP INDEX "documents_path_idx";--> statement-breakpoint
DROP INDEX "documents_org_idx";--> statement-breakpoint
CREATE INDEX "meetings_org_scheduled_idx" ON "meetings" USING btree ("organization_id","start_at_utc");--> statement-breakpoint
DROP TABLE "documents";
