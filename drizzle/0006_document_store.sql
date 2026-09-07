CREATE TABLE "documents" (
	"path" text NOT NULL,
	"id" text NOT NULL,
	"org_id" varchar(255),
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_path_id_pk" PRIMARY KEY("path","id")
);
--> statement-breakpoint
DROP INDEX "meetings_org_scheduled_idx";--> statement-breakpoint
CREATE INDEX "documents_org_idx" ON "documents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "documents_path_idx" ON "documents" USING btree ("path");--> statement-breakpoint
CREATE INDEX "meetings_org_scheduled_idx" ON "meetings" USING btree ("organization_id","start_at_utc");