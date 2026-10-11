CREATE TABLE "user_data_source_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"data_source_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"assigned_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_project_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"assigned_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "user_data_source_assignments" ADD CONSTRAINT "user_data_source_assignments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_data_source_assignments" ADD CONSTRAINT "user_data_source_assignments_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_data_source_assignments" ADD CONSTRAINT "user_data_source_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_assignments" ADD CONSTRAINT "user_project_assignments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_assignments" ADD CONSTRAINT "user_project_assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_assignments" ADD CONSTRAINT "user_project_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_data_source_assignments_user_ds_uq" ON "user_data_source_assignments" USING btree ("user_id","data_source_id");--> statement-breakpoint
CREATE INDEX "user_data_source_assignments_company_user_idx" ON "user_data_source_assignments" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "user_data_source_assignments_company_ds_idx" ON "user_data_source_assignments" USING btree ("company_id","data_source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_project_assignments_user_project_uq" ON "user_project_assignments" USING btree ("user_id","project_id");--> statement-breakpoint
CREATE INDEX "user_project_assignments_company_user_idx" ON "user_project_assignments" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "user_project_assignments_company_project_idx" ON "user_project_assignments" USING btree ("company_id","project_id");