CREATE TABLE "accounts" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"organization_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"domain" varchar(255),
	"website" varchar(255),
	"industry" varchar(100),
	"employee_count" integer,
	"country" varchar(100),
	"metadata" jsonb,
	"lifecycle_stage" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"organization_id" varchar(255) NOT NULL,
	"account_id" varchar(255),
	"first_name" varchar(255),
	"last_name" varchar(255),
	"name" varchar(255),
	"primary_email" varchar(255) NOT NULL,
	"title" varchar(255),
	"phone" varchar(50),
	"linkedin_url" varchar(255),
	"timezone" varchar(50),
	"language" varchar(20),
	"status" varchar(50) DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_facts" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(255) NOT NULL,
	"account_id" varchar(255),
	"contact_id" varchar(255),
	"key" varchar(255) NOT NULL,
	"value" text NOT NULL,
	"source_type" varchar(50) NOT NULL,
	"source_message_id" varchar(255),
	"confidence" integer,
	"verification_status" varchar(50) DEFAULT 'UNVERIFIED' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"organization_id" varchar(255) NOT NULL,
	"account_id" varchar(255),
	"contact_id" varchar(255) NOT NULL,
	"provider_thread_id" varchar(255),
	"subject" text,
	"status" varchar(50) NOT NULL,
	"category" varchar(50),
	"last_message_at" timestamp DEFAULT now() NOT NULL,
	"latest_intent" varchar(100),
	"buying_stage" varchar(50),
	"meeting_readiness" integer,
	"purchase_readiness" integer,
	"next_best_action" varchar(100),
	"assigned_to" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(255) NOT NULL,
	"provider" varchar(50),
	"provider_message_id" varchar(255),
	"provider_thread_id" varchar(255),
	"message_id_header" varchar(255),
	"in_reply_to" varchar(255),
	"references" text,
	"direction" varchar(50) NOT NULL,
	"sender" varchar(255) NOT NULL,
	"recipients" jsonb,
	"cc" jsonb,
	"bcc" jsonb,
	"subject" text,
	"text_body" text,
	"sanitized_html_body" text,
	"raw_metadata" jsonb,
	"received_at" timestamp,
	"sent_at" timestamp,
	"status" varchar(50) NOT NULL,
	"is_automated" boolean DEFAULT false NOT NULL,
	"automation_classification" varchar(50),
	"source" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"status" varchar(50) DEFAULT 'ACTIVE' NOT NULL,
	"plan" varchar(50) DEFAULT 'FREE' NOT NULL,
	"timezone" varchar(50) DEFAULT 'UTC' NOT NULL,
	"locale" varchar(20) DEFAULT 'en-US' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"conversation_id" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(50) DEFAULT 'PENDING' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	CONSTRAINT "outbox_messages_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"organization_id" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255),
	"role" varchar(50) DEFAULT 'VIEWER' NOT NULL,
	"status" varchar(50) DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_facts" ADD CONSTRAINT "conversation_facts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_facts" ADD CONSTRAINT "conversation_facts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_facts" ADD CONSTRAINT "conversation_facts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_facts" ADD CONSTRAINT "conversation_facts_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;