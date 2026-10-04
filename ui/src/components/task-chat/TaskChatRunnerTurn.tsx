import { useRef, useState, useMemo } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import type { ExecutionProjection } from "@paperclipai/shared";
import { useSecondTick } from "@/hooks/useSecondTick";
import { useGeneralSettings } from "@/hooks/useGeneralSettings";
import { cn } from "@/lib/utils";
import type {
  TaskChatItem,
  TaskChatMessageItem,
  TaskChatRuntimeRequestDecision,
  TaskChatRuntimeRequestItem,
} from "./task-chat-model";
import { TaskChatAgentIdentity, TaskChatBubble } from "./TaskChatBubble";
import { TaskChatBubbleActions } from "./TaskChatBubbleActions";
import { formatTaskChatTimestamp } from "./task-chat-adapter";
import { TaskChatRunnerActivityGroup } from "./TaskChatRunnerActivityGroup";
import { TaskChatProtocolCard } from "./TaskChatProtocolCard";
import { TaskChatPlanPreviewCard } from "./TaskChatPlanPreviewCard";
import {
  buildTurnTimelineRows,
  isTerminalRunStatus,
  omitProgressRepeatedByResponse,
  paperclipRunnerFinalResponse,
  paperclipRunnerTimelineItems,
} from "./transcript-adapter";

function getActiveActivityLabel(items: readonly TaskChatItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "tool") {
      return item.name ? `${item.name}…` : "Running tool…";
    }
    if (item.kind === "thinking") {
      return "Thinking…";
    }
    if (item.kind === "activity_phase") {
      return item.summary ? `${item.summary}…` : "Working…";
    }
  }
  return "Working…";
}

function currentActivityStatusItems(
  items: readonly TaskChatItem[],
): readonly TaskChatItem[] {
  let boundaryIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item.kind === "message" ||
      item.kind === "plan_document" ||
      (item.kind === "protocol" &&
        (item.surface === "runtime_request" ||
          item.surface === "run_result" ||
          item.surface === "run_terminal"))
    ) {
      boundaryIndex = index;
      break;
    }
  }
  return items.slice(boundaryIndex + 1);
}

function formatCompactDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function terminalStatusFailed(status: string): boolean {
  return (
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out" ||
    status === "interrupted"
  );
}

function RunnerTurnStatus({
  status,
  startedAtMs,
  finishedAtMs,
  continuedAfterSteering = false,
}: {
  status: string;
  startedAtMs: number | null;
  finishedAtMs?: number | null;
  continuedAfterSteering?: boolean;
}) {
  const terminal = isTerminalRunStatus(status);
  useSecondTick(!terminal && startedAtMs != null);
  const elapsedMs =
    startedAtMs == null
      ? null
      : Math.max(
          0,
          (terminal ? (finishedAtMs ?? Date.now()) : Date.now()) - startedAtMs,
        );
  const elapsed = formatCompactDuration(elapsedMs);

  const failed = terminalStatusFailed(status);
  const label = terminal ? (failed ? "Stopped" : "Worked") : "Working";
  const semanticLabel = terminal
    ? elapsed
      ? `${label} ${failed ? "after" : "for"} ${elapsed}`
      : label
    : `${label} for ${elapsed ?? "0s"}`;
  const visibleLabel = continuedAfterSteering
    ? `Continued after steering · ${semanticLabel}`
    : semanticLabel;

  return (
    <span
      className="min-w-0 truncate text-sm font-normal text-muted-foreground"
      data-testid="task-chat-turn-status-header"
      data-turn-position="identity"
      aria-live="polite"
      aria-atomic="true"
    >
      {visibleLabel}
    </span>
  );
}

function RunnerCurrentActivityTail({ status }: { status: string }) {
  if (isTerminalRunStatus(status)) return null;
  return <div className="mt-2 flex min-h-8 min-w-0 items-center gap-2 px-1 py-1 text-xs text-muted-foreground" data-testid="task-chat-current-activity" data-turn-position="tail">
    <span className="shimmer-text shimmer-text-muted" aria-live="polite" data-testid="task-chat-current-activity-label">Thinking</span>
  </div>;
}

