export type DataSourceEmbeddingProvider = "auto" | "bge" | "openrouter";

export interface DataSourceModelConfig {
  embeddingProvider: DataSourceEmbeddingProvider;
  bgeEmbeddingUrl: string | undefined;
  bgeRerankUrl: string | undefined;
  bgeEmbeddingRevision: string;
  openRouterBaseUrl: string;
  openRouterApiKey: string | undefined;
  openRouterEmbeddingModel: string;
  openRouterRerankModel: string;
}

const DEFAULT_GATEWAY = "https://router.rissets.com/v1";
const DEFAULT_EMBEDDING_MODEL = "openrouter/text-embedding-3-small";
const DEFAULT_RERANK_MODEL = "openrouter/openrouter/cohere/rerank-v3.5";
const DEFAULT_BGE_REVISION = "80087bf0b7876bc948d3b5677706633f6c795fa2";
const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:/@-]{1,192}$/;

function configuredValue(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  return env[key]?.trim() || fallback;
}

function parseHttpUrl(key: string, raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`${key} must be a valid HTTP(S) URL`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw new Error(`${key} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

function parseModelId(key: string, value: string): string {
  if (!MODEL_ID_PATTERN.test(value)) throw new Error(`${key} must be a valid model identifier`);
  return value;
}

/** Parse datasource inference settings without probing optional dependencies. */
export function parseDataSourceModelConfig(env: NodeJS.ProcessEnv = process.env): DataSourceModelConfig {
  const providerValue = configuredValue(env, "RAG_EMBEDDING_PROVIDER", "auto");
  if (providerValue !== "auto" && providerValue !== "bge" && providerValue !== "openrouter") {
    throw new Error("RAG_EMBEDDING_PROVIDER must be one of: auto, bge, openrouter");
  }

  const configuredGateway = parseHttpUrl("RAG_OPENROUTER_BASE_URL", env.RAG_OPENROUTER_BASE_URL);
  const gateway = configuredGateway || DEFAULT_GATEWAY;
  const bgeEmbeddingUrl = parseHttpUrl("RAG_BGE_EMBEDDING_URL", env.RAG_BGE_EMBEDDING_URL);
  const bgeRerankUrl = parseHttpUrl("RAG_BGE_RERANK_URL", env.RAG_BGE_RERANK_URL);
  const embeddingModel = parseModelId(
    "RAG_OPENROUTER_EMBEDDING_MODEL",
    configuredValue(env, "RAG_OPENROUTER_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL),
  );
  const rerankModel = parseModelId(
    "RAG_OPENROUTER_RERANK_MODEL",
    configuredValue(env, "RAG_OPENROUTER_RERANK_MODEL", DEFAULT_RERANK_MODEL),
  );
  const bgeRevision = parseModelId(
    "RAG_BGE_EMBEDDING_REVISION",
    configuredValue(env, "RAG_BGE_EMBEDDING_REVISION", DEFAULT_BGE_REVISION),
  );
  const rawApiKey = env.OPENROUTER_API_KEY?.trim();
  const isPlaceholderKey = !rawApiKey || rawApiKey.startsWith("replace-with-") || rawApiKey === "your-api-key";
  const apiKey = isPlaceholderKey ? undefined : rawApiKey;

  return {
    embeddingProvider: providerValue,
    bgeEmbeddingUrl,
    bgeRerankUrl,
    bgeEmbeddingRevision: bgeRevision,
    openRouterBaseUrl: gateway,
    openRouterApiKey: apiKey,
    openRouterEmbeddingModel: embeddingModel,
    openRouterRerankModel: rerankModel,
  };
}

/** Fail fast only for malformed explicit settings; no GPU or gateway probe is required. */
export function validateDataSourceModelConfig(env: NodeJS.ProcessEnv = process.env): void {
  parseDataSourceModelConfig(env);
}
