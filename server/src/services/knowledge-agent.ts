import type { Db } from "@paperclipai/db";
import { DataSourcesService } from "./data-sources.js";
import { TypeSafeJevService } from "./typesafe-jev.js";
import { aiReasoningService } from "./ai-reasoning.js";
import type { SpecialistExecution, Citation } from "@paperclipai/shared";

export class KnowledgeAgentService {
  private dataSourcesService: DataSourcesService;
  private jevService: TypeSafeJevService;

  constructor(private db: Db) {
    this.dataSourcesService = new DataSourcesService(db);
    this.jevService = new TypeSafeJevService();
  }

  /**
   * Execute RAG search and synthesize grounded evidence using TypeSafe Jev System One + LLM synthesis
   */
  async answer(
    companyId: string,
    query: string,
    options?: { dataSourceId?: string },
  ): Promise<SpecialistExecution> {
    const searchResults = await this.dataSourcesService.searchKnowledge(companyId, query, {
      dataSourceId: options?.dataSourceId,
      limit: 6,
    });

    if (searchResults.length === 0) {
      return {
        agent: "knowledge_agent",
        task: `Search knowledge base for: "${query}"`,
        resultsSummary: "Tidak ditemukan dokumen atau kebijakan internal yang cocok dengan kata kunci pencarian.",
        citations: [],
      };
    }

    // 1. Evaluate with TypeSafe Jev Decision Plane (Re-ranking & Answerability Check)
    let orderedResults = searchResults;
    let answerabilityNote = "";

    try {
      const jevEval = await this.jevService.rerankAndVerifyRag(
        query,
        searchResults.map((r) => ({
          chunkId: r.chunkId,
          content: r.content || r.snippet,
          sourceName: r.dataSourceName,
          baseScore: r.score,
        })),
      );

      if (jevEval.topChunkIds.length > 0) {
        orderedResults = [];
        for (const cid of jevEval.topChunkIds) {
          const match = searchResults.find((r) => r.chunkId === cid);
          if (match) orderedResults.push(match);
        }
        for (const r of searchResults) {
          if (!orderedResults.some((o) => o.chunkId === r.chunkId)) {
            orderedResults.push(r);
          }
        }
      }

      answerabilityNote = `\n> *Verifikasi TypeSafe Jev System One (jev-1.13.0): Relevansi terkalibrasi ${(jevEval.confidence * 100).toFixed(0)}%. Dokumen dinilai ${jevEval.isAnswerable ? "cukup menjawab" : "membutuhkan informasi tambahan"}.*\n\n`;
    } catch {
      // fallback to original order
    }

    const topResults = orderedResults.slice(0, 5);
    const citations: Citation[] = topResults.map((r) => ({
      sourceName: r.dataSourceName,
      section: r.title || undefined,
      snippet: r.snippet,
    }));

    // 2. Dynamic Agentic LLM Synthesis
    let synthesizedAnswer = "";
    try {
      const llmResponse = await aiReasoningService.synthesizeKnowledgeResponse({
        userQuery: query,
        chunks: topResults.map((r) => ({
          sourceName: r.dataSourceName,
          title: r.title || undefined,
          content: r.content || r.snippet,
          chunkId: r.chunkId,
        })),
      });
      if (llmResponse && llmResponse.length > 20) {
        synthesizedAnswer = llmResponse;
      }
    } catch (err: any) {
      console.warn("[KnowledgeAgent] LLM synthesis failed, falling back to excerpts:", err.message);
    }

    let summary = "";
    if (synthesizedAnswer) {
      summary = `${synthesizedAnswer}\n\n${answerabilityNote}`;
      summary += `### 📚 Sumber & Rujukan Dokumen Internal:\n`;
      for (let i = 0; i < citations.length; i++) {
        const c = citations[i];
        summary += `> **[${i + 1}] Sumber: ${c.sourceName}** (${c.section || "Bagian Dokumen"})\n`;
        summary += `> "${c.snippet}"\n\n`;
      }
    } else {
      summary = `Ditemukan ${citations.length} rujukan relevan dari basis pengetahuan internal:\n\n`;
      summary += answerabilityNote;
      for (let i = 0; i < citations.length; i++) {
        const c = citations[i];
        summary += `> **[${i + 1}] Sumber: ${c.sourceName}** (${c.section || "Bagian Dokumen"})\n`;
        summary += `> "${c.snippet}"\n\n`;
      }
    }

    return {
      agent: "knowledge_agent",
      task: `Retrieve and synthesize verified knowledge for: "${query}"`,
      query,
      resultsSummary: summary,
      citations,
    };
  }
}
