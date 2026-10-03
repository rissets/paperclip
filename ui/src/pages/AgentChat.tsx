import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Check,
  ChevronDown,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Users,
  X,
} from "lucide-react";
import { agentChatsApi } from "@/api/agentChats";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCompany } from "@/context/CompanyContext";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { queryKeys } from "@/lib/queryKeys";
import { recordAgentChatVisit } from "@/lib/recent-agent-chats";
import { useNavigate, useParams, useSearchParams } from "@/lib/router";
import { deriveInitials } from "@/components/Identity";
import { agentRouteRef, cn } from "@/lib/utils";
import { TaskDetailSurface } from "./IssueDetail";
import { isUuidLike, type Agent, type Issue } from "@paperclipai/shared";

type EnrichedRecentChat = Issue & {
  latestSnippet?: string | null;
  lastActivityAt?: string | Date | null;
};

interface ChatGroup {
  label: string;
  chats: EnrichedRecentChat[];
}

function decodeHtmlEntities(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function formatChatTime(date: Date, now: Date = new Date()): string {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const time = date.getTime();

  if (time >= startOfToday) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } else if (time >= startOfYesterday) {
    return "Yesterday";
  } else if (now.getFullYear() === date.getFullYear()) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  } else {
    return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }
}

function groupChatsByDate(chats: EnrichedRecentChat[]): ChatGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfLast7Days = startOfToday - 6 * 24 * 60 * 60 * 1000;

  const today: EnrichedRecentChat[] = [];
  const yesterday: EnrichedRecentChat[] = [];
  const last7Days: EnrichedRecentChat[] = [];
  const older: EnrichedRecentChat[] = [];

  for (const chat of chats) {
    const timestamp = chat.lastActivityAt
      ? new Date(chat.lastActivityAt).getTime()
      : new Date(chat.createdAt).getTime();

    if (timestamp >= startOfToday) {
      today.push(chat);
    } else if (timestamp >= startOfYesterday) {
      yesterday.push(chat);
    } else if (timestamp >= startOfLast7Days) {
      last7Days.push(chat);
    } else {
      older.push(chat);
    }
  }

  const groups: ChatGroup[] = [];
  if (today.length > 0) groups.push({ label: "Today", chats: today });
  if (yesterday.length > 0) groups.push({ label: "Yesterday", chats: yesterday });
  if (last7Days.length > 0) groups.push({ label: "Previous 7 Days", chats: last7Days });
  if (older.length > 0) groups.push({ label: "Older", chats: older });

  return groups;
}

