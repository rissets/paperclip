import { describe, expect, it } from "vitest";
import { createPiStdoutParser } from "./parse-stdout.js";

const TS = "2026-10-07T10:00:00.000Z";
const thought = "Exact match not found. Trying fuzzy/substr search:";
const answer = "Company profile loaded.";

function line(parser: ReturnType<typeof createPiStdoutParser>, event: unknown) {
  return parser.parseLine(JSON.stringify(event), TS);
}

describe("Pi UI stdout parser", () => {
  it("does not repeat streamed reasoning from Pi lifecycle snapshots", () => {
    const parser = createPiStdoutParser();
    const transcript = [
      ...line(parser, { type: "agent_start" }),
      ...line(parser, { type: "turn_start" }),
      ...line(parser, { type: "message_start" }),
      ...line(parser, {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: thought },
      }),
      ...line(parser, {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end", content: thought },
      }),
      ...line(parser, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: thought }, { type: "text", text: answer }],
        },
      }),
      ...line(parser, {
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: thought }, { type: "text", text: answer }],
        },
      }),
      ...line(parser, {
        type: "agent_end",
        messages: [{
          role: "assistant",
          content: [{ type: "thinking", thinking: thought }, { type: "text", text: answer }],
        }],
      }),
    ];

    expect(transcript.filter((entry) => entry.kind === "thinking")).toHaveLength(1);
    expect(transcript.filter((entry) => entry.kind === "assistant")).toHaveLength(1);
  });

  it("keeps identical reasoning from a genuinely new Pi turn", () => {
    const parser = createPiStdoutParser();
    line(parser, { type: "turn_start" });
    const first = line(parser, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: thought },
    });

    line(parser, { type: "turn_start" });
    const second = line(parser, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: thought },
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it("deduplicates repeated final snapshots when no streaming deltas were recorded", () => {
    const parser = createPiStdoutParser();
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: thought }, { type: "text", text: answer }],
    };

    const ended = line(parser, { type: "message_end", message });
    const turnEnded = line(parser, { type: "turn_end", message });
    const agentEnded = line(parser, { type: "agent_end", messages: [message] });

    expect([...ended, ...turnEnded, ...agentEnded].filter((entry) => entry.kind === "thinking")).toHaveLength(1);
    expect([...ended, ...turnEnded, ...agentEnded].filter((entry) => entry.kind === "assistant")).toHaveLength(1);
  });
});
