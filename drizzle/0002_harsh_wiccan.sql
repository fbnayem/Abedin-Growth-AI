CREATE TABLE "customer_commitments" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"account_id" varchar(255),
	"contact_id" varchar(255) NOT NULL,
	"conversation_id" varchar(255) NOT NULL,
	"commitment" text NOT NULL,
	"source_message_id" varchar(255),
	"made_by" varchar(255),
	"due_date" timestamp,
	"status" varchar(50) NOT NULL,
	"risk_level" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"observed_at" timestamp DEFAULT now(),
	"last_verified_at" timestamp,
	"valid_from" timestamp,
	"valid_until" timestamp,
	"superseded_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "oauth_connections" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"organization_id" varchar(255) NOT NULL,
	"provider" varchar(50) NOT NULL,
	"account_email" varchar(255),
	"access_token" text,
	"refresh_token" text,
	"expires_at" timestamp,
	"status" varchar(50) DEFAULT 'ACTIVE' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"observed_at" timestamp DEFAULT now(),
	"last_verified_at" timestamp,
	"valid_from" timestamp,
	"valid_until" timestamp,
	"superseded_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "objection_ledger" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(255) NOT NULL,
	"type" varchar(100),
	"statement" text NOT NULL,
	"source_message_id" varchar(255),
	"severity" varchar(50),
	"status" varchar(50) NOT NULL,
	"resolution" text,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"observed_at" timestamp DEFAULT now(),
	"last_verified_at" timestamp,
	"valid_from" timestamp,
	"valid_until" timestamp,
	"superseded_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "question_ledger" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(255) NOT NULL,
	"question_text" text NOT NULL,
	"status" varchar(50) NOT NULL,
	"source_message_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"observed_at" timestamp DEFAULT now(),
	"last_verified_at" timestamp,
	"valid_from" timestamp,
	"valid_until" timestamp,
	"superseded_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "quote_snapshots" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"contact_id" varchar(255) NOT NULL,
	"pricing_version" varchar(100),
	"details" jsonb,
	"quoted_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"status" varchar(50) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "observed_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "last_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "valid_from" timestamp;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "valid_until" timestamp;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "superseded_by" varchar(255);--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "stakeholder_role" varchar(50) DEFAULT 'UNKNOWN';--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "observed_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "last_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "valid_from" timestamp;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "valid_until" timestamp;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "superseded_by" varchar(255);--> statement-breakpoint
ALTER TABLE "conversation_facts" ADD COLUMN "observed_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "conversation_facts" ADD COLUMN "last_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "conversation_facts" ADD COLUMN "valid_from" timestamp;--> statement-breakpoint
ALTER TABLE "conversation_facts" ADD COLUMN "valid_until" timestamp;--> statement-breakpoint
ALTER TABLE "conversation_facts" ADD COLUMN "superseded_by" varchar(255);--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "observed_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "valid_from" timestamp;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "valid_until" timestamp;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "superseded_by" varchar(255);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "observed_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "last_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "valid_from" timestamp;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "valid_until" timestamp;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "superseded_by" varchar(255);--> statement-breakpoint
ALTER TABLE "customer_commitments" ADD CONSTRAINT "customer_commitments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_commitments" ADD CONSTRAINT "customer_commitments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_commitments" ADD CONSTRAINT "customer_commitments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_commitments" ADD CONSTRAINT "customer_commitments_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objection_ledger" ADD CONSTRAINT "objection_ledger_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objection_ledger" ADD CONSTRAINT "objection_ledger_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_ledger" ADD CONSTRAINT "question_ledger_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_ledger" ADD CONSTRAINT "question_ledger_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_snapshots" ADD CONSTRAINT "quote_snapshots_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;