export function AgentChat() {
  const { agentRef = "" } = useParams<{ agentRef: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeChatIdFromUrl = searchParams.get("chatId");
  const { selectedCompanyId } = useCompany();
  const { enabled, loaded } = useAgentChatEnabled();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [searchQuery, setSearchQuery] = useState("");
  const [isCreatingChat, setIsCreatingChat] = useState(false);

  // Resizable & minimizable sidebar state
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem("paperclip:agent-chat-sidebar-width");
      if (saved) {
        const val = Number(saved);
        if (!isNaN(val) && val >= 200 && val <= 520) return val;
      }
    } catch {}
    return 280;
  });

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("paperclip:agent-chat-sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });

  const isResizingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(280);

  const handleSidebarResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      dragStartXRef.current = e.clientX;
      dragStartWidthRef.current = sidebarWidth;

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!isResizingRef.current) return;
        const dx = moveEvent.clientX - dragStartXRef.current;
        const newWidth = Math.min(Math.max(dragStartWidthRef.current + dx, 200), 520);
        setSidebarWidth(newWidth);
      };

      const onMouseUp = () => {
        if (!isResizingRef.current) return;
        isResizingRef.current = false;
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        setSidebarWidth((latest) => {
          try {
            localStorage.setItem("paperclip:agent-chat-sidebar-width", String(latest));
          } catch {}
          return latest;
        });
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [sidebarWidth],
  );

  const toggleSidebarCollapse = useCallback(() => {
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("paperclip:agent-chat-sidebar-collapsed", String(next));
      } catch {}
      return next;
    });
  }, []);

  // 1. Fetch Agents List
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const agents = agentsQuery.data ?? [];

  // 2. Fetch Session Info
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId =
    sessionQuery.data?.user?.id ?? sessionQuery.data?.session?.userId ?? null;

  // 3. Resolve Current Active Agent
  const rosterAgent = agents.find(
    (a) => a.id === agentRef || agentRouteRef(a) === agentRef,
  );
  const historyAgent = useQuery({
    queryKey: queryKeys.agents.detail(agentRef),
    queryFn: () => agentsApi.get(agentRef, selectedCompanyId!),
    enabled: enabled && !!selectedCompanyId && agentsQuery.isSuccess && !rosterAgent && isUuidLike(agentRef),
  });
  const currentAgent: Agent | null = rosterAgent ?? (historyAgent.data?.companyId === selectedCompanyId ? historyAgent.data : null);

  // 4. Fetch Recents / History list
  const recentsQueryKey = useMemo(
    () => queryKeys.agentChats.recents(selectedCompanyId, currentAgent?.id),
    [selectedCompanyId, currentAgent?.id],
  );

  const { data: rawRecents = [], isLoading: recentsLoading } = useQuery<EnrichedRecentChat[]>({
    queryKey: recentsQueryKey,
    queryFn: () =>
      currentAgent && selectedCompanyId
        ? (agentChatsApi.listRecents(selectedCompanyId, currentAgent.id) as Promise<EnrichedRecentChat[]>)
        : Promise.resolve([]),
    enabled: !!selectedCompanyId && !!currentAgent,
  });

  const recentChats = useMemo(() => {
    return Array.isArray(rawRecents) ? rawRecents : [];
  }, [rawRecents]);

  // Active chat ID resolution
  const activeChatId = useMemo(() => {
    if (activeChatIdFromUrl) return activeChatIdFromUrl;
    const matchingAgentChat = recentChats.find(
      (c) => c.conversationAgentId === currentAgent?.id,
    );
    return matchingAgentChat?.id ?? recentChats[0]?.id ?? null;
  }, [activeChatIdFromUrl, recentChats, currentAgent?.id]);

  // Record visit
  useEffect(() => {
    if (enabled && currentAgent && selectedCompanyId) {
      recordAgentChatVisit(selectedCompanyId, userId, currentAgent.id, activeChatId ?? null);
    }
  }, [enabled, currentAgent, selectedCompanyId, userId, activeChatId]);

  // 5. Fetch Active Chat Detail
  const activeChatQueryKey = useMemo(
    () => ["agent-chats", "detail", selectedCompanyId, currentAgent?.id, activeChatId],
    [selectedCompanyId, currentAgent?.id, activeChatId],
  );

  const { data: activeIssue, isLoading: activeIssueLoading } = useQuery({
    queryKey: activeChatQueryKey,
    queryFn: () =>
      currentAgent && selectedCompanyId
        ? agentChatsApi.get(selectedCompanyId, currentAgent.id, activeChatId)
        : Promise.resolve(null),
    enabled: !!selectedCompanyId && !!currentAgent,
  });

  // Ensure Issue handler
  const ensureIssue = useCallback(async () => {
    if (activeIssue) return activeIssue;
    if (!currentAgent || !selectedCompanyId) throw new Error("Agent not found");
    const fresh = await agentChatsApi.createFresh(selectedCompanyId, currentAgent.id);
    setSearchParams((params) => {
      params.set("chatId", fresh.id);
      return params;
    });
    void queryClient.invalidateQueries({ queryKey: recentsQueryKey });
    return fresh;
  }, [activeIssue, currentAgent, selectedCompanyId, setSearchParams, queryClient, recentsQueryKey]);

  // 6. Mutation: Start New Chat
  const handleNewChat = useCallback(async () => {
    if (!selectedCompanyId || !currentAgent || isCreatingChat) return;
    setIsCreatingChat(true);
    try {
      const fresh = await agentChatsApi.createFresh(selectedCompanyId, currentAgent.id);
      setSearchParams((params) => {
        params.set("chatId", fresh.id);
        return params;
      });
      queryClient.setQueryData(
        ["agent-chats", "detail", selectedCompanyId, currentAgent.id, fresh.id],
        fresh,
      );
      void queryClient.invalidateQueries({ queryKey: recentsQueryKey });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
    } catch (err) {
      console.error("Failed to create new chat:", err);
    } finally {
      setIsCreatingChat(false);
    }
  }, [selectedCompanyId, currentAgent, isCreatingChat, setSearchParams, queryClient, recentsQueryKey]);

  // Filtered recents by search query
  const filteredRecents = useMemo(() => {
    if (!searchQuery.trim()) return recentChats;
    const q = searchQuery.toLowerCase();
    return recentChats.filter(
      (c) =>
        c.title?.toLowerCase().includes(q) ||
        c.latestSnippet?.toLowerCase().includes(q) ||
        c.identifier?.toLowerCase().includes(q),
    );
  }, [recentChats, searchQuery]);

  // Grouped recents by date
  const groupedRecents = useMemo(() => {
    return groupChatsByDate(filteredRecents);
  }, [filteredRecents]);

  if (!loaded || agentsQuery.isPending || sessionQuery.isPending || (historyAgent.isFetching && !currentAgent)) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-xs text-muted-foreground animate-pulse">Loading conversation…</p>
      </div>
    );
  }

  if (agentsQuery.error || (!rosterAgent && historyAgent.error)) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-sm text-destructive">
          {(agentsQuery.error ?? historyAgent.error)?.message}
        </p>
      </div>
    );
  }

  if (!enabled && !activeIssue) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center max-w-md mx-auto">
        <p className="text-xs text-muted-foreground">
          Agent Chat is disabled. Enable it in Experimental settings. Existing
          history remains available through task links.
        </p>
      </div>
    );
  }

  if (!currentAgent) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-xs text-destructive">Agent not found.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      {/* ─────────────────────────────────────────────────────────────
          LEFT SIDEBAR: Chat History & New Chat
      ───────────────────────────────────────────────────────────── */}
      <aside
        style={{ width: isSidebarCollapsed ? 0 : `${sidebarWidth}px` }}
        className={cn(
          "shrink-0 border-r border-border bg-card/40 flex flex-col h-full select-none relative transition-[width] duration-150 ease-out",
          isSidebarCollapsed && "overflow-hidden border-r-0 opacity-0 pointer-events-none",
        )}
      >
        {/* Resize Handle on Right Border */}
        {!isSidebarCollapsed && (
          <div
            onMouseDown={handleSidebarResizeStart}
            className="absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/30 transition-colors z-20"
            title="Drag to resize sidebar"
          />
        )}

        {/* Top Header: Current Agent & Switcher & Collapse */}
        <div className="flex items-center justify-between border-b border-border p-3 shrink-0 gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 hover:bg-accent/50 p-1.5 -m-1.5 rounded-md transition-colors text-left min-w-0 flex-1"
              >
                <div className="relative shrink-0">
                  <Avatar className="size-6 border border-border">
                    <AvatarFallback className="bg-primary/10 text-primary font-semibold text-xs">
                      {deriveInitials(currentAgent.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-emerald-500 ring-1 ring-background" />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="truncate font-semibold text-xs text-foreground block">
                    {currentAgent.name}
                  </span>
                  <span className="truncate text-xs text-muted-foreground block">
                    {currentAgent.role ?? "agent"}
                  </span>
                </div>
                <ChevronDown className="size-3 text-muted-foreground shrink-0 ml-1" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Switch Agent</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <div className="max-h-60 overflow-y-auto">
                {agents.map((a) => (
                  <DropdownMenuItem
                    key={a.id}
                    onClick={() => navigate(`/chats/${encodeURIComponent(agentRouteRef(a))}`)}
                    className="flex items-center gap-2.5 py-2 text-xs cursor-pointer"
                  >
                    <Avatar className="size-6 border border-border shrink-0">
                      <AvatarFallback className="bg-primary/10 text-primary font-medium text-xs">
                        {deriveInitials(a.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-foreground truncate">{a.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{a.role ?? a.title ?? "Agent"}</div>
                    </div>
                    {a.id === currentAgent.id && <Check className="size-3.5 text-primary shrink-0" />}
                  </DropdownMenuItem>
                ))}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => navigate("/agents/all")}
                className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer"
              >
                <Users className="size-3.5" />
                <span>Browse all agents</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex items-center gap-1 shrink-0">
            {/* New Chat Button */}
            <Button
              variant="outline"
              size="icon-xs"
              onClick={handleNewChat}
              disabled={isCreatingChat}
              title="New Chat"
              className="shrink-0"
            >
              <Plus className="size-3.5" />
            </Button>

            {/* Minimize / Collapse Sidebar Button */}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={toggleSidebarCollapse}
              title="Minimize sidebar"
              aria-label="Minimize sidebar"
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <PanelLeftClose className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* Search Filter */}
        <div className="px-3 pt-2.5 pb-1 shrink-0">
          <div className="relative flex items-center">
            <Search className="absolute left-2.5 size-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search chats…"
              className="w-full rounded-md border border-input bg-background/50 pl-8 pr-7 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-ring"
            />
            {searchQuery && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setSearchQuery("")}
                className="absolute right-1 size-5 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </Button>
            )}
          </div>
        </div>

        {/* Scrollable Conversation List */}
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-2">
          {recentsLoading && recentChats.length === 0 ? (
            <div className="p-4 text-center">
              <p className="text-xs text-muted-foreground animate-pulse">Loading history…</p>
            </div>
          ) : filteredRecents.length === 0 ? (
            <div className="p-6 text-center flex flex-col items-center gap-2">
              <p className="text-xs text-muted-foreground">
                {searchQuery ? "No conversations found" : "No chats yet"}
              </p>
              {!searchQuery && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleNewChat}
                  disabled={isCreatingChat}
                  className="h-7 text-xs gap-1.5 mt-1"
                >
                  <Plus className="size-3.5" />
                  Start new chat
                </Button>
              )}
            </div>
          ) : (
            groupedRecents.map((group) => (
              <div key={group.label} className="space-y-0.5">
                <div className="px-2 pt-2 pb-0.5 text-(length:--text-micro) font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {group.label}
                </div>
                {group.chats.map((chat) => {
                  const isActive = chat.id === activeChatId;
                  const snippet = chat.latestSnippet ?? "No messages yet";
                  const timeDate = chat.lastActivityAt ? new Date(chat.lastActivityAt) : new Date(chat.createdAt);
                  const dateLabel = formatChatTime(timeDate);
                  const displayTitle = decodeHtmlEntities(chat.title);
                  const displaySnippet = decodeHtmlEntities(snippet);

                  return (
                    <button
                      key={chat.id}
                      type="button"
                      onClick={() => {
                        setSearchParams((params) => {
                          params.set("chatId", chat.id);
                          return params;
                        });
                      }}
                      className={cn(
                        "group flex w-full items-start gap-2.5 rounded-lg p-2 text-left transition-colors text-xs",
                        isActive
                          ? "bg-accent text-accent-foreground font-medium shadow-xs"
                          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                      )}
                    >
                      <MessageSquare
                        className={cn(
                          "size-3.5 shrink-0 mt-0.5",
                          isActive
                            ? "text-primary"
                            : "text-muted-foreground/60 group-hover:text-muted-foreground",
                        )}
                      />

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1 mb-0.5">
                          <span
                            className={cn(
                              "truncate font-medium",
                              isActive ? "text-foreground font-semibold" : "text-foreground/90",
                            )}
                          >
                            {displayTitle}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground/70">
                            {dateLabel}
                          </span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground/80">
                          <span>{displaySnippet}</span>
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ─────────────────────────────────────────────────────────────
          RIGHT MAIN PANEL: Native Task Surface (with Worked, seconds, tools used!)
      ───────────────────────────────────────────────────────────── */}
      <main className="flex flex-1 flex-col h-full min-w-0 bg-background overflow-hidden relative">
        {/* Restore / Expand Sidebar Button when collapsed */}
        {isSidebarCollapsed && (
          <div className="absolute top-2.5 left-3 z-30">
            <Button
              variant="outline"
              size="icon-xs"
              onClick={toggleSidebarCollapse}
              title="Expand sidebar"
              aria-label="Expand sidebar"
              className="size-7 rounded-md bg-card/90 shadow-sm backdrop-blur-sm border border-border hover:bg-accent"
            >
              <PanelLeftOpen className="size-3.5 text-muted-foreground hover:text-foreground" />
            </Button>
          </div>
        )}
        {activeIssueLoading && !activeIssue ? (
          <div className="flex h-full items-center justify-center p-8">
            <p className="text-xs text-muted-foreground animate-pulse">Loading conversation…</p>
          </div>
        ) : (
          <TaskDetailSurface
            key={activeIssue?.id ?? `${currentAgent.id}:${userId}`}
            conversation={{
              agent: currentAgent,
              issue: activeIssue ?? null,
              ensureIssue,
            }}
          />
        )}
      </main>
    </div>
  );
}
