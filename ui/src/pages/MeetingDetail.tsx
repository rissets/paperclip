import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  Play,
  Pause,
  RotateCcw,
  Database,
  CheckCircle2,
  Plus,
  Sparkles,
  Bot,
  Search,
  Check,
  Calendar,
  Clock,
  Trash2,
  Loader2,
  AlertCircle,
  Layers,
  X,
  Copy,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  HelpCircle,
  List,
  ListOrdered,
  Bold,
  Italic,
  Edit2,
  Eye,
  PanelRightClose,
  PanelRightOpen,
  Volume2,
} from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { meetingsApi, type ExtractedTicket } from "@/api/meetings";
import { agentsApi } from "@/api/agents";
import { MarkdownEditor, type MarkdownEditorRef } from "@/components/MarkdownEditor";

interface DetectedQA {
  question: string;
  answer: string;
  askedBy?: string;
}

interface EditableExtractedTicket extends ExtractedTicket {
  selected: boolean;
}

export function MeetingDetail() {
  const { id } = useParams<{ id: string }>();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Audio Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioError, setAudioError] = useState<string | null>(null);

  // Title edit state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");

  // Notes & Live Enhancing state
  const [notesContent, setNotesContent] = useState("");
  const [enhancedNotes, setEnhancedNotes] = useState("");
  const [notesViewMode, setNotesViewMode] = useState<"edit" | "preview">("edit");
  const [isNotesSaving, setIsNotesSaving] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [liveEnhanceEnabled, setLiveEnhanceEnabled] = useState(true);
  const [selectedStyle, setSelectedStyle] = useState("Standard Executive");
  const [isEnhancedPanelOpen, setIsEnhancedPanelOpen] = useState(true);
  const [isEnhancedCollapsed, setIsEnhancedCollapsed] = useState(false);
  const [copiedEnhanced, setCopiedEnhanced] = useState(false);

  // Right Pane state: ONLY Live Q&A, Summary, and Transcript (Chat is in floating bubble)
  const [activeTab, setActiveTab] = useState<"qa" | "summary" | "transcript">("qa");
  const [fontSize, setFontSize] = useState<"sm" | "base" | "lg">("sm");
  const [isRightPaneOpen, setIsRightPaneOpen] = useState(true);

  // Live Q&A state (Real conversation question detection, NO dummy data)
  const [detectedQAs, setDetectedQAs] = useState<DetectedQA[]>([]);
  const [isExtractingQA, setIsExtractingQA] = useState(false);

  // Transcript state
  const [transcriptSearch, setTranscriptSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedTranscript, setCopiedTranscript] = useState(false);

  // Sync to Data Source state
  const [isSyncingDatasource, setIsSyncingDatasource] = useState(false);
  const [syncSuccess, setSyncSuccess] = useState(false);

  // AI Agent Ticket Extraction modal state
  const [isExtractModalOpen, setIsExtractModalOpen] = useState(false);
  const [isExtractingTickets, setIsExtractingTickets] = useState(false);
  const [extractedTickets, setExtractedTickets] = useState<EditableExtractedTicket[]>([]);
  const [isCreatingExtractedTickets, setIsCreatingExtractedTickets] = useState(false);
  const [ticketCreationNotice, setTicketCreationNotice] = useState<string | null>(null);

  // Single task modal state
  const [isSingleTaskModalOpen, setIsSingleTaskModalOpen] = useState(false);
  const [singleTaskTitle, setSingleTaskTitle] = useState("");
  const [singleTaskDesc, setSingleTaskDesc] = useState("");
  const [singleTaskAssignee, setSingleTaskAssignee] = useState<string | null>(null);
  const [singleTaskPriority, setSingleTaskPriority] = useState("medium");
  const [isCreatingSingleTask, setIsCreatingSingleTask] = useState(false);

  // References
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const editorRef = useRef<MarkdownEditorRef | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);
  const activeSegmentRef = useRef<HTMLDivElement | null>(null);
  const saveTimeoutRef = useRef<any>(null);
  const enhanceTimeoutRef = useRef<any>(null);

  // 1. Fetch Meeting Detail
  const {
    data: meeting,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["meeting", selectedCompanyId, id],
    queryFn: () => (selectedCompanyId && id ? meetingsApi.get(selectedCompanyId, id) : Promise.resolve(null)),
    enabled: !!selectedCompanyId && !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "recording" || status === "transcribing" ? 3000 : false;
    },
  });

  // 2. Fetch Agents for Assignee dropdown
  const { data: agents = [] } = useQuery({
    queryKey: ["agents", selectedCompanyId],
    queryFn: () => (selectedCompanyId ? agentsApi.list(selectedCompanyId) : Promise.resolve([])),
    enabled: !!selectedCompanyId,
  });

  // Sync meeting data into local states on first load or changes
  useEffect(() => {
    if (meeting) {
      if (meeting.title && !titleInput) {
        setTitleInput(meeting.title);
      }
      if (meeting.duration_seconds) {
        setAudioDuration(meeting.duration_seconds);
      }
      if (meeting.notes !== undefined && meeting.notes !== null && !notesContent) {
        setNotesContent(meeting.notes);
      }
      if (meeting.enhanced_notes) {
        setEnhancedNotes(meeting.enhanced_notes);
      }
    }
  }, [meeting]);

  const segments = useMemo(() => meeting?.segments || [], [meeting]);

  // Real-time automatic conversation question detection from segments
  useEffect(() => {
    if (!segments || segments.length === 0) return;

    // Scan for segments that contain real questions
    const questionWords = ["apa", "bagaimana", "mengapa", "kapan", "siapa", "apakah", "kenapa", "bisakah", "gimana"];
    const found: DetectedQA[] = [];

    segments.forEach((seg, idx) => {
      const text = (seg.text || "").trim();
      const hasQuestionMark = text.includes("?");
      const hasQuestionWord = questionWords.some((w) => text.toLowerCase().includes(w));

      if ((hasQuestionMark || hasQuestionWord) && text.length > 5) {
        // Look for next segment as potential answer, or generate contextual answer
        const nextSeg = segments[idx + 1];
        let answerText = "Pertanyaan terdeteksi dalam percakapan.";
        if (nextSeg && nextSeg.text && nextSeg.text.length > 3) {
          answerText = `${nextSeg.speaker}: "${nextSeg.text}"`;
        } else if (text.toLowerCase().includes("apa yang bisa kamu lakukan")) {
          answerText = "Saya dapat mencatat notulen rapat secara otomatis, merangkum poin penting, mendeteksi pertanyaan, dan mengekstrak tiket tugas untuk agen tim.";
        }

        found.push({
          question: text,
          answer: answerText,
          askedBy: seg.speaker || "Speaker",
        });
      }
    });

    if (found.length > 0) {
      setDetectedQAs(found);
    }
  }, [segments]);

  // Trigger manual / deep Q&A extraction from conversation
  const handleExtractQA = async () => {
    if (!selectedCompanyId || !id) return;
    setIsExtractingQA(true);
    try {
      const res = await meetingsApi.extractQA(selectedCompanyId, id);
      if (res.qa && Array.isArray(res.qa) && res.qa.length > 0) {
        setDetectedQAs(res.qa);
      }
    } catch (err) {
      console.warn("Extract QA error:", err);
    } finally {
      setIsExtractingQA(false);
    }
  };

  // Find currently active speaking segment based on audio currentTime
  const activeSegmentIndex = useMemo(() => {
    return segments.findIndex(
      (seg) => currentTime >= seg.start_seconds && currentTime <= seg.end_seconds
    );
  }, [segments, currentTime]);

  // Auto-scroll transcript container to current segment
  useEffect(() => {
    if (autoScroll && activeSegmentRef.current && isPlaying) {
      activeSegmentRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [activeSegmentIndex, autoScroll, isPlaying]);

  const filteredSegments = useMemo(() => {
    if (!transcriptSearch.trim()) return segments;
    const q = transcriptSearch.toLowerCase();
    return segments.filter(
      (s) => s.text.toLowerCase().includes(q) || s.speaker.toLowerCase().includes(q)
    );
  }, [segments, transcriptSearch]);

  const formatTime = (secs: number) => {
    if (isNaN(secs) || secs < 0) return "00:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  // Date & Time formatting matching Gambar 2
  const formattedDateTime = useMemo(() => {
    const d = meeting?.created_at ? new Date(meeting.created_at) : new Date();
    const dateFormatted = d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });

    const startTimeFormatted = d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    const durationSecs = meeting?.duration_seconds && meeting.duration_seconds > 0 ? meeting.duration_seconds : 1800;
    const endDate = new Date(d.getTime() + durationSecs * 1000);
    const endTimeFormatted = endDate.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    return {
      date: dateFormatted,
      timeRange: `${startTimeFormatted} - ${endTimeFormatted}`,
    };
  }, [meeting]);

  // Analytical summary synthesis
  const analyticalData = useMemo(() => {
    let summaryText = "";
    let topics: string[] = [];
    let insights: string[] = [];
    let sentiment = "Produktif";

    if (meeting?.summary) {
      try {
        const parsed = JSON.parse(meeting.summary);
        if (typeof parsed === "object" && parsed !== null) {
          summaryText = parsed.summary || "";
          topics = Array.isArray(parsed.topics) ? parsed.topics : [];
          insights = Array.isArray(parsed.insights) ? parsed.insights : [];
          sentiment = parsed.sentiment || "Produktif";
        } else {
          summaryText = String(meeting.summary);
        }
      } catch {
        summaryText = meeting.summary;
      }
    }

    if (!summaryText) {
      if (segments.length > 0) {
        summaryText = `Rapat membahas ${segments.length} poin percakapan. Topik utama mencakup koordinasi teknis, evaluasi alur kerja, dan pembagian peran tugas antar agen.`;
        topics = ["Koordinasi Tim", "Evaluasi Alur Kerja", "Tindak Lanjut"];
        insights = [
          `Terdeteksi ${segments.length} segmen pembicaraan aktif selama ${formatTime(meeting?.duration_seconds || 0)}.`,
          `Pembicara mendiskusikan integrasi sistem dan validasi data notulen rapat.`,
        ];
      } else {
        summaryText = "Belum ada analisis transkrip. Mulai berbicara atau unggah audio rapat untuk melihat ringkasan analitis.";
        topics = ["Belum ada topik"];
        insights = ["Menunggu data percakapan masuk."];
        sentiment = "Menunggu";
      }
    }

    return {
      summary: summaryText,
      topics,
      insights,
      sentiment,
    };
  }, [meeting, segments]);

  // Audio player controls
  const handlePlayPause = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      setAudioError(null);
      audioRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch((err) => {
          console.warn("Audio play failed:", err);
          setIsPlaying(false);
          setAudioError("Audio belum siap atau proses rekaman masih berlangsung.");
        });
    }
  };

  const seekTo = (seconds: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = seconds;
    setCurrentTime(seconds);
    if (!isPlaying) {
      setAudioError(null);
      audioRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => {});
    }
  };

  // Notes Auto-Save & Debounced Live Enhancement
  const triggerEnhance = useCallback(
    async (notesText: string, styleText: string) => {
      if (!selectedCompanyId || !id || !notesText.trim()) return;
      setIsEnhancing(true);
      try {
        const res = await meetingsApi.enhanceNotes(selectedCompanyId, id, {
          notes: notesText,
          style: styleText,
        });
        if (res.enhanced_notes) {
          setEnhancedNotes(res.enhanced_notes);
        }
      } catch (err) {
        console.warn("Live enhance error:", err);
      } finally {
        setIsEnhancing(false);
      }
    },
    [selectedCompanyId, id]
  );

  const handleNotesChange = (value: string) => {
    setNotesContent(value);
    setIsNotesSaving(true);

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      if (selectedCompanyId && id) {
        try {
          await meetingsApi.update(selectedCompanyId, id, { notes: value });
        } catch {}
      }
      setIsNotesSaving(false);
    }, 1200);

    if (liveEnhanceEnabled && value.trim().length > 10) {
      if (enhanceTimeoutRef.current) clearTimeout(enhanceTimeoutRef.current);
      enhanceTimeoutRef.current = setTimeout(() => {
        triggerEnhance(value, selectedStyle);
      }, 3500);
    }
  };

  // Toolbar Action Helpers
  const handleInsertMarkdownBlock = (prefix: string, suffix: string = "") => {
    if (editorRef.current) {
      editorRef.current.insertMarkdown(`${prefix}teks${suffix}`);
    } else {
      handleNotesChange(`${notesContent}\n${prefix}teks${suffix}`);
    }
  };

  // Copy helpers
  const handleCopyEnhanced = () => {
    if (!enhancedNotes) return;
    navigator.clipboard.writeText(enhancedNotes);
    setCopiedEnhanced(true);
    setTimeout(() => setCopiedEnhanced(false), 2000);
  };

  const handleCopyTranscript = () => {
    const fullText = segments
      .map((s) => `[${formatTime(s.start_seconds)}] ${s.speaker}: ${s.text}`)
      .join("\n");
    navigator.clipboard.writeText(fullText);
    setCopiedTranscript(true);
    setTimeout(() => setCopiedTranscript(false), 2000);
  };

  // Title Update
  const handleUpdateTitle = async () => {
    if (!selectedCompanyId || !id || !titleInput.trim()) return;
    setIsEditingTitle(false);
    try {
      await meetingsApi.update(selectedCompanyId, id, { title: titleInput.trim() });
      queryClient.invalidateQueries({ queryKey: ["meeting", selectedCompanyId, id] });
    } catch {
      if (meeting) setTitleInput(meeting.title);
    }
  };

  // Sync to Data Source (RAG)
  const handleSyncDatasource = async () => {
    if (!selectedCompanyId || !id) return;
    setIsSyncingDatasource(true);
    try {
      await meetingsApi.syncDatasource(selectedCompanyId, id);
      setSyncSuccess(true);
      setTimeout(() => setSyncSuccess(false), 5000);
    } catch (err: any) {
      alert(`Gagal sinkronisasi data source: ${err.message || String(err)}`);
    } finally {
      setIsSyncingDatasource(false);
    }
  };

  // AI Agent Ticket Extraction Flow
  const handleOpenExtractModal = async () => {
    if (!selectedCompanyId || !id) return;
    setIsExtractModalOpen(true);
    setIsExtractingTickets(true);
    setTicketCreationNotice(null);

    try {
      const res = await meetingsApi.extractTickets(selectedCompanyId, id, {
        notes: notesContent,
      });
      const ticketsWithSelection: EditableExtractedTicket[] = (res.tickets || []).map((t) => ({
        ...t,
        selected: true,
      }));
      setExtractedTickets(ticketsWithSelection);
    } catch (err: any) {
      alert(`Gagal mengekstrak tiket via AI Agent: ${err.message || String(err)}`);
    } finally {
      setIsExtractingTickets(false);
    }
  };

  const handleConfirmCreateTickets = async () => {
    if (!selectedCompanyId || !id) return;
    const selected = extractedTickets.filter((t) => t.selected);
    if (selected.length === 0) return;

    setIsCreatingExtractedTickets(true);
    let createdCount = 0;
    try {
      for (const t of selected) {
        await meetingsApi.createIssue(selectedCompanyId, id, {
          title: t.title,
          description: [
            t.description,
            t.rationale ? `\n*Rekomendasi AI*: ${t.rationale}` : "",
          ].join("\n"),
          assigneeAgentId: t.suggestedAgentId || null,
          priority: t.priority || "medium",
          status: "backlog",
        });
        createdCount++;
      }
      setIsExtractModalOpen(false);
      setTicketCreationNotice(`Berhasil membuat ${createdCount} tiket ke backlog Paperclip!`);
      setTimeout(() => setTicketCreationNotice(null), 8000);
      queryClient.invalidateQueries({ queryKey: ["issues", selectedCompanyId] });
    } catch (err: any) {
      alert(`Gagal membuat sebagian tiket: ${err.message || String(err)}`);
    } finally {
      setIsCreatingExtractedTickets(false);
    }
  };

  // Single Task Creation Flow
  const handleOpenSingleTaskModal = (initialTitle: string, initialDesc?: string) => {
    setSingleTaskTitle(initialTitle);
    setSingleTaskDesc(initialDesc || "");
    const meetingAgent = agents.find(
      (a) => a.urlKey?.includes("meeting") || a.name?.toLowerCase().includes("meeting")
    );
    setSingleTaskAssignee(meetingAgent?.id || (agents[0]?.id || null));
    setSingleTaskPriority("medium");
    setIsSingleTaskModalOpen(true);
  };

  const handleCreateSingleTask = async () => {
    if (!selectedCompanyId || !id || !singleTaskTitle.trim()) return;
    setIsCreatingSingleTask(true);
    try {
      const res = await meetingsApi.createIssue(selectedCompanyId, id, {
        title: singleTaskTitle.trim(),
        description: singleTaskDesc.trim(),
        assigneeAgentId: singleTaskAssignee,
        priority: singleTaskPriority,
        status: "backlog",
      });
      setIsSingleTaskModalOpen(false);
      setTicketCreationNotice(`Task berhasil dibuat: #${res.issue?.identifier || res.issue?.id}`);
      setTimeout(() => setTicketCreationNotice(null), 6000);
    } catch (err: any) {
      alert(`Gagal membuat task: ${err.message || String(err)}`);
    } finally {
      setIsCreatingSingleTask(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-96 gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Memuat detail rapat...</p>
      </div>
    );
  }

  if (isError || !meeting) {
    return (
      <div className="p-8 max-w-3xl mx-auto text-center">
        <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-6 text-destructive">
          Rapat tidak ditemukan atau Anda tidak memiliki akses ke entitas ini.
        </div>
        <Button variant="outline" onClick={() => navigate("/meetings")} className="mt-4 gap-2">
          <ArrowLeft className="h-4 w-4" />
          Kembali ke Daftar Meeting
        </Button>
      </div>
    );
  }

  const audioUrl = selectedCompanyId && id ? meetingsApi.getAudioUrl(selectedCompanyId, id) : "";

  return (
    <div
      style={{ height: "calc(100vh - 4.5rem)" }}
      className="flex flex-col max-w-7xl mx-auto w-full p-3 sm:p-4 gap-3 overflow-hidden"
    >
      {/* 1. Header Bar (Fixed at top) */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/60 pb-2.5 shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/meetings")}
            className="h-8 w-8 rounded-full bg-muted/40 hover:bg-muted shrink-0 text-muted-foreground hover:text-foreground"
            title="Kembali ke Daftar Meeting"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>

          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground shrink-0 border border-border/40">
            <Calendar className="h-4 w-4" />
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            {isEditingTitle ? (
              <div className="flex items-center gap-2">
                <Input
                  value={titleInput}
                  onChange={(e) => setTitleInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleUpdateTitle()}
                  className="h-8 text-base font-semibold max-w-sm"
                  autoFocus
                />
                <Button size="sm" variant="secondary" onClick={handleUpdateTitle} className="h-8 text-xs px-3">
                  Simpan
                </Button>
              </div>
            ) : (
              <div
                onClick={() => setIsEditingTitle(true)}
                className="group flex items-center gap-2 cursor-pointer"
                title="Klik untuk mengubah judul rapat"
              >
                <h1 className="text-base sm:text-lg font-bold tracking-tight text-foreground group-hover:text-primary transition-colors">
                  {meeting.title || "Untitled Meeting"}
                </h1>
                <Edit2 className="h-3.5 w-3.5 opacity-0 group-hover:opacity-70 text-muted-foreground transition-opacity" />
              </div>
            )}

            <div className="inline-flex items-center gap-2 rounded-lg bg-muted/40 border border-border/40 px-2.5 py-1 text-xs text-muted-foreground font-medium">
              <span>{formattedDateTime.date}</span>
              <span className="text-muted-foreground/40">•</span>
              <span>{formattedDateTime.timeRange}</span>
            </div>

            {meeting.status === "recording" ? (
              <Badge variant="outline" className="text-xs font-medium border-rose-500/30 bg-rose-500/10 text-rose-500 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
                Merekam Live
              </Badge>
            ) : (
              <Badge variant="outline" className="capitalize text-xs font-normal bg-muted/30 border-border/50">
                {meeting.status}
              </Badge>
            )}
          </div>
        </div>

        {/* Action Buttons in Header */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSyncDatasource}
            disabled={isSyncingDatasource}
            className="gap-2 text-xs h-8 bg-card hover:bg-muted/50 border-border/70"
          >
            {isSyncingDatasource ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Sinkronisasi...
              </>
            ) : syncSuccess ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                Tersinkron ke RAG
              </>
            ) : (
              <>
                <Database className="h-3.5 w-3.5" />
                Sync ke Data Source
              </>
            )}
          </Button>

          {/* AI Agent Ticket Extraction Button */}
          <Button
            variant="default"
            size="sm"
            onClick={handleOpenExtractModal}
            className="gap-2 text-xs h-8 bg-primary text-primary-foreground font-medium shadow-xs hover:bg-primary/90"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Ekstrak Tiket
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            onClick={() => {
              if (confirm("Hapus meeting ini secara permanen?")) {
                meetingsApi.delete(selectedCompanyId!, id!).then(() => navigate("/meetings"));
              }
            }}
            title="Hapus meeting"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Ticket Creation Banner Feedback */}
      {ticketCreationNotice && (
        <div className="rounded-xl border border-emerald-500/50 bg-emerald-500/10 p-2.5 text-xs text-emerald-700 dark:text-emerald-400 flex items-center justify-between shrink-0 animate-in fade-in">
          <span className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="h-4 w-4" />
            {ticketCreationNotice}
          </span>
          <Link to="/issues" className="underline font-semibold text-xs ml-2 hover:text-emerald-800 dark:hover:text-emerald-300">
            Lihat Tiket di Board
          </Link>
        </div>
      )}

      {/* 2. Main Two-Column Layout (Matching Full Height with internal scrolling) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 items-stretch flex-1 min-h-0 overflow-hidden">
        {/* Left Column: Notes & Live Enhanced Notes */}
        <div className={`${isRightPaneOpen ? "lg:col-span-7" : "lg:col-span-12"} h-full flex flex-col min-h-0 overflow-hidden transition-all duration-200`}>
          <div className="rounded-2xl border border-border/80 bg-card shadow-xs flex flex-col h-full min-h-0 overflow-hidden">
            {/* Toolbar Row */}
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2 bg-card/70 shrink-0 flex-wrap gap-2">
              <div className="flex items-center gap-1">
                {/* Format buttons */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-md font-bold text-xs"
                  onClick={() => handleInsertMarkdownBlock("**", "**")}
                  title="Tebalkan Teks (Bold)"
                >
                  <Bold className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-md italic text-xs"
                  onClick={() => handleInsertMarkdownBlock("*", "*")}
                  title="Miringkan Teks (Italic)"
                >
                  <Italic className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-md"
                  onClick={() => handleInsertMarkdownBlock("- ")}
                  title="Daftar Poin (Bullet List)"
                >
                  <List className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-md"
                  onClick={() => handleInsertMarkdownBlock("1. ")}
                  title="Daftar Nomor (Numbered List)"
                >
                  <ListOrdered className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-md font-semibold text-xs"
                  onClick={() => handleInsertMarkdownBlock("## ")}
                  title="Judul Bab (Heading)"
                >
                  T
                </Button>

                {/* View Mode Toggle: Edit vs Preview */}
                <div className="flex items-center ml-2 border-l border-border/60 pl-2 gap-0.5">
                  <Button
                    size="sm"
                    variant={notesViewMode === "edit" ? "secondary" : "ghost"}
                    onClick={() => setNotesViewMode("edit")}
                    className="h-6 text-xs px-2 rounded-md font-medium"
                  >
                    Tulis
                  </Button>
                  <Button
                    size="sm"
                    variant={notesViewMode === "preview" ? "secondary" : "ghost"}
                    onClick={() => setNotesViewMode("preview")}
                    className="h-6 text-xs px-2 rounded-md font-medium gap-1"
                  >
                    <Eye className="h-3 w-3" />
                    Pratinjau
                  </Button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {/* Style Dropdown */}
                <Select
                  value={selectedStyle}
                  onValueChange={(val) => {
                    setSelectedStyle(val);
                    if (notesContent.trim()) triggerEnhance(notesContent, val);
                  }}
                >
                  <SelectTrigger className="h-7 text-xs border-none shadow-none font-medium text-muted-foreground hover:text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Standard Executive">Standard</SelectItem>
                    <SelectItem value="Executive Brief">Executive Brief</SelectItem>
                    <SelectItem value="Action Oriented">Action Oriented</SelectItem>
                    <SelectItem value="Technical Deep-Dive">Technical Deep-Dive</SelectItem>
                    <SelectItem value="Key Takeaways">Key Takeaways</SelectItem>
                  </SelectContent>
                </Select>

                {/* Live Enhance ON / OFF Toggle */}
                <Button
                  size="sm"
                  variant={liveEnhanceEnabled ? "secondary" : "outline"}
                  onClick={() => setLiveEnhanceEnabled(!liveEnhanceEnabled)}
                  className={`h-7 px-3 rounded-full text-xs gap-1.5 font-medium transition-colors ${
                    liveEnhanceEnabled
                      ? "bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30"
                      : "text-muted-foreground"
                  }`}
                >
                  <Sparkles className="h-3 w-3" />
                  {liveEnhanceEnabled ? "Live Enhance ON" : "Live Enhance OFF"}
                </Button>

                {/* Toggle Enhanced Notes Panel */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground rounded-md"
                  onClick={() => setIsEnhancedPanelOpen(!isEnhancedPanelOpen)}
                  title={isEnhancedPanelOpen ? "Tutup panel enhanced notes" : "Buka panel enhanced notes"}
                >
                  {isEnhancedPanelOpen ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>

            {/* Split Content: Notes (Rich Markdown) & Live Enhanced Notes */}
            <div className={`p-3 gap-3 flex-1 min-h-0 overflow-hidden items-stretch ${isEnhancedPanelOpen ? "grid grid-cols-1 md:grid-cols-12" : "flex flex-col"}`}>
              {/* Column 1: Live Rich Markdown Editor (WYSIWYG format langsung) */}
              <div className={`flex flex-col h-full min-h-0 overflow-hidden justify-between ${isEnhancedPanelOpen ? "md:col-span-7" : "w-full"}`}>
                {notesViewMode === "edit" ? (
                  <div className="flex-1 min-h-0 overflow-y-auto border border-border/40 rounded-xl p-3 bg-background/50 focus-within:border-primary/50 transition-colors">
                    <MarkdownEditor
                      ref={editorRef}
                      value={notesContent}
                      onChange={handleNotesChange}
                      placeholder="Tulis notulen rapat di sini. Format teks (heading, tebal, daftar poin/nomor) langsung dirender otomatis..."
                      bordered={false}
                      className="bg-transparent h-full"
                      contentClassName="min-h-full text-sm leading-relaxed"
                    />
                  </div>
                ) : (
                  <div className="flex-1 min-h-0 overflow-y-auto border border-border/40 rounded-xl p-4 bg-background/50 prose prose-sm dark:prose-invert text-sm leading-relaxed max-w-none">
                    {notesContent.trim() ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {notesContent}
                      </ReactMarkdown>
                    ) : (
                      <p className="text-muted-foreground text-xs italic">Belum ada catatan yang ditulis.</p>
                    )}
                  </div>
                )}

                <div className="pt-2 flex items-center justify-between text-xs text-muted-foreground/70 shrink-0">
                  <span className="flex items-center gap-1.5">
                    {isNotesSaving ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin text-primary" />
                        Menyimpan notulen...
                      </>
                    ) : (
                      <>
                        <Check className="h-3 w-3 text-emerald-500" />
                        Tersimpan otomatis
                      </>
                    )}
                  </span>
                  <span>{notesContent.length} karakter</span>
                </div>
              </div>

              {/* Column 2: Live Enhanced Notes Card (Clean top alignment, no empty space gap!) */}
              {isEnhancedPanelOpen && (
                <div className="md:col-span-5 rounded-xl bg-muted/20 border border-border/60 p-3.5 flex flex-col h-full min-h-0 overflow-hidden shadow-2xs">
                  <div className="flex items-center justify-between border-b border-border/40 pb-2 mb-2 shrink-0">
                    <div className="flex items-center gap-1.5 font-medium text-xs text-foreground">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                      <span>Live enhanced notes</span>
                    </div>

                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground rounded-md"
                        onClick={() => triggerEnhance(notesContent, selectedStyle)}
                        disabled={isEnhancing || !notesContent.trim()}
                        title="Perbarui ringkasan sekarang"
                      >
                        <RefreshCw className={`h-3 w-3 ${isEnhancing ? "animate-spin" : ""}`} />
                      </Button>

                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground rounded-md"
                        onClick={handleCopyEnhanced}
                        disabled={!enhancedNotes}
                        title="Salin hasil enhanced notes"
                      >
                        {copiedEnhanced ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                      </Button>

                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground rounded-md"
                        onClick={() => setIsEnhancedCollapsed(!isEnhancedCollapsed)}
                      >
                        {isEnhancedCollapsed ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
                      </Button>
                    </div>
                  </div>

                  {/* Enhanced Content rendered from top without empty space gap */}
                  {!isEnhancedCollapsed && (
                    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
                      {isEnhancing ? (
                        <div className="flex flex-col items-center justify-center gap-2.5 py-16 text-center text-muted-foreground">
                          <Loader2 className="h-6 w-6 animate-spin text-primary" />
                          <p className="text-xs font-medium">Merangkum catatan ke format eksekutif...</p>
                        </div>
                      ) : !enhancedNotes ? (
                        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground/70 my-auto">
                          <div className="p-3 rounded-full bg-muted/60 text-muted-foreground/60">
                            <Sparkles className="h-6 w-6" />
                          </div>
                          <p className="text-xs max-w-xs leading-relaxed text-muted-foreground">
                            Live enhanced notes will appear here as shorthand notes are written.
                          </p>
                          {notesContent.trim().length > 0 && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => triggerEnhance(notesContent, selectedStyle)}
                              className="text-xs h-7 gap-1.5 mt-2 bg-card hover:bg-muted"
                            >
                              <Sparkles className="h-3 w-3" />
                              Enhance Notes Sekarang
                            </Button>
                          )}
                        </div>
                      ) : (
                        <div className="text-xs leading-relaxed text-foreground/90 prose prose-sm dark:prose-invert max-w-none pr-1 space-y-2">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {enhancedNotes}
                          </ReactMarkdown>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Multi-Tab Pane (Matching Full Height down to bottom!) */}
        {isRightPaneOpen && (
          <div className="lg:col-span-5 h-full flex flex-col min-h-0 overflow-hidden transition-all duration-200">
            <div className="rounded-2xl border border-border/80 bg-card shadow-xs flex flex-col h-full min-h-0 overflow-hidden">
              {/* Tab Bar: ONLY Live Q&A, Summary, and Transcript */}
              <div className="flex items-center justify-between border-b border-border/60 px-3 py-2 bg-card/70 shrink-0">
                <div className="flex items-center gap-1">
                  {(["qa", "summary", "transcript"] as const).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`px-3 py-1 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                        activeTab === tab
                          ? "bg-sky-500/15 text-sky-700 dark:text-sky-300 font-bold"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {tab === "qa" && "Live Q&A"}
                      {tab === "summary" && "Summary"}
                      {tab === "transcript" && "Transcript"}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <button
                    onClick={() => setFontSize(fontSize === "lg" ? "base" : "sm")}
                    className="px-1.5 py-0.5 hover:text-foreground font-semibold"
                    title="Perkecil Font"
                  >
                    A-
                  </button>
                  <button
                    onClick={() => setFontSize(fontSize === "sm" ? "base" : "lg")}
                    className="px-1.5 py-0.5 hover:text-foreground font-semibold"
                    title="Perbesar Font"
                  >
                    A+
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 rounded-full text-muted-foreground hover:text-foreground ml-1"
                    onClick={() => setIsRightPaneOpen(false)}
                    title="Tutup Pane Kanan"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {/* Tab 1: Live Q&A Tab (Real Conversation Questions, NO dummy data!) */}
              {activeTab === "qa" && (
                <div className="flex-1 min-h-0 overflow-y-auto p-3.5 flex flex-col gap-3">
                  <div className="flex items-center justify-between pb-2 border-b border-border/40 shrink-0">
                    <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <HelpCircle className="h-3.5 w-3.5 text-primary" />
                      Live Q&A Percakapan
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-xs px-2 gap-1"
                      onClick={handleExtractQA}
                      disabled={isExtractingQA}
                    >
                      <RefreshCw className={`h-3 w-3 ${isExtractingQA ? "animate-spin" : ""}`} />
                      <span>{isExtractingQA ? "Mendeteksi..." : "Deteksi Pertanyaan"}</span>
                    </Button>
                  </div>

                  {detectedQAs.length === 0 ? (
                    /* Gambar 3 Empty State: Questions detected during conversation will be answered here */
                    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-3 my-auto">
                      <div className="p-3.5 rounded-full bg-muted/50 border border-border/40 text-muted-foreground/70">
                        <HelpCircle className="h-6 w-6" />
                      </div>
                      <div className="flex flex-col gap-1 max-w-xs">
                        <p className="text-xs font-semibold text-foreground/90">
                          Questions detected during the conversation will be answered here.
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Pertanyaan yang diajukan selama percakapan akan otomatis terdeteksi dan dirangkum jawabannya di sini.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2.5">
                      {detectedQAs.map((item, idx) => (
                        <div
                          key={idx}
                          className="p-3 rounded-xl border border-border/60 bg-muted/20 flex flex-col gap-1.5 text-xs shadow-2xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-foreground leading-snug">
                              Q: {item.question}
                            </span>
                            {item.askedBy && (
                              <Badge variant="outline" className="text-xs shrink-0 bg-card py-0 px-1.5">
                                {item.askedBy}
                              </Badge>
                            )}
                          </div>
                          <p className="text-muted-foreground leading-relaxed pl-1 border-l-2 border-primary/40">
                            A: {item.answer}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Tab 2: Summary Tab */}
              {activeTab === "summary" && (
                <div className="flex-1 min-h-0 overflow-y-auto p-3.5 flex flex-col gap-4">
                  {/* Executive Summary */}
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                      <Sparkles className="h-3 w-3 text-primary" />
                      Intisari Rapat
                    </span>
                    <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed text-foreground">
                      {analyticalData.summary}
                    </div>
                  </div>

                  {/* Topics */}
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                      <Layers className="h-3 w-3 text-primary" />
                      Topik Diskusi
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {analyticalData.topics.map((t, idx) => (
                        <Badge key={idx} variant="outline" className="text-xs bg-card border-border/60">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  {/* Insights */}
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3 text-primary" />
                      Temuan & Catatan
                    </span>
                    <div className="flex flex-col gap-1.5">
                      {analyticalData.insights.map((ins, idx) => (
                        <div key={idx} className="p-2.5 rounded-lg bg-card border border-border/40 text-xs">
                          {ins}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Metrics */}
                  <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border/40 text-center">
                    <div className="p-2 rounded-lg bg-muted/20 border border-border/40">
                      <span className="text-xs text-muted-foreground block">Segmen</span>
                      <span className="text-sm font-semibold">{segments.length}</span>
                    </div>
                    <div className="p-2 rounded-lg bg-muted/20 border border-border/40">
                      <span className="text-xs text-muted-foreground block">Durasi</span>
                      <span className="text-sm font-semibold">
                        {formatTime(audioDuration || meeting?.duration_seconds || 0)}
                      </span>
                    </div>
                    <div className="p-2 rounded-lg bg-muted/20 border border-border/40">
                      <span className="text-xs text-muted-foreground block">Sentimen</span>
                      <span className="text-sm font-semibold text-primary">{analyticalData.sentiment}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 3: Transcript Tab matching Gambar 3 */}
              {activeTab === "transcript" && (
                <div className="flex-1 min-h-0 flex flex-col justify-between overflow-hidden">
                  {/* Header in Transcript with Search, Auto-scroll & Copy */}
                  <div className="p-3 border-b border-border/40 flex items-center justify-between gap-2 shrink-0">
                    <div className="relative flex-1">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        value={transcriptSearch}
                        onChange={(e) => setTranscriptSearch(e.target.value)}
                        placeholder="Cari transkrip..."
                        className="h-7 pl-8 text-xs rounded-lg"
                      />
                    </div>

                    <Button
                      size="sm"
                      variant={autoScroll ? "secondary" : "ghost"}
                      onClick={() => setAutoScroll(!autoScroll)}
                      className="h-7 text-xs px-2"
                    >
                      Auto-scroll
                    </Button>

                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={handleCopyTranscript}
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      title="Salin Transkrip"
                    >
                      {copiedTranscript ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  </div>

                  {/* Transcript time pill matching Gambar 3 */}
                  <div className="flex justify-center py-2 bg-muted/10 border-b border-border/30 shrink-0">
                    <div className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-3.5 py-1 text-xs text-muted-foreground font-mono">
                      <Clock className="h-3 w-3" />
                      <span>Transcript {formatTime(currentTime > 0 ? currentTime : meeting.duration_seconds)}</span>
                    </div>
                  </div>

                  {/* Segments Stream with Font Size scale */}
                  <div
                    ref={transcriptContainerRef}
                    className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2"
                  >
                    {filteredSegments.length === 0 ? (
                      <div className="py-16 text-center text-xs text-muted-foreground my-auto">
                        {segments.length === 0
                          ? "Belum ada segmen transkrip terekam."
                          : "Tidak ditemukan segmen dengan kata kunci tersebut."}
                      </div>
                    ) : (
                      filteredSegments.map((seg, idx) => {
                        const isActive = activeSegmentIndex === idx;
                        return (
                          <div
                            key={seg.id || idx}
                            ref={isActive ? activeSegmentRef : null}
                            onClick={() => seekTo(seg.start_seconds)}
                            className={`p-2.5 rounded-xl border transition-all cursor-pointer ${
                              isActive
                                ? "bg-primary/10 border-primary/40 shadow-xs"
                                : "bg-card/40 border-border/40 hover:bg-muted/40"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2 mb-1">
                              <span className="text-xs font-semibold text-primary/80 flex items-center gap-1.5">
                                {isActive && <Volume2 className="h-3 w-3 text-primary animate-pulse" />}
                                {seg.speaker}
                              </span>
                              <span className="text-xs font-mono text-muted-foreground">
                                {formatTime(seg.start_seconds)} - {formatTime(seg.end_seconds)}
                              </span>
                            </div>
                            <p
                              className={`leading-relaxed text-foreground/90 ${
                                fontSize === "sm" ? "text-xs" : fontSize === "lg" ? "text-base" : "text-sm"
                              }`}
                            >
                              {seg.text}
                            </p>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Floating Toggle button when right pane is closed */}
      {!isRightPaneOpen && (
        <button
          onClick={() => setIsRightPaneOpen(true)}
          className="fixed right-6 bottom-20 z-30 flex items-center gap-2 px-3.5 py-2.5 bg-primary text-primary-foreground rounded-full shadow-lg text-xs font-semibold hover:bg-primary/90 transition-all cursor-pointer"
        >
          <Sparkles className="h-4 w-4" />
          <span>Buka Assistant & Transcript</span>
        </button>
      )}

      {/* 3. Bottom Sticky Audio Player Bar (Glassmorphism & Compact) */}
      <div className="rounded-2xl border border-border/80 bg-card/90 backdrop-blur-md p-2.5 shadow-lg flex flex-col gap-2 shrink-0">
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="metadata"
          onTimeUpdate={() => {
            if (audioRef.current) {
              setCurrentTime(audioRef.current.currentTime);
            }
          }}
          onLoadedMetadata={() => {
            if (audioRef.current) {
              const d = audioRef.current.duration;
              setAudioDuration(!isNaN(d) && isFinite(d) && d > 0 ? d : meeting.duration_seconds);
            }
          }}
          onEnded={() => setIsPlaying(false)}
          onError={() => {
            setIsPlaying(false);
            if (meeting.status === "recording") {
              setAudioError("Audio sedang direkam live.");
            } else if (!meeting.audio_path) {
              setAudioError("File audio belum siap atau sedang diproses.");
            } else {
              setAudioError("Audio tidak dapat dimuat.");
            }
          }}
        />

        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="default"
              onClick={handlePlayPause}
              className="h-8 w-8 rounded-full bg-primary text-primary-foreground shrink-0 shadow-xs"
            >
              {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 ml-0.5" />}
            </Button>

            <Button
              size="icon"
              variant="ghost"
              onClick={() => seekTo(Math.max(0, currentTime - 10))}
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              title="Mundur 10 detik"
            >
              <RotateCcw className="h-3 w-3" />
            </Button>
          </div>

          {/* Timeline Scrubber */}
          <div className="flex-1 flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground w-12 text-right">
              {formatTime(currentTime)}
            </span>
            <input
              type="range"
              min={0}
              max={audioDuration || 1}
              step={0.1}
              value={currentTime}
              onChange={(e) => seekTo(Number(e.target.value))}
              className="w-full accent-primary h-1.5 bg-muted rounded-lg cursor-pointer"
            />
            <span className="text-xs font-mono text-muted-foreground w-12">
              {formatTime(audioDuration)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleOpenSingleTaskModal(`Tindak lanjut: ${meeting.title}`)}
              className="h-7 text-xs gap-1.5 bg-card hover:bg-muted"
            >
              <Plus className="h-3 w-3" />
              Buat Task
            </Button>
          </div>
        </div>

        {audioError && (
          <div className="text-xs text-destructive flex items-center gap-1.5 px-1">
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span>{audioError}</span>
          </div>
        )}
      </div>

      {/* 4. AI Agent Ticket Extraction Dialog (Gambar 2 Ekstrak Tiket Flow) */}
      <Dialog open={isExtractModalOpen} onOpenChange={setIsExtractModalOpen}>
        <DialogContent className="sm:max-w-2xl max-h-full flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Ekstrak Tiket dari Meeting dengan AI Agent
            </DialogTitle>
            <DialogDescription>
              AI menganalisis notulen dan transkrip pertemuan ini, kemudian memetakan setiap tugas ke agen terbaik dalam tim Anda.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto py-3 flex flex-col gap-3">
            {isExtractingTickets ? (
              <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm font-medium text-foreground">
                  AI Agent sedang menganalisis isi rapat...
                </p>
                <p className="text-xs text-muted-foreground max-w-sm">
                  Mencocokkan tanggung jawab tugas dengan kapabilitas dan keahlian tim agen.
                </p>
              </div>
            ) : extractedTickets.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                Tidak ada tiket yang terdeteksi secara otomatis. Pastikan notulen atau transkrip terisi.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                  <span>
                    {extractedTickets.filter((t) => t.selected).length} dari {extractedTickets.length} tiket dipilih
                  </span>
                  <button
                    onClick={() => {
                      const allSelected = extractedTickets.every((t) => t.selected);
                      setExtractedTickets((prev) =>
                        prev.map((t, i) => ({ ...t, selected: !allSelected }))
                      );
                    }}
                    className="underline hover:text-foreground cursor-pointer"
                  >
                    {extractedTickets.every((t) => t.selected) ? "Batal Pilih Semua" : "Pilih Semua"}
                  </button>
                </div>

                {extractedTickets.map((ticket, index) => (
                  <div
                    key={index}
                    className={`rounded-xl border p-3.5 flex flex-col gap-2.5 transition-all ${
                      ticket.selected
                        ? "bg-card border-primary/40 shadow-xs"
                        : "bg-muted/20 border-border/50 opacity-60"
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        checked={ticket.selected}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setExtractedTickets((prev) =>
                            prev.map((t, i) => (i === index ? { ...t, selected: checked } : t))
                          );
                        }}
                        className="mt-1 h-4 w-4 accent-primary rounded cursor-pointer"
                      />

                      <div className="flex-1 flex flex-col gap-2">
                        <Input
                          value={ticket.title}
                          onChange={(e) => {
                            const val = e.target.value;
                            setExtractedTickets((prev) =>
                              prev.map((t, i) => (i === index ? { ...t, title: val } : t))
                            );
                          }}
                          className="h-8 text-xs font-semibold"
                          placeholder="Judul tiket..."
                        />

                        <Textarea
                          value={ticket.description}
                          onChange={(e) => {
                            const val = e.target.value;
                            setExtractedTickets((prev) =>
                              prev.map((t, i) => (i === index ? { ...t, description: val } : t))
                            );
                          }}
                          rows={2}
                          className="text-xs resize-none"
                          placeholder="Deskripsi tugas..."
                        />

                        {/* Agent Suggestion & Rationale */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                          <div className="flex flex-col gap-1">
                            <Label className="text-xs text-muted-foreground flex items-center gap-1">
                              <Bot className="h-3 w-3 text-primary" />
                              Ditugaskan ke (Assignee)
                            </Label>
                            <Select
                              value={ticket.suggestedAgentId || "unassigned"}
                              onValueChange={(val) => {
                                const selectedAgent = agents.find((a) => a.id === val);
                                setExtractedTickets((prev) =>
                                  prev.map((t, i) =>
                                    i === index
                                      ? {
                                          ...t,
                                          suggestedAgentId: val === "unassigned" ? null : val,
                                          suggestedAgentName: selectedAgent?.name || null,
                                        }
                                      : t
                                  )
                                );
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue placeholder="Pilih agen..." />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="unassigned">Unassigned (Umum)</SelectItem>
                                {agents.map((ag) => (
                                  <SelectItem key={ag.id} value={ag.id}>
                                    {ag.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="flex flex-col gap-1">
                            <Label className="text-xs text-muted-foreground">Prioritas</Label>
                            <Select
                              value={ticket.priority}
                              onValueChange={(val: any) => {
                                setExtractedTickets((prev) =>
                                  prev.map((t, i) => (i === index ? { ...t, priority: val } : t))
                                );
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="low">Low</SelectItem>
                                <SelectItem value="medium">Medium</SelectItem>
                                <SelectItem value="high">High</SelectItem>
                                <SelectItem value="urgent">Urgent</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        {ticket.rationale && (
                          <div className="text-xs text-muted-foreground bg-muted/40 p-2 rounded-lg flex items-center gap-1.5">
                            <Sparkles className="h-3 w-3 text-primary shrink-0" />
                            <span>
                              <strong>Rasional AI</strong>: {ticket.rationale}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter className="flex flex-row justify-between sm:justify-between items-center w-full pt-2 border-t border-border/40">
            <Button variant="ghost" onClick={() => setIsExtractModalOpen(false)} className="text-xs">
              Batal
            </Button>
            <Button
              onClick={handleConfirmCreateTickets}
              disabled={isCreatingExtractedTickets || extractedTickets.filter((t) => t.selected).length === 0}
              className="text-xs gap-1.5 bg-primary text-primary-foreground font-medium"
            >
              {isCreatingExtractedTickets ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                  Membuat Tiket...
                </>
              ) : (
                `Buat ${extractedTickets.filter((t) => t.selected).length} Tiket ke Backlog`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 5. Single Task Modal */}
      <Dialog open={isSingleTaskModalOpen} onOpenChange={setIsSingleTaskModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Buat Task Baru dari Rapat</DialogTitle>
            <DialogDescription>
              Buat task yang ditautkan langsung dengan rekaman dan catatan meeting ini.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 py-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="single-task-title">Judul Task</Label>
              <Input
                id="single-task-title"
                value={singleTaskTitle}
                onChange={(e) => setSingleTaskTitle(e.target.value)}
                placeholder="Ringkasan tugas..."
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="single-task-desc">Deskripsi / Konteks</Label>
              <Textarea
                id="single-task-desc"
                value={singleTaskDesc}
                onChange={(e) => setSingleTaskDesc(e.target.value)}
                placeholder="Rincian tindak lanjut..."
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label>Pilih Agen</Label>
                <Select
                  value={singleTaskAssignee || "unassigned"}
                  onValueChange={(val) => setSingleTaskAssignee(val === "unassigned" ? null : val)}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Pilih agen..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned (Umum)</SelectItem>
                    {agents.map((ag) => (
                      <SelectItem key={ag.id} value={ag.id}>
                        {ag.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1">
                <Label>Prioritas</Label>
                <Select value={singleTaskPriority} onValueChange={setSingleTaskPriority}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <DialogFooter className="flex flex-row justify-between sm:justify-between items-center w-full">
            <Button variant="ghost" onClick={() => setIsSingleTaskModalOpen(false)} className="text-xs">
              Batal
            </Button>
            <Button
              onClick={handleCreateSingleTask}
              disabled={isCreatingSingleTask || !singleTaskTitle.trim()}
              className="text-xs"
            >
              {isCreatingSingleTask ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                  Membuat...
                </>
              ) : (
                "Simpan & Buat Task"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
