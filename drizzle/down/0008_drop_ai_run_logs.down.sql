-- Reverses 0008_drop_ai_run_logs.
-- Recreates the table in the shape 0001 + 0003 + 0005 left it, with the foreign key and the index
-- the up's CASCADE removed with it. The table was empty when dropped — it never had a writer
-- (S22) — so this reverse restores everything there was.
-- data: SCHEMA_ONLY

CREATE TABLE "ai_run_logs" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"agent_type" varchar(50) NOT NULL,
	"action_type" varchar(50),
	"summary" text,
	"status" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" varchar(255) NOT NULL,
	"completion_tokens" integer,
	"context_hash" varchar(64),
	"context_ids" text,
	"cost_minor" integer,
	"currency" varchar(3),
	"model" varchar(100),
	"prompt_hash" varchar(64),
	"prompt_tokens" integer
);--> statement-breakpoint
ALTER TABLE "ai_run_logs" ADD CONSTRAINT "ai_run_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_run_logs_org_idx" ON "ai_run_logs" USING btree ("organization_id","created_at");
