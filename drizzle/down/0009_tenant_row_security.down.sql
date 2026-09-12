-- Reverses 0009_tenant_row_security.
-- Written as the statement-by-statement inverse of the up, in reverse order (S5).
-- scripts/lib/migration-reverse.ts checks that this still inverts the up, on every gate;
-- scripts/db-rollback.ts refuses to run it without --allow-data-loss when it drops data.
-- data: SCHEMA_ONLY
-- affects: documents

DROP POLICY "documents_tenant" ON "documents";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_org_matches_path";--> statement-breakpoint
ALTER TABLE "documents" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" DISABLE ROW LEVEL SECURITY;
