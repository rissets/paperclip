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
});