export function TaskChatRunnerTurn({
  runId,
  agentName,
  agentIcon,
  agent,
  items,
  status,
  startedAtMs,
  finishedAtMs,
  activityUnavailable = false,
  suppressFinal = false,
  continuedAfterSteering = false,
  conversationMode = false,
  onRuntimeRequestDecision,
  showWorkingActivityAndReasoning: showWorkingActivityProp,
}: {
  /** Stable identity used to clear replay-latched final text for the next turn. */
  runId?: string | null;
  agentName?: string | null;
  agentIcon?: string | null;
  agent?: import("../AgentAvatar").AvatarAgent;
  items: readonly TaskChatItem[];
  status: string;
  execution?: ExecutionProjection | null;
  startedAtMs: number | null;
  finishedAtMs?: number | null;
  activityUnavailable?: boolean;
  /** Accepted wait/interaction authority overrides an early provider final. */
  suppressFinal?: boolean;
  /** The visible tail resumes the same native run after an accepted steer. */
  continuedAfterSteering?: boolean;
  conversationMode?: boolean;
  onRuntimeRequestDecision?: (
    item: TaskChatRuntimeRequestItem,
    decision: TaskChatRuntimeRequestDecision,
  ) => void | Promise<void>;
  showWorkingActivityAndReasoning?: boolean;
}) {
  const { showWorkingActivityAndReasoning: defaultShow } = useGeneralSettings();
  const showWorkingActivityAndReasoning = showWorkingActivityProp ?? defaultShow;
  const terminal = isTerminalRunStatus(status);
  const [workerExpanded, setWorkerExpanded] = useState(false);
  const yielded = items.some(
    (item) =>
      item.kind === "protocol" &&
      item.surface === "run_result" &&
      item.disposition === "yielded",
  );
  const observedFinal = suppressFinal
    ? undefined
    : paperclipRunnerFinalResponse(items, {
        allowFallback: terminal,
      });
  const observedProviderText = Boolean(
    observedFinal &&
    items.some(
      (item) =>
        item.kind === "message" &&
        item.id === observedFinal.id &&
        item.channel !== "progress",
    ),
  );
  // A reconnect/replay can briefly rebuild the transcript without the final
  // item (or with an earlier, shorter prefix). Provider-authored final text
  // always replaces a structured summary fallback, even when it is shorter;
  // within either class, displayed answer text remains monotonic.
  const finalRef = useRef<{
    runId?: string | null;
    item?: TaskChatMessageItem;
    providerText?: boolean;
  }>({ runId });
  if (finalRef.current.runId !== runId) finalRef.current = { runId };
  // A provider final can arrive before the accepted yielded result. Clear any
  // replay latch once the control plane establishes that this turn is waiting
  // for continuation rather than presenting a durable assistant reply.
  if (yielded || suppressFinal) finalRef.current = { runId };
  if (
    observedFinal &&
    (!finalRef.current.item ||
      (observedProviderText && !finalRef.current.providerText) ||
      (observedProviderText === Boolean(finalRef.current.providerText) &&
        observedFinal.text.length >= finalRef.current.item.text.length))
  ) {
    finalRef.current.item = observedFinal;
    finalRef.current.providerText = observedProviderText;
  }
  const final = finalRef.current.item;
  const timelineItems = paperclipRunnerTimelineItems(items);
  const currentActivityItems = currentActivityStatusItems(timelineItems);
  const timelineRows = buildTurnTimelineRows(
    omitProgressRepeatedByResponse(timelineItems, final?.text),
    !terminal,
  );

  const stepCount = useMemo(() => {
    let count = 0;
    for (const row of timelineRows) {
      if (row.kind === "activity_phase") {
        count += Math.max(1, row.items.length);
      } else {
        count += 1;
      }
    }
    return Math.max(1, count || items.length || 1);
  }, [timelineRows, items]);

  return (
    <div
      className="flex min-w-0 flex-col"
      data-testid="task-chat-runner-turn"
      data-phase={status === "queued" ? "startup" : undefined}
    >
      {conversationMode ? (
        <>
          {!showWorkingActivityAndReasoning ? (
            <>
              {timelineRows.some((r) => r.kind === "protocol" || r.kind === "plan_document") ? (
                <div className="flex min-w-0 flex-col gap-2 py-1">
                  {timelineRows
                    .filter((r) => r.kind === "protocol" || r.kind === "plan_document")
                    .map((row) => (
                      <div key={`${runId ?? "run"}:${row.id}`}>
                        {row.kind === "plan_document" ? (
                          <TaskChatPlanPreviewCard source={{ kind: "saved", document: row.document }} />
                        ) : (
                          <TaskChatProtocolCard item={row} onRuntimeRequestDecision={onRuntimeRequestDecision} />
                        )}
                      </div>
                    ))}
                </div>
              ) : null}
              {!terminal && !final ? (
                <div className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground" data-testid="task-chat-simple-loading">
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                  <span className="shimmer-text shimmer-text-muted">{getActiveActivityLabel(items)}</span>
                </div>
              ) : null}
            </>
          ) : timelineRows.length > 0 ? (
            <div className="py-1">
              <button
                type="button"
                onClick={() => setWorkerExpanded(!workerExpanded)}
                className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors group cursor-pointer"
                aria-expanded={workerExpanded}
                data-testid="task-chat-worker-toggle"
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 shrink-0 transition-transform group-hover:text-foreground",
                    workerExpanded && "rotate-90",
                  )}
                  aria-hidden="true"
                />
                <span>
                  {stepCount} {stepCount === 1 ? "step" : "steps"}
                </span>
                {!terminal && !final ? (
                  <span className="shimmer-text shimmer-text-muted ml-1">· Working…</span>
                ) : null}
              </button>
              {workerExpanded ? (
                <div
                  className="flex min-w-0 flex-col gap-2 py-1 pl-4 border-l border-border/50"
                  data-testid="task-chat-turn-timeline"
                >
                  {timelineRows.map((row) => (
                    <div
                      className="min-w-0"
                      key={`${runId ?? "run"}:${row.id}`}
                      data-testid="task-chat-turn-timeline-row"
                      data-timeline-row-id={row.id}
                      data-thread-anchor={row.id}
                    >
                      {row.kind === "activity_phase" ? (
                        <TaskChatRunnerActivityGroup item={row} conversationMode={conversationMode} />
                      ) : row.kind === "plan_document" ? (
                        <TaskChatPlanPreviewCard
                          source={{ kind: "saved", document: row.document }}
                          testId={
                            row.placement === "fallback"
                              ? "task-chat-plan-preview-fallback"
                              : "task-chat-plan-preview"
                          }
                        />
                      ) : row.kind === "protocol" ? (
                        <TaskChatProtocolCard
                          item={row}
                          onRuntimeRequestDecision={onRuntimeRequestDecision}
                        />
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : !final ? (
            <div className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
              <span className="size-2 animate-pulse rounded-full bg-(--status-agent-running)" />
              <span className="shimmer-text shimmer-text-muted">Working…</span>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div
            className={cn(
              "flex min-h-8 min-w-0 items-center gap-2",
              status === "queued" ? "pb-1" : "pb-1 pt-2",
            )}
            data-testid="task-chat-runner-identity-row"
          >
            {agentName ? (
              <TaskChatAgentIdentity agentName={agentName} agentIcon={agentIcon} agent={agent} />
            ) : null}
            <RunnerTurnStatus
              status={status}
              startedAtMs={startedAtMs}
              finishedAtMs={finishedAtMs}
              continuedAfterSteering={continuedAfterSteering}
            />
          </div>
          {activityUnavailable ? (
            <div
              className="px-1 py-1 text-xs text-muted-foreground"
              role="status"
              data-testid="task-chat-activity-unavailable"
            >
              Live runner activity is temporarily unavailable. Retrying…
            </div>
          ) : null}
          {!showWorkingActivityAndReasoning ? (
            <>
              {timelineRows.some((r) => r.kind === "protocol" || r.kind === "plan_document") ? (
                <div className="flex min-w-0 flex-col gap-2 py-1" data-testid="task-chat-turn-timeline">
                  {timelineRows
                    .filter((r) => r.kind === "protocol" || r.kind === "plan_document")
                    .map((row) => (
                      <div key={`${runId ?? "run"}:${row.id}`}>
                        {row.kind === "plan_document" ? (
                          <TaskChatPlanPreviewCard source={{ kind: "saved", document: row.document }} />
                        ) : (
                          <TaskChatProtocolCard item={row} onRuntimeRequestDecision={onRuntimeRequestDecision} />
                        )}
                      </div>
                    ))}
                </div>
              ) : null}
              {!terminal && !final ? (
                <div className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground" data-testid="task-chat-simple-loading">
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                  <span className="shimmer-text shimmer-text-muted">{getActiveActivityLabel(items)}</span>
                </div>
              ) : null}
            </>
          ) : timelineRows.length > 0 ? (
            <div
              className="flex min-w-0 flex-col gap-2 py-1"
              data-testid="task-chat-turn-timeline"
            >
              {timelineRows.map((row) => (
                <div
                  className="min-w-0"
                  key={`${runId ?? "run"}:${row.id}`}
                  data-testid="task-chat-turn-timeline-row"
                  data-timeline-row-id={row.id}
                  data-thread-anchor={row.id}
                >
                  {row.kind === "activity_phase" ? (
                    <TaskChatRunnerActivityGroup item={row} />
                  ) : row.kind === "plan_document" ? (
                    <TaskChatPlanPreviewCard
                      source={{ kind: "saved", document: row.document }}
                      testId={
                        row.placement === "fallback"
                          ? "task-chat-plan-preview-fallback"
                          : "task-chat-plan-preview"
                      }
                    />
                  ) : row.kind === "protocol" ? (
                    <TaskChatProtocolCard
                      item={row}
                      onRuntimeRequestDecision={onRuntimeRequestDecision}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
      {final ? (
        <div
          className="w-full"
          data-testid="task-chat-final-response"
        >
          <TaskChatBubble
            item={{ ...final, authorName: agentName ?? undefined, agentIcon, agent, timestamp: final.timestamp ?? formatTaskChatTimestamp(final.atMs) }}
            animateEntry={false}
            hideAgentIdentity={conversationMode ? false : !continuedAfterSteering}
            actions={<TaskChatBubbleActions copyText={final.text} />}
          />
        </div>
      ) : terminal && terminalStatusFailed(status) ? (
        <div className="w-full px-1 py-2 text-xs text-destructive" data-testid="task-chat-run-error">
          Run stopped with {status === "cancelled" ? "cancellation" : status === "timed_out" ? "timeout" : "an error"}
        </div>
      ) : null}
      {!conversationMode && showWorkingActivityAndReasoning && !final && currentActivityItems.length === 0 ? (
        <RunnerCurrentActivityTail status={status} />
      ) : null}
    </div>
  );
}
