import { parseDataSourceModelConfig } from "./data-source-model-config.js";

type EmbeddingSpace = "bge-m3" | "openrouter-text-embedding-3-small";
type EmbeddingBatch = { vectors: number[][] | null; space: EmbeddingSpace | null; generation: string | null; backend: string | null };

const OPENROUTER_VECTOR_DIMENSIONS = 1536;

function normalizeVector(vector: unknown, expectedDimension?: number): number[] {
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("Embedding provider returned an invalid vector");
  }
  if (expectedDimension && vector.length !== expectedDimension) {
    throw new Error(`Embedding provider returned ${vector.length} dimensions; expected ${expectedDimension}`);
  }
  return [...vector] as number[];
}

function gatewayConfig() {
  const config = parseDataSourceModelConfig();
  return {
    baseUrl: config.openRouterBaseUrl,
    apiKey: config.openRouterApiKey,
    embeddingModel: config.openRouterEmbeddingModel,
    rerankModel: config.openRouterRerankModel,
  };
}

function normalizeResolvedModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const model = value.trim();
  if (!model || model.length > 192 || !/^[a-zA-Z0-9._:/@-]+$/.test(model)) {
    throw new Error("Embedding provider returned an invalid model identity");
  }
  return model;
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs = 30000): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    // Provider error bodies may echo queries, document snippets, or credentials.
    // Keep diagnostics useful without copying remote response content into logs.
    throw new Error(`RAG model endpoint returned HTTP ${response.status}`);
  }
  return response.json();
}

async function embedWithBge(texts: string[]): Promise<{ vectors: number[][]; resolvedModel: string | null }> {
  const endpoint = parseDataSourceModelConfig().bgeEmbeddingUrl;
  if (!endpoint) throw new Error("Local BGE embedding endpoint is not configured");
  const response = await postJson(endpoint.replace(/\/+$/, "") + "/embed", { inputs: texts }, {}, 60000);
  const vectors = Array.isArray(response) ? response : response?.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error("Local BGE endpoint returned a different number of embeddings than inputs");
  }
  return {
    vectors: vectors.map((vector) => normalizeVector(vector, 1024)),
    resolvedModel: normalizeResolvedModel(response?.model ?? response?.model_id),
  };
}

async function embedWithGateway(texts: string[]): Promise<{ vectors: number[][]; resolvedModel: string }> {
  const config = gatewayConfig();
  if (!config.apiKey) throw new Error("OPENROUTER_API_KEY is required when the local BGE service is unavailable");
  const response = await postJson(
    `${config.baseUrl}/embeddings`,
    { model: config.embeddingModel, input: texts },
    { authorization: `Bearer ${config.apiKey}` },
    60000,
  );
  const entries = Array.isArray(response?.data) ? [...response.data].sort((a, b) => Number(a.index) - Number(b.index)) : [];
  if (entries.length !== texts.length) throw new Error("Embedding gateway returned a different number of vectors than inputs");
  return {
    vectors: entries.map((entry) => normalizeVector(entry.embedding, OPENROUTER_VECTOR_DIMENSIONS)),
    // OpenAI-compatible gateways may return the alias or the upstream model ID.
    // Keep the reported value so a later alias retarget cannot mix generations.
    resolvedModel: normalizeResolvedModel(response?.model) || config.embeddingModel,
  };
}

function parseRerankResults(
  rawEntries: unknown,
  documents: Array<{ id: string; text: string }>,
  readScore: (entry: Record<string, unknown>) => unknown,
): Array<{ id: string; score: number }> {
  if (!Array.isArray(rawEntries) || rawEntries.length !== documents.length) {
    throw new Error("Rerank provider returned an incomplete result set");
  }
  const seen = new Set<number>();
  const ranked = rawEntries.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Rerank provider returned an invalid result");
    const entry = raw as Record<string, unknown>;
    const index = entry.index;
    const score = readScore(entry);
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= documents.length || seen.has(index)
      || typeof score !== "number" || !Number.isFinite(score)) {
      throw new Error("Rerank provider returned an invalid result");
    }
    seen.add(index);
    return { id: documents[index].id, score };
  });
  return ranked.sort((left, right) => right.score - left.score);
}

export class RagModelService {
  /** Stable requested-model identity used to keep vectors from model revisions isolated. */
  embeddingGeneration(space: EmbeddingSpace, resolvedModel?: string | null): string {
    if (space === "bge-m3") {
      const revision = parseDataSourceModelConfig().bgeEmbeddingRevision;
      const modelIdentity = resolvedModel ? `:${resolvedModel}` : "";
      return `bge-m3@${revision}${modelIdentity}`;
    }
    const config = gatewayConfig();
    return `openrouter-text-embedding-3-small@${resolvedModel || config.embeddingModel}`;
  }

