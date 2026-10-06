import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchKnowledge: vi.fn(),
  synthesizeKnowledgeResponse: vi.fn(),
}));

vi.mock("../services/data-sources.js", () => ({
  DataSourcesService: class {
    async searchKnowledge(...args: unknown[]) {
      return mocks.searchKnowledge(...args);
    }
  },
}));

vi.mock("../services/ai-reasoning.js", () => ({
  aiReasoningService: {
    synthesizeKnowledgeResponse: (...args: unknown[]) => mocks.synthesizeKnowledgeResponse(...args),
  },
}));

import { KnowledgeAgentService } from "../services/knowledge-agent.js";
import { RagModelService } from "../services/rag-models.js";
import { TypeSafeJevService } from "../services/typesafe-jev.js";

const results = [
  { chunkId: "c1", dataSourceId: "ds1", dataSourceName: "Policy", title: "SLA", content: "Uptime minimum adalah 99.9 persen.", snippet: "Uptime minimum adalah 99.9 persen.", score: 0.9, tokenCount: 12 },
  { chunkId: "c2", dataSourceId: "ds1", dataSourceName: "Policy", title: "Credits", content: "Kredit layanan berlaku setelah klaim disetujui.", snippet: "Kredit layanan berlaku setelah klaim disetujui.", score: 0.8, tokenCount: 12 },
];

afterEach(() => {
  vi.restoreAllMocks();
  mocks.searchKnowledge.mockReset();
  mocks.synthesizeKnowledgeResponse.mockReset();
});

describe("KnowledgeAgent evidence gate", () => {
  it("returns cited excerpts without synthesis when JEV says evidence is insufficient", async () => {
    mocks.searchKnowledge.mockResolvedValue(results);
    const jev = vi.spyOn(TypeSafeJevService.prototype, "rerankAndVerifyRag").mockResolvedValue({
      topChunkIds: ["c1"],
      confidence: 0.31,
      isAnswerable: false,
    } as Awaited<ReturnType<TypeSafeJevService["rerankAndVerifyRag"]>>);
    vi.spyOn(RagModelService.prototype, "rerank").mockResolvedValue(null);
    const agent = new KnowledgeAgentService({} as any);

    const response = await agent.answer("company-1", "Berapa SLA layanan?");

    expect(jev).toHaveBeenCalledOnce();
    expect(mocks.synthesizeKnowledgeResponse).not.toHaveBeenCalled();
    expect(response.resultsSummary).toContain("membutuhkan informasi tambahan");
    expect(response.citations.length).toBeGreaterThan(0);
  });

  it("keeps the cross-encoder order while using JEV for answerability", async () => {
    mocks.searchKnowledge.mockResolvedValue(results);
    mocks.synthesizeKnowledgeResponse.mockResolvedValue("SLA minimum adalah 99.9 persen per ketentuan dokumen.");
    vi.spyOn(RagModelService.prototype, "rerank").mockResolvedValue([
      { id: "c2", score: 0.99 },
      { id: "c1", score: 0.8 },
    ]);
    const jev = vi.spyOn(TypeSafeJevService.prototype, "rerankAndVerifyRag").mockResolvedValue({
      topChunkIds: ["c1", "c2"],
      confidence: 0.92,
      isAnswerable: true,
    } as Awaited<ReturnType<TypeSafeJevService["rerankAndVerifyRag"]>>);
    const agent = new KnowledgeAgentService({} as any);

    const response = await agent.answer("company-1", "Berapa SLA layanan?");

    expect(jev).toHaveBeenCalledOnce();
    expect(mocks.synthesizeKnowledgeResponse).toHaveBeenCalledWith(expect.objectContaining({
      chunks: [expect.objectContaining({ chunkId: "c2" }), expect.objectContaining({ chunkId: "c1" })],
    }));
    expect(response.citations[0]?.section).toBe("Credits");
  });
});
