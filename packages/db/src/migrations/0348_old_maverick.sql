CREATE TABLE IF NOT EXISTS "data_source_query_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"run_id" text,
	"session_id" text,
	"query" text NOT NULL,
	"plan_hash" text NOT NULL,
	"engine" text DEFAULT 'clickhouse',
	"status" text DEFAULT 'running' NOT NULL,
	"stage_timings" jsonb,
	"results_summary" text,
	"data_preview" jsonb,
	"error_message" text,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
-- Older workspaces created this ledger with UUID execution and run IDs. Keep those
-- records readable while allowing the orchestrator's exec-* IDs and non-UUID run IDs.
ALTER TABLE "data_source_query_executions" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "data_source_query_executions" ALTER COLUMN "id" TYPE text USING "id"::text;
ALTER TABLE "data_source_query_executions" ALTER COLUMN "run_id" DROP DEFAULT;
ALTER TABLE "data_source_query_executions" ALTER COLUMN "run_id" TYPE text USING "run_id"::text;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.data_source_query_executions'::regclass
		  AND conname = 'data_source_query_executions_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "data_source_query_executions"
			ADD CONSTRAINT "data_source_query_executions_company_id_companies_id_fk"
			FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
			ON DELETE cascade ON UPDATE no action NOT VALID;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.data_source_query_executions'::regclass
		  AND conname = 'data_source_query_executions_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "data_source_query_executions"
			ADD CONSTRAINT "data_source_query_executions_agent_id_agents_id_fk"
			FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")
			ON DELETE set null ON UPDATE no action NOT VALID;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.data_source_query_executions'::regclass
		  AND conname = 'data_source_query_executions_status_check'
	) THEN
		ALTER TABLE "data_source_query_executions"
			ADD CONSTRAINT "data_source_query_executions_status_check"
			CHECK ("status" IN ('running', 'completed', 'cancelled', 'failed')) NOT VALID;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_source_query_executions_company_idx"
	ON "data_source_query_executions" USING btree ("company_id", "created_at");
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: The partial predicate only indexes new exec-* keys; legacy UUID rows are deliberately excluded so existing history can remain intact while new executions get race-safe run/plan uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS "data_source_query_executions_run_plan_uidx"
	ON "data_source_query_executions" USING btree ("company_id", "run_id", "plan_hash")
	WHERE "id" LIKE 'exec-%';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_source_query_executions_agent_idx"
	ON "data_source_query_executions" USING btree ("company_id", "agent_id", "created_at");
