CREATE TABLE "data_source_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_source_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"title" text,
	"content" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"embedding" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_source_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"data_source_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_source_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_source_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"column_count" integer DEFAULT 0 NOT NULL,
	"schema_definition" jsonb NOT NULL,
	"semantic_model" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source_type" text NOT NULL,
	"status" text DEFAULT 'onboarding' NOT NULL,
	"file_name" text,
	"file_size" integer,
	"mime_type" text,
	"storage_path" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orchestrator_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"orchestration_plan" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orchestrator_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text DEFAULT 'New Orchestration Session' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_source_chunks" ADD CONSTRAINT "data_source_chunks_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_chunks" ADD CONSTRAINT "data_source_chunks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_records" ADD CONSTRAINT "data_source_records_table_id_data_source_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."data_source_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_records" ADD CONSTRAINT "data_source_records_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_records" ADD CONSTRAINT "data_source_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_tables" ADD CONSTRAINT "data_source_tables_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_tables" ADD CONSTRAINT "data_source_tables_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestrator_messages" ADD CONSTRAINT "orchestrator_messages_session_id_orchestrator_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."orchestrator_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestrator_messages" ADD CONSTRAINT "orchestrator_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestrator_sessions" ADD CONSTRAINT "orchestrator_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_source_chunks_ds_idx" ON "data_source_chunks" USING btree ("data_source_id");--> statement-breakpoint
CREATE INDEX "data_source_chunks_company_idx" ON "data_source_chunks" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "data_source_records_table_row_idx" ON "data_source_records" USING btree ("table_id","row_index");--> statement-breakpoint
CREATE INDEX "data_source_records_company_table_idx" ON "data_source_records" USING btree ("company_id","table_id");--> statement-breakpoint
CREATE INDEX "data_source_tables_ds_idx" ON "data_source_tables" USING btree ("data_source_id");--> statement-breakpoint
CREATE INDEX "data_source_tables_company_idx" ON "data_source_tables" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "data_sources_company_idx" ON "data_sources" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "data_sources_company_status_idx" ON "data_sources" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "data_sources_company_type_idx" ON "data_sources" USING btree ("company_id","source_type");--> statement-breakpoint
CREATE INDEX "orchestrator_messages_session_idx" ON "orchestrator_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "orchestrator_messages_company_idx" ON "orchestrator_messages" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "orchestrator_sessions_company_idx" ON "orchestrator_sessions" USING btree ("company_id");