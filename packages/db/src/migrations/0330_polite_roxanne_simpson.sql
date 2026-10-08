CREATE TABLE "data_source_upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"data_source_id" uuid,
	"collection_id" uuid,
	"file_name" text NOT NULL,
	"source_name" text,
	"description" text,
	"content_type" text NOT NULL,
	"expected_bytes" bigint NOT NULL,
	"expected_sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"storage_upload_id" text,
	"part_size" integer NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_source_upload_sessions" ADD CONSTRAINT "data_source_upload_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_upload_sessions" ADD CONSTRAINT "data_source_upload_sessions_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_upload_sessions" ADD CONSTRAINT "data_source_upload_sessions_collection_id_data_source_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."data_source_collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_source_upload_sessions_company_status_expiry_idx" ON "data_source_upload_sessions" USING btree ("company_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "data_source_upload_sessions_source_idx" ON "data_source_upload_sessions" USING btree ("company_id","data_source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_source_upload_sessions_object_key_uq" ON "data_source_upload_sessions" USING btree ("object_key");