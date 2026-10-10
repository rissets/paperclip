import type { TaskChatTurnChildItem } from "@/components/task-chat/task-chat-model";

export interface ReasoningStep {
  id: string;
  kind: "thought" | "command" | "tool" | "search" | "file" | "note" | "other";
  title: string;
  detail?: string;
  body?: string;
  status?: "running" | "completed" | "failed" | "interrupted";
}

/**
 * Classify a line, phrase, or tool name into a semantic step kind:
 * - "thought": Reflective internal reasoning (e.g. "Saya sekarang sedang...", "Menganalisis...")
 * - "command": Shell scripts, terminals, runs (e.g. "Run script...", "Compile and render...", "Komputer")
 * - "tool": Action tasks, updates, planners (e.g. "Update task...", "Create script...", "Verify...")
 * - "search": Web/workspace searches (e.g. "Google Workspace Search", "Web search")
 * - "file": Files and Cloud Drives (e.g. "Google Drive", "Read file...")
 * - "note": Notes and scratchpads (e.g. "Google Keep")
 */
export function classifyStepKind(text: string, defaultKind: ReasoningStep["kind"] = "tool"): ReasoningStep["kind"] {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Thought patterns (Indonesian and English reflective statements)
  if (
    /^(saya |kami |rangkuman |pemetaan |ukuran |analisis |menganalisis |memeriksa |menemukan |mengevaluasi |memperinci |menyusun |mencari |memastikan |i am |i'm |we |currently |thinking |reflecting |understanding )/i.test(trimmed) ||
    lower.includes("sedang memusatkan") ||
    lower.includes("sedang memperinci") ||
    lower.includes("sedang menyusun") ||
    lower.includes("terverifikasi")
  ) {
    return "thought";
  }

  // Command / Terminal / Script execution patterns
  if (
    /^(run |running |check |compile |compiling |execute |executing |komputer |terminal |script |node |python |bash |sh |pnpm |npm |cargo |git )/i.test(trimmed) ||
    lower.includes("compile_and_render") ||
    lower.includes(".py") ||
    lower.includes(".sh") ||
    lower === "komputer" ||
    lower === "terminal"
  ) {
    return "command";
  }

  // Search patterns
  if (lower.includes("search") || lower.includes("cari") || lower.includes("googling") || lower.includes("workspace search")) {
    return "search";
  }

  // File / Drive patterns
  if (lower.includes("drive") || lower.includes("file") || lower.includes("dokumen") || lower.includes("pdf") || lower.includes("folder")) {
    return "file";
  }

  // Note / Keep patterns
  if (lower.includes("keep") || lower.includes("note") || lower.includes("catatan")) {
    return "note";
  }

  // Tool / Action patterns
  if (
    /^(update |create |present |verify |complete |view |write |generate |make |buat |perbarui |hapus |simpan )/i.test(trimmed) ||
    lower.includes("task tracker") ||
    lower.includes("preview page") ||
    lower.includes("planner")
  ) {
    return "tool";
  }

  return defaultKind;
}

/**
 * Extracts thought/thinking/reasoning blocks and separates them from the final answer text.
 * Supports:
 * - `<thought>...</thought>`
 * - `<thinking>...</thinking>`
 * - `<reasoning>...</reasoning>`
 * - `<antThinking>...</antThinking>`
 * - ````thinking ... ```` or ````thought ... ````
 */
export function extractThoughtAndAnswer(rawText: string): {
  hasReasoning: boolean;
  steps: ReasoningStep[];
  answer: string;
} {
  if (!rawText) {
    return { hasReasoning: false, steps: [], answer: "" };
  }

  const tagRegex = /<(thought|thinking|reasoning|antThinking)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  const codeBlockRegex = /```(?:thinking|thought|reasoning)\b[^\r\n]*[\r\n]([\s\S]*?)```/gi;

  const collectedThoughtBlocks: string[] = [];
  let cleanedAnswer = rawText;

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(rawText)) !== null) {
    if (match[2]?.trim()) {
      collectedThoughtBlocks.push(match[2].trim());
    }
  }

  while ((match = codeBlockRegex.exec(rawText)) !== null) {
    if (match[1]?.trim()) {
      collectedThoughtBlocks.push(match[1].trim());
    }
  }

  if (collectedThoughtBlocks.length === 0) {
    // Also check for trailing open tags if streaming in progress
    const openTagMatch = /<(thought|thinking|reasoning|antThinking)(?:\s[^>]*)?>([\s\S]*)$/i.exec(rawText);
    if (openTagMatch && openTagMatch[2]?.trim()) {
      collectedThoughtBlocks.push(openTagMatch[2].trim());
      cleanedAnswer = rawText.replace(openTagMatch[0], "");
    }
  } else {
    cleanedAnswer = cleanedAnswer
      .replace(tagRegex, "")
      .replace(codeBlockRegex, "")
      .trim();
  }

  if (collectedThoughtBlocks.length === 0) {
    return { hasReasoning: false, steps: [], answer: rawText };
  }

  const steps: ReasoningStep[] = [];
  let stepIndex = 0;

  for (const block of collectedThoughtBlocks) {
    const paragraphs = block
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);

    for (const paragraph of paragraphs) {
      const lines = paragraph.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length > 1 && lines.every((line) => line.length < 120 && /^[-\*•\d\.]|\b(Update|Run|Check|Compile|View|Create|Verify)\b/i.test(line))) {
        for (const line of lines) {
          const cleanLine = line.replace(/^[-\*•\d\.\s]+/, "").trim();
          if (!cleanLine) continue;
          stepIndex++;
          steps.push({
            id: `step-${stepIndex}`,
            kind: classifyStepKind(cleanLine),
            title: cleanLine,
          });
        }
      } else {
        stepIndex++;
        const kind = classifyStepKind(paragraph, "thought");
        if (kind === "thought") {
          steps.push({
            id: `step-${stepIndex}`,
            kind: "thought",
            title: paragraph,
            body: paragraph,
          });
        } else {
          const firstLine = lines[0] ?? paragraph;
          const remaining = lines.slice(1).join("\n");
          steps.push({
            id: `step-${stepIndex}`,
            kind,
            title: firstLine,
            detail: remaining || undefined,
          });
        }
      }
    }
  }

  return {
    hasReasoning: steps.length > 0,
    steps,
    answer: cleanedAnswer,
  };
}

