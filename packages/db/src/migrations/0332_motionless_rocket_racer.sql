DO $$
BEGIN
  IF to_regclass('public.data_source_chunk_embeddings') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE data_source_chunk_embeddings ADD COLUMN IF NOT EXISTS embedding_generation text';
    EXECUTE 'UPDATE data_source_chunk_embeddings SET embedding_generation = embedding_space WHERE embedding_generation IS NULL';
    EXECUTE 'ALTER TABLE data_source_chunk_embeddings ALTER COLUMN embedding_generation SET NOT NULL';
    EXECUTE 'DROP INDEX IF EXISTS data_source_chunk_embeddings_chunk_space_idx';
    EXECUTE 'DROP INDEX IF EXISTS data_source_chunk_embeddings_company_source_space_idx';
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS data_source_chunk_embeddings_chunk_generation_idx ON data_source_chunk_embeddings (chunk_id, embedding_generation)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS data_source_chunk_embeddings_company_source_space_idx ON data_source_chunk_embeddings (company_id, data_source_id, embedding_space, embedding_generation)';
  END IF;

  IF to_regclass('public.data_source_gateway_chunk_embeddings') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE data_source_gateway_chunk_embeddings ADD COLUMN IF NOT EXISTS embedding_generation text';
    EXECUTE 'UPDATE data_source_gateway_chunk_embeddings SET embedding_generation = embedding_space WHERE embedding_generation IS NULL';
    EXECUTE 'ALTER TABLE data_source_gateway_chunk_embeddings ALTER COLUMN embedding_generation SET NOT NULL';
    EXECUTE 'DROP INDEX IF EXISTS data_source_gateway_chunk_embeddings_chunk_space_idx';
    EXECUTE 'DROP INDEX IF EXISTS data_source_gateway_chunk_embeddings_company_source_space_idx';
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS data_source_gateway_chunk_embeddings_chunk_generation_idx ON data_source_gateway_chunk_embeddings (chunk_id, embedding_generation)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS data_source_gateway_chunk_embeddings_company_source_space_idx ON data_source_gateway_chunk_embeddings (company_id, data_source_id, embedding_space, embedding_generation)';
  END IF;
END $$;
