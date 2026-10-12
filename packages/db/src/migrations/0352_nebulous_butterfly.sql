CREATE TABLE "ai_subscription_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"credential_key" text NOT NULL,
	"subscription_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_subscription_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"plan" text NOT NULL,
	"amount_cents" numeric(24, 7),
	"currency" text DEFAULT 'USD' NOT NULL,
	"cadence" text DEFAULT 'month' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_subscription_prices_valid" CHECK (("ai_subscription_prices"."amount_cents" is null or "ai_subscription_prices"."amount_cents" >= 0) and "ai_subscription_prices"."cadence" in ('month','year') and "ai_subscription_prices"."status" in ('active','ended','excluded') and "ai_subscription_prices"."source" in ('catalog','user','unknown'))
);
--> statement-breakpoint
CREATE TABLE "ai_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_key" text NOT NULL,
	"identity_verified" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"owner_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"detected_plan" text,
	"observed_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"refresh_status" text,
	"merged_into_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_subscriptions_no_self_merge" CHECK ("ai_subscriptions"."merged_into_id" is null or "ai_subscriptions"."merged_into_id" <> "ai_subscriptions"."id")
);
--> statement-breakpoint
CREATE TABLE "chat_voice_callbacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"phone_number" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_callbacks_phone_check" CHECK ("chat_voice_callbacks"."phone_number" ~ '^\+[1-9][0-9]{6,14}$')
);
--> statement-breakpoint
CREATE TABLE "chat_voice_inbound_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"provider_session_id" text NOT NULL,
	"state" text DEFAULT 'awaiting_approval' NOT NULL,
	"approval_code" text NOT NULL,
	"generation" integer NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"tool_token_hash" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"approved_by_user_id" text,
	"caller_authority" text,
	"intake_issue_id" uuid,
	"requested_issue_id" uuid,
	"session_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_inbound_provider_uq" UNIQUE("provider_session_id"),
	CONSTRAINT "chat_voice_inbound_state_check" CHECK ("chat_voice_inbound_calls"."state" in ('guest_intake', 'awaiting_approval', 'approving', 'approved', 'denied', 'expired', 'ended')),
	CONSTRAINT "chat_voice_inbound_token_check" CHECK ("chat_voice_inbound_calls"."tool_token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "chat_voice_inbound_code_check" CHECK ("chat_voice_inbound_calls"."approval_code" ~ '^[0-9]{6}$'),
	CONSTRAINT "chat_voice_inbound_generation_check" CHECK ("chat_voice_inbound_calls"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "chat_voice_phone_lines" (
	"endpoint_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_number_id" text NOT NULL,
	"phone_number" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"guest_intake" boolean DEFAULT false NOT NULL,
	"low_trust_environment_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_phone_lines_number_uq" UNIQUE("provider_number_id"),
	CONSTRAINT "chat_voice_phone_lines_number_check" CHECK ("chat_voice_phone_lines"."phone_number" ~ '^\+[1-9][0-9]{6,14}$')
);
--> statement-breakpoint
CREATE TABLE "chat_voice_reports" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_micro_usd" text,
	"duration_seconds" integer,
	"provider_updated_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_reports_status_check" CHECK ("chat_voice_reports"."status" in ('pending', 'available', 'unavailable')),
	CONSTRAINT "chat_voice_reports_cost_check" CHECK ("chat_voice_reports"."cost_micro_usd" is null or "chat_voice_reports"."cost_micro_usd" ~ '^[0-9]{1,30}$'),
	CONSTRAINT "chat_voice_reports_duration_check" CHECK ("chat_voice_reports"."duration_seconds" is null or "chat_voice_reports"."duration_seconds" >= 0),
	CONSTRAINT "chat_voice_reports_attempts_check" CHECK ("chat_voice_reports"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chat_voice_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"cursor" integer NOT NULL,
	"delivered_at" timestamp with time zone,
	"spoken_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_replies_cursor_check" CHECK ("chat_voice_replies"."cursor" > 0),
	CONSTRAINT "chat_voice_replies_spoken_check" CHECK ("chat_voice_replies"."spoken_at" is null or "chat_voice_replies"."delivered_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "chat_voice_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"assigned_agent_id" uuid NOT NULL,
	"caller_id" text NOT NULL,
	"caller_authority" text NOT NULL,
	"approved_by_user_id" text,
	"mode" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"generation" integer NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"provider_session_id" text,
	"tool_token_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"reply_cursor" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_sessions_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "chat_voice_sessions_state_check" CHECK ("chat_voice_sessions"."state" in ('reserved', 'creating', 'creation_unknown', 'connecting', 'active', 'awaiting_approval', 'ending', 'ended', 'failed', 'expired')),
	CONSTRAINT "chat_voice_sessions_mode_check" CHECK ("chat_voice_sessions"."mode" in ('browser', 'inbound_phone', 'outbound_phone')),
	CONSTRAINT "chat_voice_sessions_authority_check" CHECK ("chat_voice_sessions"."caller_authority" in ('member', 'instance_admin', 'local_board', 'guest_intake', 'pending_approval')),
	CONSTRAINT "chat_voice_sessions_counters_check" CHECK ("chat_voice_sessions"."generation" >= 1 and "chat_voice_sessions"."reply_cursor" >= 0),
	CONSTRAINT "chat_voice_sessions_token_check" CHECK ("chat_voice_sessions"."tool_token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "chat_voice_sessions_expiry_check" CHECK ("chat_voice_sessions"."expires_at" > "chat_voice_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "chat_voice_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"provider_tool_call_id" text NOT NULL,
	"webhook_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"tool" text NOT NULL,
	"delivery_id" uuid,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_tool_calls_tool_check" CHECK ("chat_voice_tool_calls"."tool" in ('submit_request', 'get_updates', 'answer_question'))
);
--> statement-breakpoint
CREATE TABLE "company_fast_responses" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid,
	"grant_id" uuid,
	"model" text,
	"provider" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"allow_sponsored" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_fast_responses_configured" CHECK (("company_fast_responses"."connection_id" is null) = ("company_fast_responses"."grant_id" is null) and (not "company_fast_responses"."enabled" or ("company_fast_responses"."connection_id" is not null and "company_fast_responses"."model" is not null)))
);
--> statement-breakpoint
CREATE TABLE "fast_response_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"source_comment_id" uuid,
	"issue_id" uuid,
	"project_id" uuid,
	"agent_id" uuid,
	"responsible_user_id" text,
	"sponsored" boolean DEFAULT false NOT NULL,
	"endpoint_id" uuid,
	"conversation_id" uuid,
	"delivery_id" uuid,
	"session_generation" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"publication_status" text DEFAULT 'pending' NOT NULL,
	"connection_id" uuid,
	"grant_id" uuid,
	"provider" text,
	"model" text,
	"provider_request_id" text,
	"cost_event_id" uuid,
	"error_code" text,
	"comment_id" uuid,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	CONSTRAINT "fast_response_requests_status_check" CHECK ("fast_response_requests"."status" in ('pending', 'running', 'succeeded', 'failed', 'unknown', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "budget_reservations" DROP CONSTRAINT "budget_reservations_source_check";--> statement-breakpoint
ALTER TABLE "chat_endpoints" DROP CONSTRAINT "chat_endpoints_provider_check";--> statement-breakpoint
ALTER TABLE "chat_external_principals" DROP CONSTRAINT "chat_external_principals_provider_check";--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT "cost_events_usage_kind_check";--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_transport_check";--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_channel_transport_check";--> statement-breakpoint
ALTER TABLE "mcp_oauth_tokens" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD COLUMN "fast_response_request_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "lifecycle_state" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "lifecycle_required_plugin_ids" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "lifecycle_holds" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "lifecycle_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "lifecycle_error" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "lifecycle_operation" jsonb;--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD COLUMN "require_at_mention" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_github_registrations" ADD COLUMN "owner_type" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_github_registrations" ADD COLUMN "owner_login" text;--> statement-breakpoint
ALTER TABLE "chat_github_registrations" ADD COLUMN "app_name" text;--> statement-breakpoint
ALTER TABLE "chat_github_registrations" ADD COLUMN "handoff" jsonb;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "origin" text DEFAULT 'comment' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "fast_response_request_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_subscription_connections" ADD CONSTRAINT "ai_subscription_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_subscription_connections" ADD CONSTRAINT "ai_subscription_connections_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_subscription_connections" ADD CONSTRAINT "ai_subscription_connections_grant_id_connection_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."connection_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_subscription_connections" ADD CONSTRAINT "ai_subscription_connections_subscription_id_ai_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."ai_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_subscription_prices" ADD CONSTRAINT "ai_subscription_prices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_subscription_prices" ADD CONSTRAINT "ai_subscription_prices_subscription_id_ai_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."ai_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_subscriptions" ADD CONSTRAINT "ai_subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_subscriptions" ADD CONSTRAINT "ai_subscriptions_merged_into_id_ai_subscriptions_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."ai_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_callbacks" ADD CONSTRAINT "chat_voice_callbacks_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_inbound_calls" ADD CONSTRAINT "chat_voice_inbound_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_inbound_calls" ADD CONSTRAINT "chat_voice_inbound_session_fk" FOREIGN KEY ("company_id","session_id") REFERENCES "public"."chat_voice_sessions"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_inbound_calls" ADD CONSTRAINT "chat_voice_inbound_intake_fk" FOREIGN KEY ("company_id","intake_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_inbound_calls" ADD CONSTRAINT "chat_voice_inbound_requested_issue_fk" FOREIGN KEY ("company_id","requested_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_phone_lines" ADD CONSTRAINT "chat_voice_phone_lines_low_trust_environment_id_environments_id_fk" FOREIGN KEY ("low_trust_environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_phone_lines" ADD CONSTRAINT "chat_voice_phone_lines_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_reports" ADD CONSTRAINT "chat_voice_reports_session_fk" FOREIGN KEY ("company_id","session_id") REFERENCES "public"."chat_voice_sessions"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_replies" ADD CONSTRAINT "chat_voice_replies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_replies" ADD CONSTRAINT "chat_voice_replies_session_fk" FOREIGN KEY ("company_id","session_id") REFERENCES "public"."chat_voice_sessions"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_replies" ADD CONSTRAINT "chat_voice_replies_publication_fk" FOREIGN KEY ("company_id","publication_id") REFERENCES "public"."chat_publications"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_sessions" ADD CONSTRAINT "chat_voice_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_sessions" ADD CONSTRAINT "chat_voice_sessions_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_sessions" ADD CONSTRAINT "chat_voice_sessions_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_sessions" ADD CONSTRAINT "chat_voice_sessions_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_sessions" ADD CONSTRAINT "chat_voice_sessions_agent_fk" FOREIGN KEY ("company_id","assigned_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_tool_calls" ADD CONSTRAINT "chat_voice_tool_calls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_tool_calls" ADD CONSTRAINT "chat_voice_tool_calls_session_fk" FOREIGN KEY ("company_id","session_id") REFERENCES "public"."chat_voice_sessions"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_tool_calls" ADD CONSTRAINT "chat_voice_tool_calls_delivery_fk" FOREIGN KEY ("company_id","delivery_id") REFERENCES "public"."chat_deliveries"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_fast_responses" ADD CONSTRAINT "company_fast_responses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fast_response_requests" ADD CONSTRAINT "fast_response_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fast_response_requests" ADD CONSTRAINT "fast_response_requests_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_subscription_connections_grant_idx" ON "ai_subscription_connections" USING btree ("company_id","grant_id");--> statement-breakpoint
CREATE INDEX "ai_subscription_connections_credential_idx" ON "ai_subscription_connections" USING btree ("company_id","credential_key");--> statement-breakpoint
CREATE INDEX "ai_subscription_connections_account_idx" ON "ai_subscription_connections" USING btree ("company_id","subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_subscription_prices_revision_idx" ON "ai_subscription_prices" USING btree ("subscription_id","revision");--> statement-breakpoint
CREATE INDEX "ai_subscription_prices_company_idx" ON "ai_subscription_prices" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_subscriptions_identity_idx" ON "ai_subscriptions" USING btree ("company_id","provider","account_key");--> statement-breakpoint
CREATE INDEX "ai_subscriptions_company_idx" ON "ai_subscriptions" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_voice_callbacks_owner_uq" ON "chat_voice_callbacks" USING btree ("company_id","endpoint_id","user_id");--> statement-breakpoint
CREATE INDEX "chat_voice_inbound_expiry_idx" ON "chat_voice_inbound_calls" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "chat_voice_reports_pending_idx" ON "chat_voice_reports" USING btree ("status","next_check_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_voice_replies_publication_uq" ON "chat_voice_replies" USING btree ("session_id","publication_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_voice_replies_cursor_uq" ON "chat_voice_replies" USING btree ("session_id","cursor");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_voice_sessions_provider_uq" ON "chat_voice_sessions" USING btree ("provider_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_voice_sessions_request_uq" ON "chat_voice_sessions" USING btree ("company_id","caller_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_voice_sessions_live_caller_task_uq" ON "chat_voice_sessions" USING btree ("company_id","caller_id","issue_id") WHERE "chat_voice_sessions"."state" not in ('ended', 'failed', 'expired');--> statement-breakpoint
CREATE INDEX "chat_voice_sessions_expiry_idx" ON "chat_voice_sessions" USING btree ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_voice_tool_calls_tool_uq" ON "chat_voice_tool_calls" USING btree ("session_id","provider_tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_voice_tool_calls_webhook_uq" ON "chat_voice_tool_calls" USING btree ("company_id","webhook_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fast_response_requests_source_idx" ON "fast_response_requests" USING btree ("company_id","source_key");--> statement-breakpoint
CREATE INDEX "fast_response_requests_history_idx" ON "fast_response_requests" USING btree ("company_id","accepted_at");--> statement-breakpoint
CREATE INDEX "fast_response_requests_work_idx" ON "fast_response_requests" USING btree ("expires_at") WHERE "fast_response_requests"."status" in ('pending', 'running');--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_subscription_id_ai_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."ai_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_reservations_fast_response_idx" ON "budget_reservations" USING btree ("company_id","fast_response_request_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY "agent_wakeup_requests_question_response_history_idx" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'question-response:%';--> statement-breakpoint
CREATE INDEX "agents_lifecycle_work_idx" ON "agents" USING btree ("lifecycle_state","updated_at","id");--> statement-breakpoint
CREATE INDEX "cost_events_company_subscription_occurred_idx" ON "cost_events" USING btree ("company_id","subscription_id","occurred_at");--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_source_check" CHECK (("budget_reservations"."run_id" is not null)::int + ("budget_reservations"."decision_invocation_id" is not null)::int + ("budget_reservations"."fast_response_request_id" is not null)::int = 1);--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_provider_check" CHECK ("chat_endpoints"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'speko', 'agentmail', 'imessage-photon', 'whatsapp', 'email', 'gmail'));--> statement-breakpoint
ALTER TABLE "chat_external_principals" ADD CONSTRAINT "chat_external_principals_provider_check" CHECK ("chat_external_principals"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'speko', 'agentmail', 'imessage-photon', 'whatsapp', 'email', 'gmail'));--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_usage_kind_check" CHECK ("cost_events"."usage_kind" in ('decision', 'fast_response') or ("cost_events"."usage_kind" = 'agent' and "cost_events"."agent_id" is not null));--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_transport_check" CHECK ("tool_connections"."transport" in ('mcp_remote', 'rest_api', 'local_stdio', 'chat_sdk', 'voice', 'runtime_auth'));--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_channel_transport_check" CHECK ((
      ("tool_connections"."connection_purpose" = 'tool' and "tool_connections"."transport" not in ('chat_sdk', 'voice', 'runtime_auth'))
      or
      ("tool_connections"."connection_purpose" = 'channel' and ("tool_connections"."transport" in ('chat_sdk', 'voice') or ("tool_connections"."transport" = 'rest_api' and "tool_connections"."config"->>'provider' in ('agentmail', 'email', 'gmail'))))
      or
      ("tool_connections"."connection_purpose" = 'ai' and "tool_connections"."transport" = 'runtime_auth')
    ));