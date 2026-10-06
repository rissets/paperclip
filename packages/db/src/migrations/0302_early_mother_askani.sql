CREATE TABLE "data_source_query_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"data_source_id" uuid NOT NULL,
	"requested_by_type" text NOT NULL,
	"requested_by_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"query_text" text,
	"query_params" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"query_fingerprint" text NOT NULL,
	"row_limit" integer DEFAULT 100 NOT NULL,
	"statement_timeout_ms" integer DEFAULT 30000 NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"result" jsonb,
	"result_bytes" integer,
	"result_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "data_source_query_jobs" ADD CONSTRAINT "data_source_query_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_query_jobs" ADD CONSTRAINT "data_source_query_jobs_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_source_query_jobs_queue_idx" ON "data_source_query_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "data_source_query_jobs_company_idx" ON "data_source_query_jobs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "data_source_query_jobs_source_idx" ON "data_source_query_jobs" USING btree ("company_id","data_source_id","created_at");--> statement-breakpoint
CREATE INDEX "data_source_query_jobs_lease_idx" ON "data_source_query_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "data_source_query_jobs_result_expiry_idx" ON "data_source_query_jobs" USING btree ("result_expires_at");