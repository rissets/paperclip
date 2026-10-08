CREATE TABLE "data_source_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"color" text,
	"icon" text,
	"semantic_profile" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_sources" ADD COLUMN "collection_id" uuid;--> statement-breakpoint
ALTER TABLE "data_source_collections" ADD CONSTRAINT "data_source_collections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_source_collections_company_idx" ON "data_source_collections" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "data_source_collections_company_slug_idx" ON "data_source_collections" USING btree ("company_id","slug");--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_collection_id_data_source_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."data_source_collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_sources_collection_idx" ON "data_sources" USING btree ("collection_id");