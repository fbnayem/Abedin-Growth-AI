-- 0005 — catch the migrations up to schema.ts.
--
-- Three commits changed the schema and none generated a migration: the P1.8 run-log
-- columns, the P1.9 time-correctness pass, and the S16/S35 HTML rename. Applying 0000-0004
-- to an empty database therefore produced a schema the code could not query.
--
-- The two column moves below are written as RENAME rather than DROP + ADD. Both reach the
-- same final schema; only one keeps the rows. drizzle-kit cannot tell them apart without
-- asking, and the safe answer is not the default one.

ALTER TABLE "messages" RENAME COLUMN "sanitized_html_body" TO "raw_html_body";--> statement-breakpoint
ALTER TABLE "meetings" RENAME COLUMN "scheduled_time" TO "start_at_utc";--> statement-breakpoint

-- `ALTER COLUMN ... TYPE timestamptz` without a USING clause reinterprets each stored
-- naive value in the SESSION's TimeZone setting. Every timestamp in this system is written
-- as UTC, so the conversion is only correct if that setting happens to be UTC — an
-- assumption that is invisible when true and silently shifts every row when false. P1.9
-- exists because this exact class of error was already in this codebase once, applying an
-- offset twice in the same direction. The zone is stated rather than inherited.

ALTER TABLE "accounts" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "last_verified_at" TYPE timestamp with time zone USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "observed_at" TYPE timestamp with time zone USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "valid_from" TYPE timestamp with time zone USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "valid_until" TYPE timestamp with time zone USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "ai_run_logs" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "attention_items" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "campaign_recipients" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "campaign_recipients" ALTER COLUMN "last_step_sent_at" TYPE timestamp with time zone USING "last_step_sent_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "campaign_recipients" ALTER COLUMN "next_step_due_at" TYPE timestamp with time zone USING "next_step_due_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "campaign_recipients" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "last_verified_at" TYPE timestamp with time zone USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "observed_at" TYPE timestamp with time zone USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "valid_from" TYPE timestamp with time zone USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "valid_until" TYPE timestamp with time zone USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversation_facts" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversation_facts" ALTER COLUMN "last_verified_at" TYPE timestamp with time zone USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversation_facts" ALTER COLUMN "observed_at" TYPE timestamp with time zone USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversation_facts" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversation_facts" ALTER COLUMN "valid_from" TYPE timestamp with time zone USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversation_facts" ALTER COLUMN "valid_until" TYPE timestamp with time zone USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "last_message_at" TYPE timestamp with time zone USING "last_message_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "last_verified_at" TYPE timestamp with time zone USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "observed_at" TYPE timestamp with time zone USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "valid_from" TYPE timestamp with time zone USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "valid_until" TYPE timestamp with time zone USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "due_date" TYPE timestamp with time zone USING "due_date" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "last_verified_at" TYPE timestamp with time zone USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "observed_at" TYPE timestamp with time zone USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "valid_from" TYPE timestamp with time zone USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "valid_until" TYPE timestamp with time zone USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "knowledge_items" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "meetings" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "meetings" ALTER COLUMN "start_at_utc" TYPE timestamp with time zone USING "start_at_utc" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "received_at" TYPE timestamp with time zone USING "received_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "sent_at" TYPE timestamp with time zone USING "sent_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_connections" ALTER COLUMN "expires_at" TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_connections" ALTER COLUMN "last_verified_at" TYPE timestamp with time zone USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_connections" ALTER COLUMN "observed_at" TYPE timestamp with time zone USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_connections" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_connections" ALTER COLUMN "valid_from" TYPE timestamp with time zone USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_connections" ALTER COLUMN "valid_until" TYPE timestamp with time zone USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "last_verified_at" TYPE timestamp with time zone USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "observed_at" TYPE timestamp with time zone USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "resolved_at" TYPE timestamp with time zone USING "resolved_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "valid_from" TYPE timestamp with time zone USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "valid_until" TYPE timestamp with time zone USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "opportunities" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "last_verified_at" TYPE timestamp with time zone USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "observed_at" TYPE timestamp with time zone USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "valid_from" TYPE timestamp with time zone USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "valid_until" TYPE timestamp with time zone USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "outbox_messages" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "outbox_messages" ALTER COLUMN "processed_at" TYPE timestamp with time zone USING "processed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "question_ledger" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "question_ledger" ALTER COLUMN "last_verified_at" TYPE timestamp with time zone USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "question_ledger" ALTER COLUMN "observed_at" TYPE timestamp with time zone USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "question_ledger" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "question_ledger" ALTER COLUMN "valid_from" TYPE timestamp with time zone USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "question_ledger" ALTER COLUMN "valid_until" TYPE timestamp with time zone USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "quote_snapshots" ALTER COLUMN "expires_at" TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "quote_snapshots" ALTER COLUMN "quoted_at" TYPE timestamp with time zone USING "quoted_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint

-- New columns. All nullable, so this is safe against a populated table.

ALTER TABLE "ai_run_logs" ADD COLUMN "completion_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_run_logs" ADD COLUMN "context_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "ai_run_logs" ADD COLUMN "context_ids" text;--> statement-breakpoint
ALTER TABLE "ai_run_logs" ADD COLUMN "cost_minor" integer;--> statement-breakpoint
ALTER TABLE "ai_run_logs" ADD COLUMN "currency" varchar(3);--> statement-breakpoint
ALTER TABLE "ai_run_logs" ADD COLUMN "model" varchar(100);--> statement-breakpoint
ALTER TABLE "ai_run_logs" ADD COLUMN "prompt_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "ai_run_logs" ADD COLUMN "prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "duration_minutes" integer;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "time_zone" varchar(64);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "html_as_text" text;--> statement-breakpoint
