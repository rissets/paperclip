import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchModelsFromEndpoint } from "../services/custom-endpoint-models.js";

describe("fetchModelsFromEndpoint", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches models from standard OpenAI format endpoint", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "gpt-4o", name: "GPT-4o" },
          { id: "gpt-4o-mini", name: "GPT-4o Mini" },
        ],
      }),
    } as Response);

    const models = await fetchModelsFromEndpoint({
      endpoint: "https://api.openai.com/v1",
      apiKey: "test-key",
    });

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("gpt-4o");
    expect(models[1].id).toBe("gpt-4o-mini");
  });

  it("fetches models from Ollama format endpoint", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/models") || url.endsWith("/v1/models")) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: async () => "Not Found",
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { name: "llama3:latest" },
            { name: "qwen2.5:7b" },
          ],
        }),
      } as Response);
    });

    const models = await fetchModelsFromEndpoint({
      endpoint: "http://localhost:11434",
    });

    expect(models).toHaveLength(2);
    expect(models.map(m => m.id)).toEqual(["llama3:latest", "qwen2.5:7b"]);
  });

  it("throws authentication error when 401 is received", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    } as Response);

    await expect(
      fetchModelsFromEndpoint({
        endpoint: "https://api.example.com/v1",
        apiKey: "bad-key",
      }),
    ).rejects.toThrow("Authentication failed (401)");
  });

  it("throws descriptive error when no models found", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    } as Response);

    await expect(
      fetchModelsFromEndpoint({
        endpoint: "https://api.example.com/v1",
      }),
    ).rejects.toThrow("No models returned by endpoint.");
  });
});
