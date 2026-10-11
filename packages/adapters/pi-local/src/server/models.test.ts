import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  normalizePiModelId,
  resetPiModelsCacheForTests,
} from "./models.js";

describe("pi models", () => {
  let hostModelsDir: string | null = null;

  afterEach(async () => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    delete process.env.PI_CODING_AGENT_DIR;
    if (hostModelsDir) {
      const directory = hostModelsDir;
      hostModelsDir = null;
      await fs.rm(directory, { recursive: true, force: true });
    }
    resetPiModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("uses the default when model is missing and the host provides that model", async () => {
    hostModelsDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-models-"));
    await fs.writeFile(path.join(hostModelsDir, "models.json"), JSON.stringify({
      providers: {
        rissets: {
          models: [{ id: "llm-hd/qwen3.8-27b", name: "Qwen 3.8:27 (HD)" }],
        },
      },
    }));
    const piCommand = path.join(hostModelsDir, "pi-list-models");
    const discoveryMarker = path.join(hostModelsDir, "discovery-was-run");
    await fs.writeFile(piCommand, `#!/bin/sh\ntouch '${discoveryMarker}'\nexit 0\n`);
    await fs.chmod(piCommand, 0o755);
    process.env.PAPERCLIP_PI_COMMAND = piCommand;
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "",
        env: { PI_CODING_AGENT_DIR: hostModelsDir },
      }),
    ).resolves.toContainEqual(expect.objectContaining({ id: "rissets/llm-hd/qwen3.8-27b" }));
    await expect(fs.stat(discoveryMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses Pi CLI discovery when the configured model is absent from provider metadata", async () => {
    hostModelsDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-models-"));
    await fs.writeFile(path.join(hostModelsDir, "models.json"), JSON.stringify({
      providers: {
        rissets: {
          models: [{ id: "llm-hd/qwen3.8-27b" }],
        },
      },
    }));
    const piCommand = path.join(hostModelsDir, "pi-list-models");
    await fs.writeFile(piCommand, "#!/bin/sh\nprintf 'provider  model\\nopenai  gpt-4o\\n'\n");
    await fs.chmod(piCommand, 0o755);
    process.env.PI_CODING_AGENT_DIR = hostModelsDir;
    process.env.PAPERCLIP_PI_COMMAND = piCommand;

    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "openai/gpt-4o" }),
    ).resolves.toContainEqual(expect.objectContaining({ id: "openai/gpt-4o" }));
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

  it("does not embed the model catalogue when the configured model is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperclip-pi-models-"));
    const command = join(directory, "pi");
    const modelIds = Array.from({ length: 13 }, (_, index) => `provider/model-${index}`);
    await writeFile(
      command,
      `#!/bin/sh\nprintf 'provider  model\\n';\n${modelIds
        .map((id) => {
          const [provider, model] = id.split("/");
          return `printf '${provider}  ${model}\\n'`;
        })
        .join(";\n")}\n`,
    );
    await chmod(command, 0o755);

    try {
      await expect(
        ensurePiModelConfiguredAndAvailable({
          command,
          model: "provider/missing",
        }),
      ).rejects.toMatchObject({
        message:
          "Configured Pi model is unavailable: provider/missing. 13 models are available; list them with `pi --list-models`.",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
