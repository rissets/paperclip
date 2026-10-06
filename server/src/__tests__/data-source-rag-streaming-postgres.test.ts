import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, dataSourceChunks, dataSources } from "@paperclipai/db";
import { OnboardingOrchestratorService } from "../services/onboarding-orchestrator.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const ragState = vi.hoisted(() => ({ embeddingBatchSizes: [] as number[] }));

vi.mock("../services/ai-reasoning.js", () => ({
  aiReasoningService: {
    analyzeDocument: vi.fn(async () => ({
      result: {
        domain: "Policies",
        entities: ["Policy"],
        primaryTopics: ["service obligations"],
        summary: "Streamed policy corpus",
        targetAgentAffinity: "rag_agent",
        suggestedQueries: [],
        documentProfiles: [{ name: "service-policy", description: "Service policies" }],
      },
      reasoningSteps: [],
    })),
  },
}));

vi.mock("../services/rag-models.js", () => ({
  RagModelService: class {
    async embed(texts: string[]) {
      ragState.embeddingBatchSizes.push(texts.length);
      return {
        vectors: texts.map(() => Array.from({ length: 1024 }, () => 0.01)),
        space: "bge-m3",
        generation: "bge-m3@test-revision",
        backend: "test-bge",
      };
    }
    async rerank() { return null; }
  },
}));

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`RAG streaming PostgreSQL integration unavailable: ${support.reason}`);
(support.supported ? describe : describe.skip)("RAG streaming onboarding PostgreSQL integration", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let directory: string;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-rag-streaming-");
    db = createDb(temporary.connectionString);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-rag-streaming-file-"));
  }, 90_000);

  beforeEach(async () => {
    ragState.embeddingBatchSizes.length = 0;
    await db.delete(companies);
  });

  afterAll(async () => {
    await fs.rm(directory, { recursive: true, force: true });
    await temporary?.cleanup();
  });

  it("persists every streamed chunk while embedding bounded batches and retaining a 100-chunk semantic sample", async () => {
    const companyId = randomUUID();
    const sourceId = randomUUID();
    const sectionCount = 180;
    const sourceText = Array.from(
      { length: sectionCount },
      (_, index) => `## Section ${index + 1}\n\nThe service obligation for customer region ${index + 1} has an explicit policy and support process.`,
    ).join("\n\n");
    const filePath = path.join(directory, "large-policy.md");
    await fs.writeFile(filePath, sourceText, "utf8");

    await db.insert(companies).values({
      id: companyId,
      name: "RAG streaming test",
      issuePrefix: `R${companyId.slice(0, 8)}`,
    });
    const [source] = await db.insert(dataSources).values({
      id: sourceId,
      companyId,
      name: "Large policy",
      sourceType: "rag_document",
      status: "processing",
      fileName: "large-policy.md",
    }).returning();

    const service = new OnboardingOrchestratorService(db) as unknown as {
      executeOnboardingPipeline(
        companyId: string,
        source: typeof source,
        file: { filePath: string; originalname: string; mimetype: string; size: number },
        options: Record<string, unknown>,
        defaultName: string,
        extension: string,
        sourceType: "rag_document",
      ): Promise<{ metadata: Record<string, unknown>; chunks: Array<{ chunkIndex: number }> }>;
    };

    const result = await service.executeOnboardingPipeline(
      companyId,
      source,
      { filePath, originalname: "large-policy.md", mimetype: "text/markdown", size: Buffer.byteLength(sourceText) },
      { skipCorrelation: true },
      "Large policy",
      "md",
      "rag_document",
    );

    const storedChunks = await db.select().from(dataSourceChunks)
      .where(eq(dataSourceChunks.dataSourceId, sourceId))
      .orderBy(asc(dataSourceChunks.chunkIndex));
    const [storedSource] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));

    expect(storedChunks).toHaveLength(sectionCount);
    expect(storedChunks[0]?.chunkIndex).toBe(0);
    expect(storedChunks.at(-1)?.chunkIndex).toBe(sectionCount - 1);
    expect(storedChunks.at(-1)?.content).toContain("region 180");
    expect(ragState.embeddingBatchSizes).toEqual([32, 32, 32, 32, 32, 20]);
    expect(Math.max(...ragState.embeddingBatchSizes)).toBeLessThanOrEqual(32);
    expect(result.chunks).toHaveLength(10);
    expect(result.metadata.chunkCount).toBe(sectionCount);
    expect((result.metadata.semanticProfile as { documentProfiles: unknown[] }).documentProfiles).toHaveLength(1);
    expect(storedSource?.status).toBe("ready");
    expect(storedSource?.metadata?.embeddingSpace).toBe("bge-m3");
  }, 30_000);
});