  /**
   * Use local BGE when configured and healthy; fall back to the OpenRouter
   * compatible endpoint when the VM has no GPU/model service. One batch uses
   * one embedding space so vectors from different models are never mixed.
   */
  async embed(texts: string[], preferredSpace?: EmbeddingSpace): Promise<EmbeddingBatch> {
    if (texts.length === 0) return { vectors: [], space: null, generation: null, backend: null };
    const provider = parseDataSourceModelConfig().embeddingProvider;
    const canTryBge = provider !== "openrouter" && (!preferredSpace || preferredSpace === "bge-m3");

    if (canTryBge) {
      try {
        const vectors: number[][] = [];
        let resolvedGeneration: string | null = null;
        for (let offset = 0; offset < texts.length; offset += 32) {
          const result = await embedWithBge(texts.slice(offset, offset + 32));
          const generation = this.embeddingGeneration("bge-m3", result.resolvedModel);
          if (resolvedGeneration && resolvedGeneration !== generation) {
            throw new Error("Local BGE model identity changed between embedding batches");
          }
          resolvedGeneration = generation;
          vectors.push(...result.vectors);
        }
        return { vectors, space: "bge-m3", generation: resolvedGeneration || this.embeddingGeneration("bge-m3"), backend: "local-bge-m3" };
      } catch (error) {
        if (provider === "bge" || preferredSpace === "bge-m3") throw error;
      }
    }

    if (preferredSpace && preferredSpace !== "openrouter-text-embedding-3-small") {
      throw new Error(`No configured embedding provider for embedding space ${preferredSpace}`);
    }
    try {
      const vectors: number[][] = [];
      let resolvedGeneration: string | null = null;
      for (let offset = 0; offset < texts.length; offset += 32) {
        const result = await embedWithGateway(texts.slice(offset, offset + 32));
        const generation = this.embeddingGeneration("openrouter-text-embedding-3-small", result.resolvedModel);
        if (resolvedGeneration && resolvedGeneration !== generation) {
          throw new Error("Embedding gateway model identity changed between batches");
        }
        resolvedGeneration = generation;
        vectors.push(...result.vectors);
      }
      return {
        vectors,
        space: "openrouter-text-embedding-3-small",
        generation: resolvedGeneration || this.embeddingGeneration("openrouter-text-embedding-3-small"),
        backend: "openrouter",
      };
    } catch (error) {
      // Keep lexical retrieval available on unconfigured developer instances;
      // never invent a pseudo-semantic vector or compare incompatible models.
      if ((provider === "auto" || provider === "openrouter") && !gatewayConfig().apiKey) {
        return { vectors: null, space: null, generation: null, backend: null };
      }
      throw error;
    }
  }

  async rerank(query: string, documents: Array<{ id: string; text: string }>): Promise<Array<{ id: string; score: number }> | null> {
    if (documents.length === 0) return [];
    const localEndpoint = parseDataSourceModelConfig().bgeRerankUrl;
    if (localEndpoint) {
      try {
        const response = await postJson(
          localEndpoint.replace(/\/+$/, "") + "/rerank",
          { query, texts: documents.map((item) => item.text), return_text: false },
          {},
          30000,
        );
        const entries = Array.isArray(response) ? response : response?.results;
        return parseRerankResults(entries, documents, (entry) => entry.score ?? entry.relevance_score);
      } catch (error) {
        console.warn("[RagModelService] Local BGE reranking unavailable; trying gateway/JEV fallback:", error instanceof Error ? error.message : error);
      }
    }

    const config = gatewayConfig();
    if (!config.apiKey) return null;
    try {
      const response = await postJson(
        `${config.baseUrl}/rerank`,
        {
          model: config.rerankModel,
          query,
          documents: documents.map((item) => item.text),
          top_n: documents.length,
          return_documents: false,
        },
        { authorization: `Bearer ${config.apiKey}` },
        30000,
      );
      const entries: Array<{ index?: unknown; relevance_score?: unknown; score?: unknown }> =
        Array.isArray(response?.results) ? response.results : [];
      return parseRerankResults(entries, documents, (entry) => entry.relevance_score ?? entry.score);
    } catch (error) {
      console.warn("[RagModelService] Gateway reranking unavailable; using TypeSafe JEV fallback:", error instanceof Error ? error.message : error);
      return null;
    }
  }
}

export type { EmbeddingSpace };
