-- 0007 — backfill valid_from on the bitemporal tables (S5).
--
-- 0002 added observed_at, last_verified_at, valid_from, valid_until and superseded_by to five
-- tables and created four more with them. observed_at took its default on every existing row;
-- valid_from did not, and nothing on the relational path has written it since — so on every
-- historical row the column that says "valid since when" said nothing. This is the MIGRATE
-- step of expand/contract that the migrations had never exercised: a data change, between the
-- schema change that made it possible and any schema change that would depend on it.
--
-- What is asserted, and no more: a record has been valid since the moment it was first
-- recorded. That is the most conservative start a fact can have — no earlier knowledge is
-- claimed — and it is the only value the row itself can vouch for. valid_until stays NULL (the
-- interval is open) and last_verified_at stays NULL (nothing has verified it), because both are
-- true.
--
-- Idempotent: only rows with NULL are touched. Its reverse (drizzle/down/) nulls exactly the
-- rows this filled — exact because no application code writes valid_from on these tables,
-- which migrationRollback.invariant asserts rather than assumes.

UPDATE "organizations" SET "valid_from" = "created_at" WHERE "valid_from" IS NULL;--> statement-breakpoint
UPDATE "accounts" SET "valid_from" = "created_at" WHERE "valid_from" IS NULL;--> statement-breakpoint
UPDATE "contacts" SET "valid_from" = "created_at" WHERE "valid_from" IS NULL;--> statement-breakpoint
UPDATE "conversations" SET "valid_from" = "created_at" WHERE "valid_from" IS NULL;--> statement-breakpoint
UPDATE "conversation_facts" SET "valid_from" = "created_at" WHERE "valid_from" IS NULL;--> statement-breakpoint
UPDATE "customer_commitments" SET "valid_from" = "created_at" WHERE "valid_from" IS NULL;--> statement-breakpoint
UPDATE "objection_ledger" SET "valid_from" = "created_at" WHERE "valid_from" IS NULL;--> statement-breakpoint
UPDATE "question_ledger" SET "valid_from" = "created_at" WHERE "valid_from" IS NULL;--> statement-breakpoint
-- oauth_connections has no created_at; observed_at is the earliest instant the row can vouch for.
UPDATE "oauth_connections" SET "valid_from" = "observed_at" WHERE "valid_from" IS NULL AND "observed_at" IS NOT NULL;
