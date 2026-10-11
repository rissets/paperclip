CREATE TABLE "data_source_job_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"checkpoint_type" text NOT NULL,
	"checkpoint_key" text NOT NULL,
	"input_fingerprint" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_source_job_checkpoints" ADD CONSTRAINT "data_source_job_checkpoints_job_id_data_source_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."data_source_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_source_job_checkpoints_job_stage_idx" ON "data_source_job_checkpoints" USING btree ("job_id","checkpoint_type","input_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "data_source_job_checkpoints_identity_uidx" ON "data_source_job_checkpoints" USING btree ("job_id","checkpoint_type","checkpoint_key");