/**
 * Converts TaskChatTurnChildItem[] into a chronological flat array of ReasoningStep[]
 */
export function itemsToReasoningSteps(items: TaskChatTurnChildItem[]): ReasoningStep[] {
  const steps: ReasoningStep[] = [];
  let index = 0;

  function processItem(item: TaskChatTurnChildItem) {
    index++;
    if (item.kind === "thinking") {
      const body = item.lines.map((l) => l.trim()).filter(Boolean).join("\n");
      if (body) {
        steps.push({
          id: item.id || `think-${index}`,
          kind: "thought",
          title: body,
          body,
          status: item.streaming ? "running" : "completed",
        });
      }
    } else if (item.kind === "tool") {
      const rawName = item.rawName ?? item.name;
      const target = item.target;
      const displayTitle = target
        ? `${humanizeActionTitle(item.name)}: ${target}`
        : humanizeActionTitle(item.name);

      const kind = classifyToolKind(rawName, target || item.name);
      steps.push({
        id: item.id || `tool-${index}`,
        kind,
        title: displayTitle,
        detail: item.detail || target,
        status: item.status === "in_progress" || item.status === "pending"
          ? "running"
          : item.status === "failed"
            ? "failed"
            : "completed",
      });
    } else if (item.kind === "activity_phase") {
      if (Array.isArray(item.items)) {
        for (const subItem of item.items) {
          processItem(subItem as TaskChatTurnChildItem);
        }
      }
    } else if (item.kind === "protocol") {
      const title =
        "title" in item && typeof (item as any).title === "string"
          ? (item as any).title
          : "surface" in item
            ? `Protocol ${(item as any).surface}`
            : "Protocol Activity";
      const detail =
        "summary" in item && typeof (item as any).summary === "string"
          ? (item as any).summary
          : "detail" in item && typeof (item as any).detail === "string"
            ? (item as any).detail
            : undefined;
      steps.push({
        id: item.id || `protocol-${index}`,
        kind: "tool",
        title,
        detail,
        status: "completed",
      });
    } else if (item.kind === "marker") {
      steps.push({
        id: item.id || `marker-${index}`,
        kind: "other",
        title: item.label,
        detail: item.detail,
        status: "completed",
      });
    }
  }

  for (const item of items) {
    processItem(item);
  }

  return steps;
}

function humanizeActionTitle(name: string): string {
  if (!name) return "Action";
  const formatted = name
    .replace(/^(mcp__[^_]+__|custom__)/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return formatted;
}

function classifyToolKind(toolName: string, target = ""): ReasoningStep["kind"] {
  const combined = `${toolName} ${target}`.toLowerCase();
  if (
    combined.includes("command") ||
    combined.includes("exec") ||
    combined.includes("bash") ||
    combined.includes("sh") ||
    combined.includes("terminal") ||
    combined.includes("script") ||
    combined.includes(".py") ||
    combined.includes(".sh")
  ) {
    return "command";
  }
  if (combined.includes("search") || combined.includes("browse") || combined.includes("query")) {
    return "search";
  }
  if (combined.includes("drive") || combined.includes("file") || combined.includes("folder")) {
    return "file";
  }
  return "tool";
}
