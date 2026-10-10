import { describe, expect, it } from "vitest";
import {
  classifyStepKind,
  extractThoughtAndAnswer,
  itemsToReasoningSteps,
} from "./reasoning-parser";

describe("reasoning-parser", () => {
  it("classifies step kinds accurately matching UI expectations", () => {
    expect(classifyStepKind("Saya sekarang sedang memperinci fitur dan modul")).toBe("thought");
    expect(classifyStepKind("Update task tracker for markdown PRD")).toBe("tool");
    expect(classifyStepKind("Run script to generate ultra-detailed PRD markdown")).toBe("command");
    expect(classifyStepKind("Check line count and headings of the markdown PRD")).toBe("command");
    expect(classifyStepKind("Google Workspace Search")).toBe("search");
    expect(classifyStepKind("Google Drive")).toBe("file");
    expect(classifyStepKind("Komputer")).toBe("command");
  });

  it("extracts thoughts and separates the final answer", () => {
    const raw = `<thought>
Saya sekarang sedang memperinci fitur dan modul, dengan format Markdown dan data yang lebih rinci.
Update task tracker for markdown PRD
Run script to generate ultra-detailed PRD markdown
</thought>
Ini adalah hasil akhir dalam format markdown.`;

    const parsed = extractThoughtAndAnswer(raw);
    expect(parsed.hasReasoning).toBe(true);
    expect(parsed.steps.length).toBeGreaterThan(0);
    expect(parsed.answer).toBe("Ini adalah hasil akhir dalam format markdown.");
  });

  it("converts TaskChatTurn child items into reasoning steps", () => {
    const items = [
      {
        id: "t1",
        kind: "thinking" as const,
        lines: ["Saya sedang memusatkan perhatian pada landasan persyaratan."],
      },
      {
        id: "t2",
        kind: "tool" as const,
        name: "run_script",
        target: "compile_and_render.py",
      },
    ];

    const steps = itemsToReasoningSteps(items as any);
    expect(steps.length).toBe(2);
    expect(steps[0].kind).toBe("thought");
    expect(steps[1].kind).toBe("command");
  });
});
