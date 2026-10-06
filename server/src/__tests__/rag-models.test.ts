import { afterEach, describe, expect, it, vi } from "vitest";
import { RagModelService } from "../services/rag-models.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("RAG model adapters", () => {
  it("uses local BGE-M3 and validates the model's 1024-dimensional vectors", async () => {
    vi.stubEnv("RAG_EMBEDDING_PROVIDER", "bge");
    vi.stubEnv("RAG_BGE_EMBEDDING_URL", "http://tei.test");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0),
    ]), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new RagModelService().embed(["kebijakan layanan"]);

    expect(result.space).toBe("bge-m3");
    expect(result.generation).toBe("bge-m3@80087bf0b7876bc948d3b5677706633f6c795fa2");
    expect(result.backend).toBe("local-bge-m3");
    expect(result.vectors?.[0]).toHaveLength(1_024);
    expect(fetchMock).toHaveBeenCalledWith("http://tei.test/embed", expect.objectContaining({ method: "POST" }));
  });

  it("falls back from unavailable local inference to the configured gateway embedding alias", async () => {
    vi.stubEnv("RAG_EMBEDDING_PROVIDER", "auto");
    vi.stubEnv("RAG_BGE_EMBEDDING_URL", "http://tei.test");
    vi.stubEnv("RAG_OPENROUTER_BASE_URL", "https://gateway.test/v1");
    vi.stubEnv("RAG_OPENROUTER_EMBEDDING_MODEL", "openrouter/text-embedding-3-small");
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-not-a-real-key");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null))
      .mockResolvedValueOnce(new Response("model unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ index: 0, embedding: Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0) }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new RagModelService().embed(["kebijakan layanan"]);

    expect(result.space).toBe("openrouter-text-embedding-3-small");
    expect(result.generation).toBe("openrouter-text-embedding-3-small@openrouter/text-embedding-3-small");
    expect(result.backend).toBe("openrouter");
    expect(result.vectors?.[0]).toHaveLength(1_536);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://gateway.test/v1/embeddings", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer test-only-not-a-real-key" }),
    }));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      model: "openrouter/text-embedding-3-small",
      input: ["kebijakan layanan"],
    });
  });

  it("records the model identity resolved by the embedding gateway", async () => {
    vi.stubEnv("RAG_EMBEDDING_PROVIDER", "openrouter");
    vi.stubEnv("RAG_OPENROUTER_EMBEDDING_MODEL", "openrouter/text-embedding-3-small");
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-not-a-real-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: "openai/text-embedding-3-small",
      data: [{ index: 0, embedding: Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0) }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const result = await new RagModelService().embed(["kebijakan layanan"]);

    expect(result.generation).toBe("openrouter-text-embedding-3-small@openai/text-embedding-3-small");
  });

  it("does not include provider error bodies in model diagnostics", async () => {
    vi.stubEnv("RAG_EMBEDDING_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-not-a-real-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private document excerpt", { status: 503 })));

    const error = await new RagModelService().embed(["private question"]).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("RAG model endpoint returned HTTP 503");
    expect((error as Error).message).not.toContain("private document excerpt");
  });

  it("includes a local endpoint model identity alongside the configured BGE revision", async () => {
    vi.stubEnv("RAG_EMBEDDING_PROVIDER", "bge");
    vi.stubEnv("RAG_BGE_EMBEDDING_URL", "http://tei.test");
    vi.stubEnv("RAG_BGE_EMBEDDING_REVISION", "revision-test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: "BAAI/bge-m3",
      embeddings: [Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0)],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const result = await new RagModelService().embed(["kebijakan layanan"]);

    expect(result.generation).toBe("bge-m3@revision-test:BAAI/bge-m3");
  });

  it("bounds gateway embedding requests to 32 inputs and preserves provider ordering", async () => {
    vi.stubEnv("RAG_EMBEDDING_PROVIDER", "openrouter");
    vi.stubEnv("RAG_OPENROUTER_BASE_URL", "https://gateway.test/v1");
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-not-a-real-key");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({
        data: body.input.map((_, index) => ({
          index: body.input.length - index - 1,
          embedding: Array.from({ length: 1_536 }, () => body.input.length - index - 1),
        })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new RagModelService().embed(Array.from({ length: 40 }, (_, index) => `chunk ${index}`));
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { input: string[] };
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { input: string[] };

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([firstBody.input.length, secondBody.input.length]).toEqual([32, 8]);
    expect(result.vectors).toHaveLength(40);
    expect(result.vectors?.slice(0, 32).map((vector) => vector[0])).toEqual(Array.from({ length: 32 }, (_, index) => index));
    expect(result.vectors?.slice(32).map((vector) => vector[0])).toEqual(Array.from({ length: 8 }, (_, index) => index));
  });

  it("keeps lexical-only ingestion available when configured local BGE and the gateway key are unavailable", async () => {
    vi.stubEnv("RAG_EMBEDDING_PROVIDER", "auto");
    vi.stubEnv("RAG_BGE_EMBEDDING_URL", "http://tei.test");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const fetchMock = vi.fn(async () => new Response("model unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new RagModelService().embed(["jaringan telekomunikasi"]);

    expect(result).toEqual({ vectors: null, space: null, generation: null, backend: null });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps lexical-only retrieval when the OpenRouter provider has no key", async () => {
    vi.stubEnv("RAG_EMBEDDING_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await new RagModelService().embed(["jaringan telekomunikasi"]);

    expect(result).toEqual({ vectors: null, space: null, generation: null, backend: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back from local BGE reranking to the configured Cohere gateway route", async () => {
    vi.stubEnv("RAG_BGE_RERANK_URL", "http://tei.test");
    vi.stubEnv("RAG_OPENROUTER_BASE_URL", "https://gateway.test/v1");
    vi.stubEnv("RAG_OPENROUTER_RERANK_MODEL", "openrouter/openrouter/cohere/rerank-v3.5");
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-not-a-real-key");
    const fetchMock = vi.fn(async () => new Response(null))
      .mockResolvedValueOnce(new Response("local reranker unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [
        { index: 1, relevance_score: 0.97 },
        { index: 0, relevance_score: 0.31 },
      ] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new RagModelService().rerank("cara aktivasi layanan", [
      { id: "faq", text: "Langkah aktivasi kartu" },
      { id: "policy", text: "Kebijakan aktivasi pelanggan" },
    ]);

    expect(result).toEqual([
      { id: "policy", score: 0.97 },
      { id: "faq", score: 0.31 },
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://gateway.test/v1/rerank", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer test-only-not-a-real-key" }),
    }));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      model: "openrouter/openrouter/cohere/rerank-v3.5",
      query: "cara aktivasi layanan",
      documents: ["Langkah aktivasi kartu", "Kebijakan aktivasi pelanggan"],
      top_n: 2,
      return_documents: false,
    });
  });

  it("treats malformed local rerank scores as unavailable and falls back to a complete gateway ranking", async () => {
    vi.stubEnv("RAG_BGE_RERANK_URL", "http://tei.test");
    vi.stubEnv("RAG_OPENROUTER_BASE_URL", "https://gateway.test/v1");
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-not-a-real-key");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response(null))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [
        { index: 0, score: 0.8 }, { index: 0, score: 0.7 },
      ] }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [
        { index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 },
      ] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new RagModelService().rerank("query", [
      { id: "first", text: "one" }, { id: "second", text: "two" },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ id: "second", score: 0.9 }, { id: "first", score: 0.2 }]);
  });

  it("rejects incomplete or duplicate gateway IDs so the caller uses JEV ordering", async () => {
    vi.stubEnv("RAG_OPENROUTER_BASE_URL", "https://gateway.test/v1");
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-not-a-real-key");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [
      { index: 0, relevance_score: 0.8 }, { index: 0, relevance_score: 0.7 },
    ] }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(new RagModelService().rerank("query", [
      { id: "first", text: "one" }, { id: "second", text: "two" },
    ])).resolves.toBeNull();
  });

  it("returns no model ranking when local and gateway rerank routes fail so the caller can use JEV", async () => {
    vi.stubEnv("RAG_BGE_RERANK_URL", "http://tei.test");
    vi.stubEnv("RAG_OPENROUTER_BASE_URL", "https://gateway.test/v1");
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-not-a-real-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    await expect(new RagModelService().rerank("query", [{ id: "chunk-1", text: "candidate" }])).resolves.toBeNull();
  });
});
