import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function extractTextContent(content: string | Array<{ type: string; text?: string; thinking?: string }>): { text: string; thinking: string } {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  
  let text = "";
  let thinking = "";
  
  for (const c of content) {
    if (c.type === "text" && c.text) {
      text += c.text;
    }
    if (c.type === "thinking" && c.thinking) {
      thinking += c.thinking;
    }
  }
  
  return { text, thinking };
}

type PiStdoutParserState = {
  pendingToolCalls: Map<string, { toolName: string; args: unknown }>;
  thinkingText: string;
  assistantText: string;
};

function createParserState(): PiStdoutParserState {
  return { pendingToolCalls: new Map(), thinkingText: "", assistantText: "" };
}

function resetParserStateForRun(state: PiStdoutParserState): void {
  state.pendingToolCalls.clear();
  state.thinkingText = "";
  state.assistantText = "";
}

function appendSnapshot(
  kind: "thinking" | "assistant",
  text: string,
  ts: string,
  state: PiStdoutParserState,
): TranscriptEntry[] {
  if (!text) return [];
  const currentText = kind === "thinking" ? state.thinkingText : state.assistantText;

  // Pi reports the same message more than once: streamed deltas are followed
  // by thinking_end/text_end, message_end, turn_end, and sometimes agent_end
  // snapshots. Keep one transcript item for that message lifecycle.
  if (text === currentText || (currentText && currentText.startsWith(text))) return [];

  if (currentText && text.startsWith(currentText)) {
    const delta = text.slice(currentText.length);
    if (kind === "thinking") state.thinkingText = text;
    else state.assistantText = text;
    return delta ? [{ kind, ts, text: delta, delta: true }] : [];
  }

  if (kind === "thinking") state.thinkingText = text;
  else state.assistantText = text;
  return [{ kind, ts, text }];
}

function appendDelta(
  kind: "thinking" | "assistant",
  text: string,
  ts: string,
  state: PiStdoutParserState,
): TranscriptEntry[] {
  if (!text) return [];
  if (kind === "thinking") state.thinkingText += text;
  else state.assistantText += text;
  return [{ kind, ts, text, delta: true }];
}

export function resetParserState(): void {
  resetParserStateForRun(defaultParserState);
}

