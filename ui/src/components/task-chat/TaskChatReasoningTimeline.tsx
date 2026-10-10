import { useState, useEffect, useRef, type ReactNode } from "react";
import {
  ChevronDown,
  Clock,
  Monitor,
  Wrench,
  Search,
  Folder,
  StickyNote,
  CircleDot,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReasoningStep } from "@/lib/reasoning-parser";

export interface TaskChatReasoningTimelineProps {
  steps: ReasoningStep[];
  title?: string;
  stepCount?: number;
  defaultOpen?: boolean;
  delaySeconds?: number;
  isHistorical?: boolean;
  isStreaming?: boolean;
  children?: ReactNode;
  renderStepChild?: (index: number, step: ReasoningStep) => ReactNode;
  className?: string;
  testId?: string;
}

function getStepIcon(kind: ReasoningStep["kind"]) {
  switch (kind) {
    case "thought":
      return Clock;
    case "command":
      return Monitor;
    case "tool":
      return Wrench;
    case "search":
      return Search;
    case "file":
      return Folder;
    case "note":
      return StickyNote;
    default:
      return CircleDot;
  }
}

export function TaskChatReasoningTimeline({
  steps,
  title = "Pemikiran",
  stepCount,
  defaultOpen = false,
  delaySeconds = 15,
  isHistorical = false,
  isStreaming = false,
  children,
  renderStepChild,
  className,
  testId = "task-chat-turn-summary",
}: TaskChatReasoningTimelineProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [expandedStepIds, setExpandedStepIds] = useState<Record<string, boolean>>({});

  // Delay calculation: in test environment or historical settled turns, reveal immediately
  const isTest =
    typeof process !== "undefined" &&
    (process.env.NODE_ENV === "test" || process.env.VITEST === "true");
  const effectiveDelay = isTest || isHistorical ? 0 : Math.max(0, delaySeconds);

  const [countdown, setCountdown] = useState(effectiveDelay);
  const [isRevealed, setIsRevealed] = useState(effectiveDelay === 0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isRevealed || effectiveDelay === 0) {
      return;
    }

    setCountdown(effectiveDelay);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          setIsRevealed(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [effectiveDelay, isRevealed]);

  const handleRevealNow = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    setCountdown(0);
    setIsRevealed(true);
  };

  const toggleStepExpand = (id: string) => {
    setExpandedStepIds((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const count = stepCount ?? steps.length;
  const hasSteps = steps.length > 0;

  return (
    <div className={cn("w-full py-1", className)}>
      {/* Header row matching Gemini/Paperclip reference ("Pemikiran ∨" or "Pemikiran · X steps") */}
      {hasSteps && (
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors group cursor-pointer text-left"
          data-testid={testId}
        >
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 transition-transform group-hover:text-foreground",
              !open && "-rotate-90",
            )}
            aria-hidden="true"
          />
          <span className="font-medium text-foreground/90">{title}</span>
          {count > 0 && (
            <span className="text-muted-foreground">
              · {count} {count === 1 ? "step" : "steps"}
            </span>
          )}
        </button>
      )}

      {/* Connected Vertical Timeline */}
      {hasSteps && open && (
        <div
          className="relative min-w-0 py-2 pl-6"
          data-testid="task-chat-turn-timeline"
        >
          {/* Continuous vertical line linking steps */}
          {steps.length > 1 && (
            <div
              className="absolute left-2.5 top-3.5 bottom-3.5 w-px bg-border/60"
              aria-hidden="true"
            />
          )}

          <div className="flex flex-col gap-1">
            {steps.map((step, idx) => {
              const StepIcon = getStepIcon(step.kind);
              const isStepExpanded = Boolean(expandedStepIds[step.id]);
              const rawText = step.body || step.title;
              const isLongText = rawText.length > 160 || rawText.includes("\n");

              return (
                <div
                  key={step.id}
                  className="relative flex items-start gap-3 py-1.5 min-w-0"
                  data-testid="task-chat-turn-timeline-row"
                  data-timeline-row-id={step.id}
                  data-thread-anchor={step.id}
                >
                  {/* Step node icon centered over vertical line */}
                  <div className="absolute -left-6 top-1.5 z-10 flex size-5 items-center justify-center bg-background text-muted-foreground">
                    {step.status === "running" ? (
                      <Loader2 className="size-3.5 animate-spin text-primary" />
                    ) : (
                      <StepIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
                    )}
                  </div>

                  {/* Step content */}
                  <div className="min-w-0 flex-1 pt-0.5 text-xs text-muted-foreground leading-relaxed">
                    <div>
                      {step.kind === "thought" ? (
                        <div>
                          <div
                            className={cn(
                              "whitespace-pre-wrap text-foreground/90",
                              !isStepExpanded && isLongText && "line-clamp-3",
                            )}
                          >
                            {rawText}
                          </div>
                          {isLongText && (
                            <button
                              type="button"
                              onClick={() => toggleStepExpand(step.id)}
                              className="mt-1 block text-xs font-medium text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors cursor-pointer"
                            >
                              {isStepExpanded
                                ? "Tampilkan lebih sedikit"
                                : "Tampilkan semua"}
                            </button>
                          )}
                        </div>
                      ) : (
                        <div>
                          <span className="font-medium text-foreground/90">
                            {step.title}
                          </span>
                          {step.detail && step.detail !== step.title && (
                            <span className="ml-1.5 text-muted-foreground/80">
                              {step.detail}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    {renderStepChild ? (
                      <div className="sr-only" aria-hidden="true">
                        {renderStepChild(idx, step)}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Delay status banner: active while answer is being formulated (10-30s delay) */}
      {!isRevealed && effectiveDelay > 0 && (
        <div className="my-2.5 flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 px-3.5 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin text-primary" />
            <span>Merumuskan jawaban akhir... ({countdown} detik)</span>
          </div>
          <button
            type="button"
            onClick={handleRevealNow}
            className="text-xs font-medium text-primary hover:text-primary/80 hover:underline transition-colors cursor-pointer"
          >
            Tampilkan sekarang
          </button>
        </div>
      )}

      {/* Final Answer Display (reveals after delay countdown or immediately if historical) */}
      {isRevealed && children && (
        <div className="w-full transition-opacity duration-300 opacity-100 animate-in fade-in">
          {children}
        </div>
      )}
    </div>
  );
}
