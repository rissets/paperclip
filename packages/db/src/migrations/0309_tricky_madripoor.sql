CREATE TABLE "data_source_query_experiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"originating_execution_id" text NOT NULL,
	"intent" text NOT NULL,
	"parameterized_sql" text NOT NULL,
	"parameter_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"referenced_data_source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"referenced_tables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"referenced_columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metric_bindings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schema_fingerprint" text NOT NULL,
	"engine" text DEFAULT 'clickhouse' NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"validation_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"feedback_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_source_query_exp_status_check" CHECK ("data_source_query_experiences"."status" IN ('candidate', 'execution_checked', 'reference_verified', 'user_approved', 'rejected', 'deprecated')),
	CONSTRAINT "data_source_query_exp_engine_check" CHECK ("data_source_query_experiences"."engine" IN ('clickhouse', 'live_external', 'hybrid'))
);
--> statement-breakpoint
CREATE TABLE "data_source_query_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"experience_id" uuid,
	"execution_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"sentiment" text NOT NULL,
	"business_fields_to_fix" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"correction_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_source_query_fb_actor_check" CHECK ("data_source_query_feedback"."actor_type" IN ('board', 'agent', 'user')),
	CONSTRAINT "data_source_query_fb_sentiment_check" CHECK ("data_source_query_feedback"."sentiment" IN ('positive', 'negative'))
);
--> statement-breakpoint
ALTER TABLE "data_source_query_experiences" ADD CONSTRAINT "data_source_query_experiences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_query_feedback" ADD CONSTRAINT "data_source_query_feedback_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_query_feedback" ADD CONSTRAINT "data_source_query_feedback_experience_id_data_source_query_experiences_id_fk" FOREIGN KEY ("experience_id") REFERENCES "public"."data_source_query_experiences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_source_query_exp_company_idx" ON "data_source_query_experiences" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "data_source_query_exp_status_idx" ON "data_source_query_experiences" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "data_source_query_exp_fingerprint_idx" ON "data_source_query_experiences" USING btree ("company_id","schema_fingerprint");--> statement-breakpoint
CREATE INDEX "data_source_query_exp_intent_idx" ON "data_source_query_experiences" USING btree ("company_id","intent");--> statement-breakpoint
CREATE INDEX "data_source_query_fb_company_idx" ON "data_source_query_feedback" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "data_source_query_fb_exp_idx" ON "data_source_query_feedback" USING btree ("company_id","experience_id");--> statement-breakpoint
CREATE INDEX "data_source_query_fb_exec_idx" ON "data_source_query_feedback" USING btree ("company_id","execution_id");