import { useState, useRef, useEffect, useMemo, type FormEvent, type KeyboardEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare,
  Plus,
  ChevronDown,
  Maximize2,
  Minus,
  X,
  ArrowUp,
  Sparkles,
  Check,
  RotateCcw,
} from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { agentsApi } from "@/api/agents";
import { agentChatsApi } from "@/api/agentChats";
import { issuesApi } from "@/api/issues";
import { heartbeatsApi } from "@/api/heartbeats";
import { queryKeys } from "@/lib/queryKeys";
import { AgentIcon } from "@/components/AgentIconPicker";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { cn, agentRouteRef } from "@/lib/utils";
import { useNavigate, useLocation } from "@/lib/router";
import type { Agent, Issue, IssueComment } from "@paperclipai/shared";

interface QuickChatFloatingWidgetProps {
  className?: string;
}

export function QuickChatFloatingWidget({ className }: QuickChatFloatingWidgetProps) {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  const isChatDetailPage = Boolean(location.pathname.match(/\/chats(\/|$)/));

  const [isOpen, setIsOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activeIssueId, setActiveIssueId] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 1. Fetch available agents in the company
  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && isOpen,
  });

  // Pick default agent: prefer knowledge-agent, otherwise first agent
  const activeAgent: Agent | null = useMemo(() => {
    if (!agents.length) return null;
    if (selectedAgentId) {
      const found = agents.find((a) => a.id === selectedAgentId);
      if (found) return found;
    }
    const knowledge = agents.find(
      (a) => a.name.toLowerCase().includes("knowledge") || a.role === "researcher",
    );
    return knowledge ?? agents[0] ?? null;
  }, [agents, selectedAgentId]);

  // 2. Fetch or ensure active conversation for this agent
  const conversationQueryKey = useMemo(
    () => ["quick-chat", "conversation", selectedCompanyId, activeAgent?.id, activeIssueId],
    [selectedCompanyId, activeAgent?.id, activeIssueId],
  );

  const { data: activeIssue, isLoading: isIssueLoading } = useQuery({
    queryKey: conversationQueryKey,
    queryFn: () => agentChatsApi.get(selectedCompanyId!, activeAgent!.id, activeIssueId),
    enabled: !!selectedCompanyId && !!activeAgent && isOpen,
  });

  // 3. Fetch recent conversations for dropdown
  const recentsQueryKey = useMemo(
    () => ["quick-chat", "recents", selectedCompanyId, activeAgent?.id],
    [selectedCompanyId, activeAgent?.id],
  );

  const { data: recentChats = [] } = useQuery({
    queryKey: recentsQueryKey,
    queryFn: () => agentChatsApi.listRecents(selectedCompanyId!, activeAgent!.id),
    enabled: !!selectedCompanyId && !!activeAgent && isOpen,
  });

  // 4. Fetch comments of the active conversation issue (isolated key to avoid InfiniteData cache collision)
  const commentsQueryKey = useMemo(
    () => (activeIssue?.id ? ["quick-chat", "comments", activeIssue.id] : null),
    [activeIssue?.id],
  );

  const { data: rawComments = [], isLoading: isCommentsLoading } = useQuery({
    queryKey: commentsQueryKey ?? ["dummy-comments"],
    queryFn: () => (activeIssue?.id ? issuesApi.listComments(activeIssue.id, { order: "asc" }) : Promise.resolve([])),
    enabled: !!activeIssue?.id && isOpen,
    refetchInterval: isOpen ? 2500 : false,
  });

  // 5. Active run check (to show thinking animation)
  const { data: activeRun } = useQuery({
    queryKey: activeIssue?.id ? queryKeys.issues.activeRun(activeIssue.id) : ["dummy-run"],
    queryFn: () => heartbeatsApi.activeRunForIssue(activeIssue!.id),
    enabled: !!activeIssue?.id && isOpen,
    refetchInterval: isOpen ? 2000 : false,
  });

  const isAgentThinking = activeRun?.status === "running";

  // Chronologically sort comments and filter by boundary for current fresh session
  const sortedComments = useMemo(() => {
    let commentsList: IssueComment[] = [];
    if (Array.isArray(rawComments)) {
      commentsList = rawComments;
    } else if (
      rawComments &&
      typeof rawComments === "object" &&
      "pages" in rawComments &&
      Array.isArray((rawComments as { pages: unknown[] }).pages)
    ) {
      commentsList = (rawComments as { pages: IssueComment[][] }).pages.flat();
    }
    const valid = commentsList.filter((c) => !c.deletedAt && c.body?.trim() !== "/new");
    if (!activeIssue?.conversationBoundaryCommentId) {
      return valid.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }
    const boundaryComment = commentsList.find((c) => c.id === activeIssue.conversationBoundaryCommentId);
    if (!boundaryComment) {
      return valid.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }
    const boundaryTime = new Date(boundaryComment.createdAt).getTime();
    return valid
      .filter((c) => new Date(c.createdAt).getTime() > boundaryTime)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [rawComments, activeIssue?.conversationBoundaryCommentId]);

  // Dynamic Resizable state
  const [size, setSize] = useState(() => {
    try {
      const saved = localStorage.getItem("paperclip:quick-chat-size");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.width === "number" && typeof parsed.height === "number") {
          return {
            width: Math.min(Math.max(parsed.width, 360), window.innerWidth - 32),
            height: Math.min(Math.max(parsed.height, 460), window.innerHeight - 32),
          };
        }
      }
    } catch {}
    return { width: 440, height: 640 };
  });

  const resizingRef = useRef<null | "left" | "top" | "top-left">(null);
  const dragStartRef = useRef({ x: 0, y: 0, width: 440, height: 640 });

  const handleResizeStart = (direction: "left" | "top" | "top-left", e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = direction;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      width: size.width,
      height: size.height,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!resizingRef.current) return;
      const dx = dragStartRef.current.x - moveEvent.clientX;
      const dy = dragStartRef.current.y - moveEvent.clientY;
      const dir = resizingRef.current;

      setSize((prev) => {
        let newWidth = prev.width;
        let newHeight = prev.height;

        if (dir === "left" || dir === "top-left") {
          newWidth = Math.min(Math.max(dragStartRef.current.width + dx, 360), window.innerWidth - 32);
        }
        if (dir === "top" || dir === "top-left") {
          newHeight = Math.min(Math.max(dragStartRef.current.height + dy, 460), window.innerHeight - 32);
        }

        return { width: newWidth, height: newHeight };
      });
    };

    const handleMouseUp = () => {
      resizingRef.current = null;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      setSize((current) => {
        try {
          localStorage.setItem("paperclip:quick-chat-size", JSON.stringify(current));
        } catch {}
        return current;
      });
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  // Auto scroll to bottom
  useEffect(() => {
    if (isOpen && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [sortedComments.length, isAgentThinking, isOpen]);

  // Mutation: Send comment
  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      if (!selectedCompanyId || !activeAgent) return;
      let targetIssue = activeIssue;
      if (!targetIssue) {
        targetIssue = await agentChatsApi.ensure(selectedCompanyId, activeAgent.id);
        setActiveIssueId(targetIssue.id);
        queryClient.setQueryData(
          ["quick-chat", "conversation", selectedCompanyId, activeAgent.id, targetIssue.id],
          targetIssue,
        );
        queryClient.setQueryData(
          ["quick-chat", "conversation", selectedCompanyId, activeAgent.id, null],
          targetIssue,
        );
      }
      const comment = await issuesApi.addComment(
        targetIssue.id,
        text,
        false,
        false,
        undefined,
        crypto.randomUUID(),
      );
      return { comment, issueId: targetIssue.id };
    },
    onSuccess: (result) => {
      setInputText("");
      const issueId = result?.issueId ?? activeIssue?.id;
      if (issueId) {
        queryClient.invalidateQueries({ queryKey: ["quick-chat", "comments", issueId] });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.commentsList(issueId) });
        queryClient.invalidateQueries({ queryKey: recentsQueryKey });
        queryClient.invalidateQueries({ queryKey: conversationQueryKey });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      }
    },
  });

  // Action: New Chat (fresh clean session)
  const handleNewChat = async () => {
    if (!selectedCompanyId || !activeAgent) return;
    try {
      const fresh = await agentChatsApi.createFresh(selectedCompanyId, activeAgent.id);
      setActiveIssueId(fresh.id);
      queryClient.setQueryData(
        ["quick-chat", "conversation", selectedCompanyId, activeAgent.id, fresh.id],
        fresh,
      );
      queryClient.setQueryData(
        ["quick-chat", "conversation", selectedCompanyId, activeAgent.id, null],
        fresh,
      );
      queryClient.setQueryData(["quick-chat", "comments", fresh.id], []);
      queryClient.invalidateQueries({ queryKey: recentsQueryKey });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    } catch {
      setActiveIssueId(null);
    }
  };

  const handleSelectRecent = (issue: Issue) => {
    if (issue.conversationAgentId && issue.conversationAgentId !== activeAgent?.id) {
      setSelectedAgentId(issue.conversationAgentId);
    }
    setActiveIssueId(issue.id);
    const agentId = issue.conversationAgentId ?? activeAgent?.id;
    queryClient.setQueryData(
      ["quick-chat", "conversation", selectedCompanyId, agentId, issue.id],
      issue,
    );
    queryClient.invalidateQueries({ queryKey: ["quick-chat", "comments", issue.id] });
  };

  const handleSelectAgent = (agent: Agent) => {
    setSelectedAgentId(agent.id);
    setActiveIssueId(null); // switch to default/latest of that agent
  };

  const handleSendMessage = (e?: FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = inputText.trim();
    if (!trimmed || sendMutation.isPending) return;
    sendMutation.mutate(trimmed);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Starter prompts based on active agent
  const starterPrompts = useMemo(() => {
    if (!activeAgent) return [];
    const nameLower = activeAgent.name.toLowerCase();
    if (nameLower.includes("knowledge") || activeAgent.role === "researcher") {
      return [
        "Apa saja komponen pendidikan yang didukung dashboard FK MILMED?",
        "Riset dan ringkas panduan dashboard mahasiswa",
        "Jelaskan SOP ujian CBT dan integritas akademik",
      ];
    }
    if (nameLower.includes("data")) {
      return [
        "Bagaimana sebaran badan hukum di database?",
        "Tampilkan distribusi perseroan berdasarkan jenis",
        "Apa saja tabel data yang tersedia?",
      ];
    }
    return [
      "Susun hari saya dan agenda prioritas",
      "Riset dan ringkas informasi terkini",
      "Bantu bereskan tugas dan rencanakan langkah",
    ];
  }, [activeAgent]);

  // Don't render widget if no company selected or if viewing chat detail page
  if (isChatDetailPage || !selectedCompanyId) return null;

  return (
    <div className={cn("fixed bottom-6 right-6 z-50 flex flex-col items-end", className)}>
      {/* Floating Chat Window (Dialog) */}
      {isOpen && (
        <div
          role="dialog"
          aria-label="Quick Chat"
          className="relative mb-4 flex flex-col rounded-2xl border border-border bg-card shadow-2xl overflow-hidden transition-all duration-75"
          style={{
            width: `${size.width}px`,
            height: `${size.height}px`,
            maxWidth: "calc(100vw - 32px)",
            maxHeight: "calc(100vh - 32px)",
          }}
        >
          {/* Drag Resize Handles */}
          <div
            onMouseDown={(e) => handleResizeStart("top", e)}
            className="absolute top-0 left-4 right-4 h-2 cursor-ns-resize z-30 hover:bg-primary/20 transition-colors"
            title="Drag to resize height"
          />
          <div
            onMouseDown={(e) => handleResizeStart("left", e)}
            className="absolute top-4 left-0 bottom-4 w-2 cursor-ew-resize z-30 hover:bg-primary/20 transition-colors"
            title="Drag to resize width"
          />
          <div
            onMouseDown={(e) => handleResizeStart("top-left", e)}
            className="absolute top-0 left-0 size-4 cursor-nwse-resize z-40 hover:bg-primary/30 rounded-tl-2xl transition-colors"
            title="Drag to resize"
          />

          {/* Header */}
          <div className="flex items-center justify-between border-b border-border bg-card/90 px-4 py-3 backdrop-blur-sm select-none">
            {/* Left: New Chat & Recents Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-foreground hover:bg-muted transition-colors max-w-56"
                >
                  <Plus className="size-4 text-muted-foreground shrink-0" />
                  <span className="truncate">
                    {activeIssue?.title && activeIssue.title !== `Chat with ${activeAgent?.name}`
                      ? activeIssue.title
                      : "New chat"}
                  </span>
                  <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuItem onClick={handleNewChat} className="flex items-center gap-2 font-medium">
                  <RotateCcw className="size-4 text-primary" />
                  <span>Start fresh conversation</span>
                </DropdownMenuItem>
                {recentChats.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Recent conversations ({recentChats.length})
                    </DropdownMenuLabel>
                    <div className="max-h-48 overflow-y-auto">
                      {recentChats.map((chat) => {
                        const isSelected = activeIssue?.id === chat.id;
                        return (
                          <DropdownMenuItem
                            key={chat.id}
                            onClick={() => handleSelectRecent(chat)}
                            className="flex items-center justify-between text-xs py-1.5"
                          >
                            <span className="truncate max-w-44">
                              {chat.title || `Chat (${chat.identifier || "untitled"})`}
                            </span>
                            {isSelected && <Check className="size-3.5 text-primary shrink-0" />}
                          </DropdownMenuItem>
                        );
                      })}
                    </div>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Right: Window Controls */}
            <div className="flex items-center gap-1 text-muted-foreground">
              {activeAgent && (
                <button
                  type="button"
                  title="Open full page chat"
                  aria-label="Expand to full chat"
                  onClick={() => {
                    navigate(`/chats/${encodeURIComponent(agentRouteRef(activeAgent))}`);
                    setIsOpen(false);
                  }}
                  className="rounded-md p-1.5 hover:bg-muted hover:text-foreground transition-colors"
                >
                  <Maximize2 className="size-4" />
                </button>
              )}
              <button
                type="button"
                title="Minimize chat"
                aria-label="Minimize chat"
                onClick={() => setIsOpen(false)}
                className="rounded-md p-1.5 hover:bg-muted hover:text-foreground transition-colors"
              >
                <Minus className="size-4" />
              </button>
              <button
                type="button"
                title="Close chat"
                aria-label="Close chat"
                onClick={() => setIsOpen(false)}
                className="rounded-md p-1.5 hover:bg-muted hover:text-foreground transition-colors"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          {/* Main Body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {(isIssueLoading || (activeIssue?.id && isCommentsLoading)) && sortedComments.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center h-full px-2 py-6">
                <div className="size-7 rounded-full border-2 border-primary border-t-transparent animate-spin mb-3" />
                <p className="text-xs text-muted-foreground">Loading chat history…</p>
              </div>
            ) : sortedComments.length === 0 ? (
              // Empty State / Welcome Screen
              <div className="flex flex-col items-center justify-center text-center h-full px-2 py-6">
                <div className="mb-3 flex size-14 items-center justify-center rounded-full bg-accent/60 border border-border text-foreground shadow-sm">
                  {activeAgent?.avatarUrl ? (
                    <img
                      src={activeAgent.avatarUrl}
                      alt={activeAgent.name}
                      className="size-10 rounded-full object-cover"
                    />
                  ) : (
                    <AgentIcon icon={activeAgent?.icon ?? "bot"} className="size-7" />
                  )}
                </div>

                <h3 className="text-base font-semibold text-foreground">
                  Chat with {activeAgent?.name ?? "Agent"}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground max-w-xs leading-relaxed">
                  {activeAgent?.title || activeAgent?.capabilities || "Asisten serbaguna untuk riset, dokumen, dan tanya jawab."}
                </p>

                {/* Starter Suggestions Pills */}
                <div className="mt-6 flex flex-col gap-2 w-full max-w-sm">
                  {starterPrompts.map((prompt, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        setInputText(prompt);
                        if (textareaRef.current) {
                          textareaRef.current.focus();
                        }
                      }}
                      className="rounded-xl border border-border bg-card p-2.5 text-left text-xs font-medium text-foreground hover:bg-accent/50 hover:border-primary/50 transition-all flex items-center justify-between group"
                    >
                      <span className="line-clamp-2 leading-relaxed">{prompt}</span>
                      <Sparkles className="size-3.5 text-muted-foreground group-hover:text-primary shrink-0 ml-2" />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              // Message Thread
              <div className="space-y-3.5">
                {sortedComments.map((comment: IssueComment) => {
                  const isUser = Boolean(comment.authorUserId) || comment.authorType === "user";
                  return (
                    <div
                      key={comment.id}
                      className={cn("flex flex-col", isUser ? "items-end" : "items-start")}
                    >
                      <div
                        className={cn(
                          "rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed max-w-xs sm:max-w-sm",
                          isUser
                            ? "bg-primary text-primary-foreground rounded-tr-xs"
                            : "bg-muted/80 text-foreground rounded-tl-xs border border-border/50",
                        )}
                      >
                        {isUser ? (
                          <p className="whitespace-pre-wrap">{comment.body}</p>
                        ) : (
                          <div className="prose-xs">
                            <MarkdownBody>{comment.body}</MarkdownBody>
                          </div>
                        )}
                      </div>
                      <span className="mt-1 text-xs text-muted-foreground px-1">
                        {new Date(comment.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                  );
                })}

                {/* Thinking / Running Indicator */}
                {isAgentThinking && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                    <div className="size-2 rounded-full bg-primary animate-ping" />
                    <span>{activeAgent?.name ?? "Agent"} is reasoning & retrieving...</span>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Footer Composer */}
          <div className="border-t border-border bg-card p-3">
            <form onSubmit={handleSendMessage} className="rounded-xl border border-border bg-background p-2 focus-within:border-primary/60 transition-colors">
              <textarea
                ref={textareaRef}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${activeAgent?.name ?? "Agent"}...`}
                rows={2}
                className="w-full resize-none bg-transparent px-1.5 text-xs text-foreground placeholder:text-muted-foreground outline-none"
              />
              <div className="mt-1.5 flex items-center justify-between pt-1">
                {/* Agent Switcher Dropdown */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-1.5 rounded-lg bg-muted/60 px-2 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors"
                    >
                      {activeAgent?.avatarUrl ? (
                        <img
                          src={activeAgent.avatarUrl}
                          alt={activeAgent.name}
                          className="size-4 rounded-full object-cover"
                        />
                      ) : (
                        <AgentIcon icon={activeAgent?.icon ?? "bot"} className="size-3.5" />
                      )}
                      <span className="truncate max-w-28">{activeAgent?.name ?? "Select agent"}</span>
                      <ChevronDown className="size-3 text-muted-foreground" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Switch Agent
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {agents.map((agent) => (
                      <DropdownMenuItem
                        key={agent.id}
                        onClick={() => handleSelectAgent(agent)}
                        className="flex items-center justify-between text-xs py-1.5"
                      >
                        <div className="flex items-center gap-2 truncate">
                          <AgentIcon icon={agent.icon} className="size-3.5 text-muted-foreground shrink-0" />
                          <span className="truncate">{agent.name}</span>
                        </div>
                        {activeAgent?.id === agent.id && <Check className="size-3.5 text-primary shrink-0" />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Send Button */}
                <Button
                  type="submit"
                  size="icon-xs"
                  disabled={!inputText.trim() || sendMutation.isPending}
                  aria-label="Send message"
                  className="rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                >
                  <ArrowUp className="size-3.5" />
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Floating Action Button (FAB Bubble) - Image 2 */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label={isOpen ? "Close quick chat" : "Open quick chat"}
        title={isOpen ? "Close chat" : "Quick chat with agent"}
        className="flex size-14 items-center justify-center rounded-full bg-card text-foreground border border-border shadow-2xl transition-all duration-200 hover:scale-105 hover:border-primary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {isOpen ? (
          <X className="size-6 text-foreground" />
        ) : (
          <MessageSquare className="size-6 text-foreground" />
        )}
      </button>
    </div>
  );
}
