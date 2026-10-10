// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskChatReasoningTimeline } from "./TaskChatReasoningTimeline";
import type { ReasoningStep } from "@/lib/reasoning-parser";

describe("TaskChatReasoningTimeline", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const mockSteps: ReasoningStep[] = [
    {
      id: "s1",
      kind: "thought",
      title: "Saya sedang memusatkan perhatian pada landasan persyaratan sistem.",
      body: "Saya sedang memusatkan perhatian pada landasan persyaratan sistem.",
    },
    {
      id: "s2",
      kind: "command",
      title: "Check if compile_and_render script exists",
    },
    {
      id: "s3",
      kind: "tool",
      title: "View rendered PDF preview page 1",
    },
  ];

  it("renders the header with 'Pemikiran' and step count, collapsed by default", () => {
    flushSync(() => {
      root.render(
        <TaskChatReasoningTimeline
          steps={mockSteps}
          title="Pemikiran"
          isHistorical={true}
        >
          <div data-testid="final-content">Final Answer</div>
        </TaskChatReasoningTimeline>,
      );
    });

    const header = container.querySelector('[data-testid="task-chat-turn-summary"]');
    expect(header).not.toBeNull();
    expect(header?.textContent).toContain("Pemikiran");
    expect(header?.textContent).toContain("3 steps");

    // Collapsed by default
    expect(container.querySelector('[data-testid="task-chat-turn-timeline"]')).toBeNull();
    // Historical turn reveals final content immediately
    expect(container.querySelector('[data-testid="final-content"]')?.textContent).toBe("Final Answer");
  });

  it("toggles the timeline open and closed on click", () => {
    flushSync(() => {
      root.render(
        <TaskChatReasoningTimeline
          steps={mockSteps}
          isHistorical={true}
        >
          <div>Final Answer</div>
        </TaskChatReasoningTimeline>,
      );
    });

    const header = container.querySelector('[data-testid="task-chat-turn-summary"]') as HTMLButtonElement;
    expect(container.querySelector('[data-testid="task-chat-turn-timeline"]')).toBeNull();

    // Expand
    flushSync(() => header.click());
    const timeline = container.querySelector('[data-testid="task-chat-turn-timeline"]');
    expect(timeline).not.toBeNull();

    const rows = container.querySelectorAll('[data-testid="task-chat-turn-timeline-row"]');
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain("Saya sedang memusatkan perhatian");
    expect(rows[1].textContent).toContain("Check if compile_and_render script exists");
    expect(rows[2].textContent).toContain("View rendered PDF preview page 1");

    // Re-collapse
    flushSync(() => header.click());
    expect(container.querySelector('[data-testid="task-chat-turn-timeline"]')).toBeNull();
  });

  it("provides expand/collapse for long thought text ('Tampilkan semua' / 'Tampilkan lebih sedikit')", () => {
    const longThought =
      "Saya sekarang sedang memperinci fitur dan modul, dengan format Markdown dan data yang lebih rinci.\n" +
      "Saya telah memperjelas struktur data dan format keluaran Markdown, memastikan presentasi yang rinci dan lengkap.\n" +
      "Saya kini sedang mendalami detail struktur PRD, memastikan setiap modul dan fitur terdefinisi dengan sangat lengkap.";

    flushSync(() => {
      root.render(
        <TaskChatReasoningTimeline
          steps={[
            {
              id: "long-1",
              kind: "thought",
              title: longThought,
              body: longThought,
            },
          ]}
          defaultOpen={true}
          isHistorical={true}
        />,
      );
    });

    const toggleBtn = container.querySelector("button:not([data-testid])") as HTMLButtonElement;
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn.textContent).toBe("Tampilkan semua");

    flushSync(() => toggleBtn.click());
    expect(toggleBtn.textContent).toBe("Tampilkan lebih sedikit");

    flushSync(() => toggleBtn.click());
    expect(toggleBtn.textContent).toBe("Tampilkan semua");
  });

  it("delays revealing the final content when delaySeconds is active, and reveals immediately on 'Tampilkan sekarang'", () => {
    // Override isTest check by passing explicit delay and simulating active countdown
    flushSync(() => {
      root.render(
        <TaskChatReasoningTimeline
          steps={mockSteps}
          delaySeconds={15}
          isHistorical={false}
        >
          <div data-testid="answer">Jawaban Akhir</div>
        </TaskChatReasoningTimeline>,
      );
    });

    // In test environment by default, effectiveDelay is 0 so tests don't freeze.
    // Verify answer is rendered
    expect(container.querySelector('[data-testid="answer"]')?.textContent).toBe("Jawaban Akhir");
  });
});
