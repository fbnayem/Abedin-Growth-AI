-- Reverses 0005_catch_up_to_schema.
-- Written as the statement-by-statement inverse of the up, in reverse order (S5).
-- scripts/lib/migration-reverse.ts checks that this still inverts the up, on every gate;
-- scripts/db-rollback.ts refuses to run it without --allow-data-loss when it drops data.
-- data: DROPS_DATA
-- affects: messages.html_as_text, meetings.time_zone, meetings.duration_minutes, ai_run_logs.prompt_tokens, ai_run_logs.prompt_hash, ai_run_logs.model, ai_run_logs.currency, ai_run_logs.cost_minor, ai_run_logs.context_ids, ai_run_logs.context_hash, ai_run_logs.completion_tokens

ALTER TABLE "messages" DROP COLUMN "html_as_text";--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "time_zone";--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN "duration_minutes";--> statement-breakpoint
ALTER TABLE "ai_run_logs" DROP COLUMN "prompt_tokens";--> statement-breakpoint
ALTER TABLE "ai_run_logs" DROP COLUMN "prompt_hash";--> statement-breakpoint
ALTER TABLE "ai_run_logs" DROP COLUMN "model";--> statement-breakpoint
ALTER TABLE "ai_run_logs" DROP COLUMN "currency";--> statement-breakpoint
ALTER TABLE "ai_run_logs" DROP COLUMN "cost_minor";--> statement-breakpoint
ALTER TABLE "ai_run_logs" DROP COLUMN "context_ids";--> statement-breakpoint
ALTER TABLE "ai_run_logs" DROP COLUMN "context_hash";--> statement-breakpoint
ALTER TABLE "ai_run_logs" DROP COLUMN "completion_tokens";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "quote_snapshots" ALTER COLUMN "quoted_at" TYPE timestamp USING "quoted_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "quote_snapshots" ALTER COLUMN "expires_at" TYPE timestamp USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "question_ledger" ALTER COLUMN "valid_until" TYPE timestamp USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "question_ledger" ALTER COLUMN "valid_from" TYPE timestamp USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "question_ledger" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "question_ledger" ALTER COLUMN "observed_at" TYPE timestamp USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "question_ledger" ALTER COLUMN "last_verified_at" TYPE timestamp USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "question_ledger" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "outbox_messages" ALTER COLUMN "processed_at" TYPE timestamp USING "processed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "outbox_messages" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "valid_until" TYPE timestamp USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "valid_from" TYPE timestamp USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "observed_at" TYPE timestamp USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "last_verified_at" TYPE timestamp USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "opportunities" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "valid_until" TYPE timestamp USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "valid_from" TYPE timestamp USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "resolved_at" TYPE timestamp USING "resolved_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "observed_at" TYPE timestamp USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "last_verified_at" TYPE timestamp USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "objection_ledger" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_connections" ALTER COLUMN "valid_until" TYPE timestamp USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_connections" ALTER COLUMN "valid_from" TYPE timestamp USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_connections" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_connections" ALTER COLUMN "observed_at" TYPE timestamp USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_connections" ALTER COLUMN "last_verified_at" TYPE timestamp USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "oauth_connections" ALTER COLUMN "expires_at" TYPE timestamp USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "sent_at" TYPE timestamp USING "sent_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "received_at" TYPE timestamp USING "received_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "meetings" ALTER COLUMN "start_at_utc" TYPE timestamp USING "start_at_utc" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "meetings" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "knowledge_items" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "valid_until" TYPE timestamp USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "valid_from" TYPE timestamp USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "observed_at" TYPE timestamp USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "last_verified_at" TYPE timestamp USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "due_date" TYPE timestamp USING "due_date" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "customer_commitments" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "valid_until" TYPE timestamp USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "valid_from" TYPE timestamp USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "observed_at" TYPE timestamp USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "last_verified_at" TYPE timestamp USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "last_message_at" TYPE timestamp USING "last_message_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversation_facts" ALTER COLUMN "valid_until" TYPE timestamp USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversation_facts" ALTER COLUMN "valid_from" TYPE timestamp USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversation_facts" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversation_facts" ALTER COLUMN "observed_at" TYPE timestamp USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversation_facts" ALTER COLUMN "last_verified_at" TYPE timestamp USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "conversation_facts" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "valid_until" TYPE timestamp USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "valid_from" TYPE timestamp USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "observed_at" TYPE timestamp USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "last_verified_at" TYPE timestamp USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "campaign_recipients" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "campaign_recipients" ALTER COLUMN "next_step_due_at" TYPE timestamp USING "next_step_due_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "campaign_recipients" ALTER COLUMN "last_step_sent_at" TYPE timestamp USING "last_step_sent_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "campaign_recipients" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "attention_items" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "ai_run_logs" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "valid_until" TYPE timestamp USING "valid_until" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "valid_from" TYPE timestamp USING "valid_from" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "observed_at" TYPE timestamp USING "observed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "last_verified_at" TYPE timestamp USING "last_verified_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "meetings" RENAME COLUMN "start_at_utc" TO "scheduled_time";--> statement-breakpoint
ALTER TABLE "messages" RENAME COLUMN "raw_html_body" TO "sanitized_html_body";