function parsePiStdoutLineWithState(line: string, ts: string, state: PiStdoutParserState): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    // Non-JSON line, treat as raw stdout
    const trimmed = line.trim();
    if (!trimmed) return [];
    return [{ kind: "stdout", ts, text: trimmed }];
  }

  const type = asString(parsed.type);

  // RPC protocol messages - filter these out (internal implementation detail)
  if (type === "response" || type === "extension_ui_request" || type === "extension_ui_response" || type === "extension_error") {
    return [];
  }

  // Agent lifecycle
  if (type === "agent_start") {
    resetParserStateForRun(state);
    return [{ kind: "system", ts, text: "🚀 Pi agent started" }];
  }

  if (type === "agent_end") {
    const entries: TranscriptEntry[] = [];
    
    // Extract final message from messages array if available
    const messages = parsed.messages as Array<Record<string, unknown>> | undefined;
    if (messages && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === "assistant") {
        const content = lastMessage.content as string | Array<{ type: string; text?: string; thinking?: string }>;
        const { text, thinking } = extractTextContent(content);
        
        entries.push(...appendSnapshot("thinking", thinking, ts, state));
        entries.push(...appendSnapshot("assistant", text, ts, state));
        
        // Extract usage
        const usage = asRecord(lastMessage.usage);
        if (usage) {
          const inputTokens = (usage.inputTokens ?? usage.input ?? 0) as number;
          const outputTokens = (usage.outputTokens ?? usage.output ?? 0) as number;
          const cachedTokens = (usage.cacheRead ?? usage.cachedInputTokens ?? 0) as number;
          const costRecord = asRecord(usage.cost);
          const costUsd = (costRecord?.total ?? usage.costUsd ?? 0) as number;
          
          if (inputTokens > 0 || outputTokens > 0) {
            entries.push({
              kind: "result",
              ts,
              text: "Run completed",
              inputTokens,
              outputTokens,
              cachedTokens,
              costUsd,
              subtype: "end",
              isError: false,
              errors: [],
            });
          }
        }
      }
    }
    
    if (entries.length === 0) {
      entries.push({ kind: "system", ts, text: "✅ Pi agent finished" });
    }
    
    return entries;
  }

  // Turn lifecycle
  if (type === "turn_start") {
    state.thinkingText = "";
    state.assistantText = "";
    return []; // Skip noisy lifecycle events
  }

  if (type === "turn_end") {
    const message = asRecord(parsed.message);
    const toolResults = parsed.toolResults as Array<Record<string, unknown>> | undefined;
    
    const entries: TranscriptEntry[] = [];
    
    if (message) {
      const content = message.content as string | Array<{ type: string; text?: string; thinking?: string }>;
      const { text, thinking } = extractTextContent(content);
      
      entries.push(...appendSnapshot("thinking", thinking, ts, state));
      entries.push(...appendSnapshot("assistant", text, ts, state));
    }
    
    // Process tool results - match with pending tool calls
    if (toolResults) {
      for (const tr of toolResults) {
        const toolCallId = asString(tr.toolCallId, `tool-${Date.now()}`);
        const content = tr.content;
        const isError = tr.isError === true;
        
        // Extract text from Pi's content array format
        let contentStr: string;
        if (typeof content === "string") {
          contentStr = content;
        } else if (Array.isArray(content)) {
          const extracted = extractTextContent(content as Array<{ type: string; text?: string }>);
          contentStr = extracted.text || JSON.stringify(content);
        } else {
          contentStr = JSON.stringify(content);
        }
        
        // Get tool name from pending calls if available
        const pendingCall = state.pendingToolCalls.get(toolCallId);
        const toolName = asString(tr.toolName, pendingCall?.toolName || "tool");
        
        entries.push({
          kind: "tool_result",
          ts,
          toolUseId: toolCallId,
          toolName,
          content: contentStr,
          isError,
        });
        
        // Clean up pending call
        state.pendingToolCalls.delete(toolCallId);
      }
    }
    
    return entries;
  }

  // Message streaming
  if (type === "message_start") {
    return [];
  }

  if (type === "message_update") {
    const assistantEvent = asRecord(parsed.assistantMessageEvent);
    if (assistantEvent) {
      const msgType = asString(assistantEvent.type);
      
      // Handle thinking deltas
      if (msgType === "thinking_delta") {
        const delta = asString(assistantEvent.delta);
        return appendDelta("thinking", delta, ts, state);
      }
      
      // Handle text deltas
      if (msgType === "text_delta") {
        const delta = asString(assistantEvent.delta);
        return appendDelta("assistant", delta, ts, state);
      }
      
      // Handle thinking end - emit full thinking block
      if (msgType === "thinking_end") {
        const content = asString(assistantEvent.content);
        return appendSnapshot("thinking", content, ts, state);
      }
      
      // Handle text end - emit full text block
      if (msgType === "text_end") {
        const content = asString(assistantEvent.content);
        return appendSnapshot("assistant", content, ts, state);
      }
    }
    return [];
  }

  if (type === "message_end") {
    const message = asRecord(parsed.message);
    if (message) {
      const content = message.content as string | Array<{ type: string; text?: string; thinking?: string }>;
      const { text, thinking } = extractTextContent(content);
      
      const entries: TranscriptEntry[] = [];
      
      // Emit final thinking block if present
      entries.push(...appendSnapshot("thinking", thinking, ts, state));
      entries.push(...appendSnapshot("assistant", text, ts, state));
      
      return entries;
    }
    return [];
  }

  // Tool execution
  if (type === "tool_execution_start") {
    const toolCallId = asString(parsed.toolCallId, `tool-${Date.now()}`);
    const toolName = asString(parsed.toolName, "tool");
    const args = parsed.args;
    
    // Track this tool call for later matching
    state.pendingToolCalls.set(toolCallId, { toolName, args });
    
    return [{
      kind: "tool_call",
      ts,
      name: toolName,
      input: args,
      toolUseId: toolCallId,
    }];
  }

  if (type === "tool_execution_update") {
    return [];
  }

  if (type === "tool_execution_end") {
    const toolCallId = asString(parsed.toolCallId, `tool-${Date.now()}`);
    const toolName = asString(parsed.toolName, "tool");
    const result = parsed.result;
    const isError = parsed.isError === true;
    
    // Extract text from Pi's content array format
    let contentStr: string;
    if (typeof result === "string") {
      contentStr = result;
    } else if (Array.isArray(result)) {
      const extracted = extractTextContent(result as Array<{ type: string; text?: string }>);
      contentStr = extracted.text || JSON.stringify(result);
    } else if (result && typeof result === "object") {
      const resultObj = result as Record<string, unknown>;
      if (Array.isArray(resultObj.content)) {
        const extracted = extractTextContent(resultObj.content as Array<{ type: string; text?: string }>);
        contentStr = extracted.text || JSON.stringify(result);
      } else {
        contentStr = JSON.stringify(result);
      }
    } else {
      contentStr = String(result);
    }
    
    // Clean up pending call
    state.pendingToolCalls.delete(toolCallId);
    
    return [{
      kind: "tool_result",
      ts,
      toolUseId: toolCallId,
      toolName,
      content: contentStr,
      isError,
    }];
  }

  // Fallback for unknown event types
  return [{ kind: "stdout", ts, text: line }];
}

const defaultParserState = createParserState();

/** Stateful parser for callers that build a transcript from one run at a time. */
export function createPiStdoutParser() {
  const state = createParserState();
  return {
    parseLine: (line: string, ts: string) => parsePiStdoutLineWithState(line, ts, state),
    reset: () => resetParserStateForRun(state),
  };
}

/** Stateless-compatible module entry point retained for existing consumers. */
export function parsePiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parsePiStdoutLineWithState(line, ts, defaultParserState);
}
