ALTER TABLE "chat_endpoints" DROP CONSTRAINT IF EXISTS "chat_endpoints_provider_check";--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_provider_check" CHECK ("chat_endpoints"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'speko', 'agentmail', 'imessage-photon', 'whatsapp', 'email', 'gmail'));--> statement-breakpoint
ALTER TABLE "chat_external_principals" DROP CONSTRAINT IF EXISTS "chat_external_principals_provider_check";--> statement-breakpoint
ALTER TABLE "chat_external_principals" ADD CONSTRAINT "chat_external_principals_provider_check" CHECK ("chat_external_principals"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'speko', 'agentmail', 'imessage-photon', 'whatsapp', 'email', 'gmail'));--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_channel_transport_check";--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_channel_transport_check" CHECK ((
      ("tool_connections"."connection_purpose" = 'tool' and "tool_connections"."transport" not in ('chat_sdk', 'voice', 'runtime_auth'))
      or
      ("tool_connections"."connection_purpose" = 'channel' and ("tool_connections"."transport" in ('chat_sdk', 'voice') or ("tool_connections"."transport" = 'rest_api' and "tool_connections"."config"->>'provider' in ('agentmail', 'email', 'gmail'))))
      or
      ("tool_connections"."connection_purpose" = 'ai' and "tool_connections"."transport" = 'runtime_auth')
    ));