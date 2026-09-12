-- Reverses 0007_backfill_valid_from.
-- Nulls exactly the rows the up filled: those whose valid_from equals the value the up copied.
-- Exact only because no application code writes valid_from on these tables — a row that had
-- been given valid_from = created_at by something else would be nulled too. That premise is
-- asserted by migrationRollback.invariant; if a writer appears, this reverse must change with it.
-- data: DROPS_DATA
-- affects: organizations.valid_from, accounts.valid_from, contacts.valid_from, conversations.valid_from, conversation_facts.valid_from, customer_commitments.valid_from, objection_ledger.valid_from, question_ledger.valid_from, oauth_connections.valid_from

UPDATE "oauth_connections" SET "valid_from" = NULL WHERE "valid_from" = "observed_at";--> statement-breakpoint
UPDATE "question_ledger" SET "valid_from" = NULL WHERE "valid_from" = "created_at";--> statement-breakpoint
UPDATE "objection_ledger" SET "valid_from" = NULL WHERE "valid_from" = "created_at";--> statement-breakpoint
UPDATE "customer_commitments" SET "valid_from" = NULL WHERE "valid_from" = "created_at";--> statement-breakpoint
UPDATE "conversation_facts" SET "valid_from" = NULL WHERE "valid_from" = "created_at";--> statement-breakpoint
UPDATE "conversations" SET "valid_from" = NULL WHERE "valid_from" = "created_at";--> statement-breakpoint
UPDATE "contacts" SET "valid_from" = NULL WHERE "valid_from" = "created_at";--> statement-breakpoint
UPDATE "accounts" SET "valid_from" = NULL WHERE "valid_from" = "created_at";--> statement-breakpoint
UPDATE "organizations" SET "valid_from" = NULL WHERE "valid_from" = "created_at";
