import { describe, expect, it } from "vitest";
import {
  classifyStepKind,
  extractThoughtAndAnswer,
  itemsToReasoningSteps,
  cotPartsToReasoningSteps,
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

  it("converts cotParts into chronological reasoning steps matching screenshots", () => {
    const cotParts = [
      {
        type: "reasoning",
        text: "Saya sekarang sedang memperinci fitur dan modul, dengan format Markdown dan data yang lebih rinci.\nSaya telah memperjelas struktur data dan format keluaran Markdown, memastikan presentasi yang rinci dan lengkap.",
      },
      {
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "task_tracker",
        args: { description: "Update task tracker for markdown PRD" },
        result: { success: true },
      },
      {
        type: "tool-call",
        toolCallId: "tool-2",
        toolName: "run_command",
        args: {
          description: "Run script to generate ultra-detailed PRD markdown",
          command: "python generate.py",
        },
        result: { output: '{"rows":[{"mn":1}]}' },
      },
      {
        type: "tool-call",
        toolCallId: "tool-3",
        toolName: "google_search",
        args: { query: "Paperclip documentation" },
      },
      {
        type: "tool-call",
        toolCallId: "tool-4",
        toolName: "google_drive",
        args: { path: "/docs/specs.pdf" },
      },
      {
        type: "tool-call",
        toolCallId: "tool-5",
        toolName: "google_keep",
        args: { title: "Meeting notes" },
      },
    ];

    const steps = cotPartsToReasoningSteps(cotParts);
    expect(steps.length).toBe(6);
    expect(steps[0].kind).toBe("thought");
    expect(steps[0].title).toContain("Saya sekarang sedang memperinci");
    expect(steps[1].kind).toBe("tool");
    expect(steps[1].title).toBe("Update task tracker for markdown PRD");
    expect(steps[2].kind).toBe("command");
    expect(steps[2].title).toBe("Run script to generate ultra-detailed PRD markdown");
    expect(steps[3].kind).toBe("search");
    expect(steps[3].title).toBe("Search: Paperclip documentation");
    expect(steps[4].kind).toBe("file");
    expect(steps[4].title).toBe("View file: specs.pdf");
    expect(steps[5].kind).toBe("note");
    expect(steps[5].title).toBe("Meeting notes");
  });
});
