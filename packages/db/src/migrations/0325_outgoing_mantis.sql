DO $$
BEGIN
	CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION
	WHEN undefined_file OR feature_not_supported OR insufficient_privilege THEN
		RAISE NOTICE 'pgvector is unavailable; datasource RAG will use JSONB/lexical fallback';
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
		EXECUTE 'CREATE TABLE "data_source_chunk_embeddings" (
			"chunk_id" uuid NOT NULL,
			"company_id" uuid NOT NULL,
			"data_source_id" uuid NOT NULL,
			"embedding_space" text NOT NULL,
			"embedding" vector(1024) NOT NULL,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL
		)';
		EXECUTE 'CREATE TABLE "data_source_gateway_chunk_embeddings" (
			"chunk_id" uuid NOT NULL,
			"company_id" uuid NOT NULL,
			"data_source_id" uuid NOT NULL,
			"embedding_space" text NOT NULL,
			"embedding" vector(1536) NOT NULL,
			"created_at" timestamp with time zone DEFAULT now() NOT NULL
		)';
		EXECUTE 'ALTER TABLE "data_source_chunk_embeddings" ADD CONSTRAINT "data_source_chunk_embeddings_chunk_id_data_source_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."data_source_chunks"("id") ON DELETE cascade ON UPDATE no action';
		EXECUTE 'ALTER TABLE "data_source_chunk_embeddings" ADD CONSTRAINT "data_source_chunk_embeddings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action';
		EXECUTE 'ALTER TABLE "data_source_chunk_embeddings" ADD CONSTRAINT "data_source_chunk_embeddings_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE cascade ON UPDATE no action';
		EXECUTE 'ALTER TABLE "data_source_gateway_chunk_embeddings" ADD CONSTRAINT "data_source_gateway_chunk_embeddings_chunk_id_data_source_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."data_source_chunks"("id") ON DELETE cascade ON UPDATE no action';
		EXECUTE 'ALTER TABLE "data_source_gateway_chunk_embeddings" ADD CONSTRAINT "data_source_gateway_chunk_embeddings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action';
		EXECUTE 'ALTER TABLE "data_source_gateway_chunk_embeddings" ADD CONSTRAINT "data_source_gateway_chunk_embeddings_data_source_id_data_sources_id_fk" FOREIGN KEY ("data_source_id") REFERENCES "public"."data_sources"("id") ON DELETE cascade ON UPDATE no action';
		EXECUTE 'CREATE UNIQUE INDEX "data_source_chunk_embeddings_chunk_space_idx" ON "data_source_chunk_embeddings" USING btree ("chunk_id", "embedding_space")';
		EXECUTE 'CREATE INDEX "data_source_chunk_embeddings_company_source_space_idx" ON "data_source_chunk_embeddings" USING btree ("company_id", "data_source_id", "embedding_space")';
		EXECUTE 'CREATE INDEX "data_source_chunk_embeddings_bge_hnsw_idx" ON "data_source_chunk_embeddings" USING hnsw ("embedding" vector_cosine_ops) WHERE embedding_space = ''bge-m3''';
		EXECUTE 'CREATE UNIQUE INDEX "data_source_gateway_chunk_embeddings_chunk_space_idx" ON "data_source_gateway_chunk_embeddings" USING btree ("chunk_id", "embedding_space")';
		EXECUTE 'CREATE INDEX "data_source_gateway_chunk_embeddings_company_source_space_idx" ON "data_source_gateway_chunk_embeddings" USING btree ("company_id", "data_source_id", "embedding_space")';
		EXECUTE 'CREATE INDEX "data_source_gateway_chunk_embeddings_hnsw_idx" ON "data_source_gateway_chunk_embeddings" USING hnsw ("embedding" vector_cosine_ops) WHERE embedding_space = ''openrouter-text-embedding-3-small''';
	END IF;
END $$;
