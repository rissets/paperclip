import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  normalizePiModelId,
  resetPiModelsCacheForTests,
} from "./models.js";

describe("pi models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    resetPiModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });

  it("normalizes cmd/ models to rissets/cmd/ when appropriate", () => {
    expect(normalizePiModelId("cmd/gpt-5.6-luna")).toBe("rissets/cmd/gpt-5.6-luna");
    expect(normalizePiModelId("rissets/cmd/gpt-5.6-luna")).toBe("rissets/cmd/gpt-5.6-luna");
    expect(normalizePiModelId("openai/gpt-4o")).toBe("openai/gpt-4o");
    expect(normalizePiModelId("")).toBe("");
  });

  describe("syncCustomPiModels", () => {
    it("throws when endpoint is empty", async () => {
      const { syncCustomPiModels } = await import("./models.js");
      await expect(syncCustomPiModels({ endpoint: "" })).rejects.toThrow("Custom API endpoint is required");
    });

    it("fetches and parses OpenAI format models", async () => {
      const { syncCustomPiModels } = await import("./models.js");
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: any, init: any) => {
          expect(init?.headers?.Authorization).toBe("Bearer test-token");
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                { id: "gpt-4o", name: "GPT-4o" },
                { id: "gpt-4o-mini", name: "GPT-4o Mini" },
              ],
            }),
          };
        }) as any;

        const result = await syncCustomPiModels({
          endpoint: "https://api.openai.com/v1",
          apiKey: "test-token",
        });
        expect(result).toEqual([
          { id: "gpt-4o", label: "GPT-4o" },
          { id: "gpt-4o-mini", label: "GPT-4o Mini" },
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("fetches and parses Ollama format models", async () => {
      const { syncCustomPiModels } = await import("./models.js");
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              { name: "llama3:latest" },
              { name: "qwen2.5-coder:7b" },
            ],
          }),
        })) as any;

        const result = await syncCustomPiModels({
          endpoint: "http://localhost:11434/v1",
        });
        expect(result).toEqual([
          { id: "llama3:latest", label: "llama3:latest" },
          { id: "qwen2.5-coder:7b", label: "qwen2.5-coder:7b" },
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("normalizes model ID using available models", () => {
    const available = [
      { id: "rissets/llm-hd/qwen3.8-27b", label: "Qwen 3.8:27 (HD)" },
      { id: "custom/llama3:latest", label: "Llama 3" },
    ];
    expect(normalizePiModelId("llm-hd/qwen3.8-27b", available)).toBe("rissets/llm-hd/qwen3.8-27b");
    expect(normalizePiModelId("rissets/llm-hd/qwen3.8-27b", available)).toBe("rissets/llm-hd/qwen3.8-27b");
    expect(normalizePiModelId("llama3:latest", available)).toBe("custom/llama3:latest");
  });

  describe("listExistingPiConnections", () => {
    it("returns array of connections", async () => {
      const { listExistingPiConnections } = await import("./models.js");
      const conns = await listExistingPiConnections();
      expect(Array.isArray(conns)).toBe(true);
      if (conns.length > 0) {
        expect(conns[0]).toHaveProperty("id");
        expect(conns[0]).toHaveProperty("name");
        expect(conns[0]).toHaveProperty("baseUrl");
        expect(conns[0]).toHaveProperty("models");
      }
    });
  });
});
