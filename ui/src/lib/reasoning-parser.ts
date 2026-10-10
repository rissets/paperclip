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

export interface RawCoTPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  argsText?: string;
  result?: unknown;
}

function isToolError(result: unknown): boolean {
  if (!result) return false;
  if (typeof result === "object" && (result as any).isError) return true;
  if (typeof result === "string" && /exited with code [^0]/i.test(result)) return true;
  return false;
}

/**
 * Converts a stream of CoT message parts (reasoning + tool calls)
 * into a structured, chronological list of ReasoningStep items.
 */
export function cotPartsToReasoningSteps(
  cotParts: readonly RawCoTPart[],
): ReasoningStep[] {
  const steps: ReasoningStep[] = [];

  for (const part of cotParts) {
    if (part.type === "reasoning") {
      const text = (part.text ?? "").trim();
      if (!text) continue;

      const paragraphs = text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean);

      for (const paragraph of paragraphs) {
        const lines = paragraph.split("\n").map((l) => l.trim()).filter(Boolean);
        if (
          lines.length > 1 &&
          lines.every(
            (line) =>
              line.length < 140 &&
              /^[-\*•\d\.]|\b(Update|Run|Check|Compile|View|Create|Verify|Present)\b/i.test(line),
          )
        ) {
          for (const line of lines) {
            const cleanLine = line.replace(/^[-\*•\d\.\s]+/, "").trim();
            if (!cleanLine) continue;
            steps.push({
              id: `cot-step-${steps.length + 1}`,
              kind: classifyStepKind(cleanLine),
              title: cleanLine,
              status: "completed",
            });
          }
        } else {
          const kind = classifyStepKind(paragraph, "thought");
          if (kind === "thought") {
            steps.push({
              id: `cot-think-${steps.length + 1}`,
              kind: "thought",
              title: paragraph,
              body: paragraph,
              status: "completed",
            });
          } else {
            const firstLine = lines[0] ?? paragraph;
            const remaining = lines.slice(1).join("\n");
            steps.push({
              id: `cot-step-${steps.length + 1}`,
              kind,
              title: firstLine,
              detail: remaining || undefined,
              status: "completed",
            });
          }
        }
      }
    } else if (part.type === "tool-call") {
      const toolName = part.toolName || "tool";
      let parsedArgs: any = part.args;
      if (!parsedArgs && typeof part.argsText === "string") {
        try {
          parsedArgs = JSON.parse(part.argsText);
        } catch {}
      }

      const record =
        parsedArgs && typeof parsedArgs === "object" ? parsedArgs : {};

      const humanDescription =
        typeof record.toolSummary === "string" && record.toolSummary.trim()
          ? record.toolSummary.trim()
          : typeof record.toolAction === "string" && record.toolAction.trim()
            ? record.toolAction.trim()
            : typeof record.description === "string" && record.description.trim()
              ? record.description.trim()
              : typeof record.summary === "string" && record.summary.trim()
                ? record.summary.trim()
                : typeof record.intent === "string" && record.intent.trim()
                  ? record.intent.trim()
                  : typeof record.task === "string" && record.task.trim()
                    ? record.task.trim()
                    : typeof record.title === "string" && record.title.trim()
                      ? record.title.trim()
                      : null;

      let title = humanDescription;
      let kind: ReasoningStep["kind"] = "tool";

      const isCommand =
        /^(run|exec|bash|sh|terminal|command|komputer)/i.test(toolName) ||
        Boolean(record.CommandLine || record.command || record.cmd);

      if (isCommand) {
        kind = "command";
        if (!title) {
          const cmd = record.CommandLine || record.command || record.cmd;
          if (typeof cmd === "string" && cmd.trim()) {
            const clean = cmd
              .replace(/^bash\s+-c\s+["']?/, "")
              .replace(/["']?$/, "")
              .trim();
            title = clean.length > 80 ? `Run: ${clean.slice(0, 80)}…` : `Run: ${clean}`;
          } else {
            title = "Komputer";
          }
        }
      } else if (
        /search|grep|glob|find|query/i.test(toolName) ||
        Boolean(record.query)
      ) {
        kind = "search";
        if (!title) {
          const q = record.query || record.pattern;
          title = typeof q === "string" && q.trim() ? `Search: ${q.trim()}` : "Search";
        }
      } else if (
        /drive|file|document|pdf|read|write|patch|folder/i.test(toolName) ||
        Boolean(record.TargetFile || record.path || record.filePath)
      ) {
        kind = "file";
        if (!title) {
          const f = record.TargetFile || record.path || record.filePath || record.file;
          if (typeof f === "string" && f.trim()) {
            const base = f.split("/").pop() ?? f;
            const prefix = /write/i.test(toolName)
              ? "Write file"
              : /edit/i.test(toolName)
                ? "Edit file"
                : "View file";
            title = `${prefix}: ${base}`;
          } else {
            title = humanizeActionTitle(toolName);
          }
        }
      } else if (/keep|note|scratchpad/i.test(toolName)) {
        kind = "note";
        if (!title) title = "Note";
      } else {
        if (!title) {
          title = humanizeActionTitle(toolName);
        }
        kind = classifyStepKind(title, "tool");
      }

      if (title && kind === "tool") {
        kind = classifyStepKind(title, "tool");
      }

      const status =
        part.result === undefined
          ? "running"
          : isToolError(part.result)
            ? "failed"
            : "completed";

      steps.push({
        id: part.toolCallId || `tool-${steps.length + 1}`,
        kind,
        title: title || humanizeActionTitle(toolName),
        status,
      });
    }
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
