CREATE TABLE "data_source_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"data_source_id" uuid NOT NULL,
	"job_type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_source_jobs" ADD CONSTRAINT "data_source_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_jobs" ADD CONSTRAINT "data_source_jobs_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_source_jobs_company_idx" ON "data_source_jobs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "data_source_jobs_queue_idx" ON "data_source_jobs" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "data_source_jobs_lease_idx" ON "data_source_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "data_source_jobs_source_idx" ON "data_source_jobs" USING btree ("company_id","data_source_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_source_jobs_idempotency_idx" ON "data_source_jobs" USING btree ("company_id","idempotency_key");