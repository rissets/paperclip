import { describe, expect, it } from "vitest";
import { parseDataSourceModelConfig, validateDataSourceModelConfig } from "./data-source-model-config.js";

describe("datasource model runtime config", () => {
  it("keeps local and gateway providers optional for a basic control-plane startup", () => {
    const config = parseDataSourceModelConfig({});
    expect(config).toMatchObject({
      embeddingProvider: "auto",
      bgeEmbeddingUrl: undefined,
      bgeRerankUrl: undefined,
      openRouterBaseUrl: "https://router.rissets.com/v1",
      openRouterApiKey: undefined,
      openRouterEmbeddingModel: "openrouter/text-embedding-3-small",
      openRouterRerankModel: "openrouter/openrouter/cohere/rerank-v3.5",
    });
    expect(() => validateDataSourceModelConfig({})).not.toThrow();
  });

  it("normalizes valid model URLs and provider aliases", () => {
    expect(parseDataSourceModelConfig({
      RAG_EMBEDDING_PROVIDER: "openrouter",
      RAG_OPENROUTER_BASE_URL: "https://router.example/v1/",
      RAG_BGE_EMBEDDING_URL: "http://embedding:8080/",
      RAG_BGE_RERANK_URL: "http://reranker:8080",
      RAG_OPENROUTER_EMBEDDING_MODEL: "openrouter/text-embedding-3-small",
      RAG_OPENROUTER_RERANK_MODEL: "openrouter/openrouter/cohere/rerank-v3.5",
      OPENROUTER_API_KEY: " test-key ",
    })).toMatchObject({
      embeddingProvider: "openrouter",
      bgeEmbeddingUrl: "http://embedding:8080",
      bgeRerankUrl: "http://reranker:8080",
      openRouterBaseUrl: "https://router.example/v1",
      openRouterApiKey: "test-key",
    });
  });

  it.each([
    ["RAG_EMBEDDING_PROVIDER", "invalid"],
    ["RAG_OPENROUTER_BASE_URL", "ftp://router.example/v1"],
    ["RAG_OPENROUTER_BASE_URL", "https://user:pass@router.example/v1"],
    ["RAG_BGE_EMBEDDING_URL", "http://embed.local/v1?token=secret"],
    ["RAG_OPENROUTER_EMBEDDING_MODEL", "model name with spaces"],
    ["RAG_BGE_EMBEDDING_REVISION", "bad revision!"],
  ])("rejects an invalid explicit %s setting", (key, value) => {
    expect(() => parseDataSourceModelConfig({ [key]: value })).toThrow(key);
  });
});
