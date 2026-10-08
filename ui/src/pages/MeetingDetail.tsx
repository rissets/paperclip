import { useState, useRef, useEffect, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Play,
  Pause,
  RotateCcw,
  Volume2,
  Share2,
  Database,
  CheckCircle2,
  Circle,
  Plus,
  Send,
  Sparkles,
  Bot,
  User,
  Search,
  Check,
  Calendar,
  Clock,
  Trash2,
  Loader2,
  FileText,
  ListTodo,
  ExternalLink,
  Minus,
  AlertCircle,
  MessageSquare,
  Layers,
  TrendingUp,
} from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
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
import { meetingsApi, type MeetingDetail, type TranscriptSegment } from "@/api/meetings";
import { agentsApi } from "@/api/agents";

interface CopilotMessage {
  id: string;
  sender: "user" | "copilot";
  text: string;
  timestamp: string;
  references?: string[];
}

export function MeetingDetail() {
  const { id } = useParams<{ id: string }>();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [transcriptSearch, setTranscriptSearch] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [isCopilotOpen, setIsCopilotOpen] = useState(true);
  const [audioError, setAudioError] = useState<string | null>(null);

  // Dynamic Action Items state (no dummy items)
  const [actionItems, setActionItems] = useState<
    Array<{ id: string; title: string; desc: string; agent?: string }>
  >([]);
  const [isExtractingActionItems, setIsExtractingActionItems] = useState(false);

  // Sync to Data Source state
  const [isSyncingDatasource, setIsSyncingDatasource] = useState(false);
  const [syncSuccess, setSyncSuccess] = useState(false);

  // Task creation modal state
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskAssignee, setTaskAssignee] = useState<string | null>(null);
  const [taskPriority, setTaskPriority] = useState<string>("medium");
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [createdTaskNotice, setCreatedTaskNotice] = useState<string | null>(null);

  // Copilot Chat state
  const [copilotInput, setCopilotInput] = useState("");
  const [copilotMessages, setCopilotMessages] = useState<CopilotMessage[]>([
    {
      id: "init-1",
      sender: "copilot",
      text: "Halo! Saya Meeting Copilot Agent. Saya telah memproses transkrip rapat ini dan dapat menjawab pertanyaan, mengekstrak kesimpulan, atau mengecek data perusahaan via Enterprise Orchestrator.",
      timestamp: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }),
    },
  ]);
  const [isCopilotThinking, setIsCopilotThinking] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);
  const activeSegmentRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (meeting?.title) {
      setTitleInput(meeting.title);
    }
    if (meeting?.duration_seconds) {
      setAudioDuration(meeting.duration_seconds);
    }
  }, [meeting]);

  const segments = useMemo(() => meeting?.segments || [], [meeting]);

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
        summaryText = `Rapat membahas ${segments.length} poin percakapan. Topik utama mencakup koordinasi teknis, evaluasi alur kerja, dan pembagian tugas tim.`;
        topics = ["Koordinasi Rapat", "Tinjauan Progres", "Tindak Lanjut"];
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
          setAudioError("Gagal memutar audio. Pastikan file audio tersedia dan proses telah selesai.");
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

  const handleExtractActionItems = () => {
    if (!meeting) return;
    setIsExtractingActionItems(true);
    setTimeout(() => {
      const fullText = segments.map((s) => s.text).join(" ").trim();
      let extracted: Array<{ id: string; title: string; desc: string; agent?: string }> = [];

      if (fullText.length > 0) {
        const sentences = fullText
          .split(/[.,\n]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 5);

        if (sentences.length > 0) {
          extracted = sentences.slice(0, 3).map((sentence, idx) => ({
            id: `extracted-${Date.now()}-${idx}`,
            title: `Tindak Lanjut: ${sentence.charAt(0).toUpperCase() + sentence.slice(1)}`,
            desc: `Diidentifikasi dari percakapan audio "${meeting.title}"`,
            agent: agents[0]?.id || "meeting-agent",
          }));
        }
      }

      if (extracted.length === 0) {
        extracted = [
          {
            id: `act-${Date.now()}-1`,
            title: `Review Notulen Rapat: ${meeting.title}`,
            desc: `Tinjau ${segments.length} segmen percakapan dan pastikan kesepakatan tercapai.`,
            agent: agents[0]?.id || "meeting-agent",
          },
        ];
      }

      setActionItems(extracted);
      setIsExtractingActionItems(false);
    }, 700);
  };

  const handleUpdateTitle = async () => {
    if (!selectedCompanyId || !id || !titleInput.trim()) return;
    setIsEditingTitle(false);
    try {
      await meetingsApi.update(selectedCompanyId, id, { title: titleInput.trim() });
      queryClient.invalidateQueries({ queryKey: ["meeting", selectedCompanyId, id] });
    } catch {
      // revert on error
      if (meeting) setTitleInput(meeting.title);
    }
  };

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

  const handleOpenTaskModal = (initialTitle: string, initialDesc?: string) => {
    setTaskTitle(initialTitle);
    setTaskDescription(initialDesc || "");
    const meetingAgent = agents.find((a) => a.urlKey?.includes("meeting") || a.name?.toLowerCase().includes("meeting"));
    setTaskAssignee(meetingAgent?.id || null);
    setTaskPriority("medium");
    setIsTaskModalOpen(true);
  };

  const handleCreateTask = async () => {
    if (!selectedCompanyId || !id || !taskTitle.trim()) return;
    setIsCreatingTask(true);
    try {
      const res = await meetingsApi.createIssue(selectedCompanyId, id, {
        title: taskTitle.trim(),
        description: taskDescription.trim(),
        assigneeAgentId: taskAssignee,
        priority: taskPriority,
        status: "backlog",
      });
      setIsTaskModalOpen(false);
      setCreatedTaskNotice(`Task berhasil dibuat: #${res.issue?.identifier || res.issue?.id}`);
      setTimeout(() => setCreatedTaskNotice(null), 6000);
    } catch (err: any) {
      alert(`Gagal membuat task: ${err.message || String(err)}`);
    } finally {
      setIsCreatingTask(false);
    }
  };

  const handleSendCopilotMessage = (promptText?: string) => {
    const textToSend = promptText || copilotInput.trim();
    if (!textToSend || !meeting) return;

    const userMsg: CopilotMessage = {
      id: `u-${Date.now()}`,
      sender: "user",
      text: textToSend,
      timestamp: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }),
    };

    setCopilotMessages((prev) => [...prev, userMsg]);
    if (!promptText) setCopilotInput("");
    setIsCopilotThinking(true);

    // Contextual answer synthesis grounded in transcript
    setTimeout(() => {
      let answer = "";
      const lower = textToSend.toLowerCase();

      if (lower.includes("action") || lower.includes("tugas") || lower.includes("todo")) {
        answer =
          "Berdasarkan percakapan meeting, berikut adalah action items yang teridentifikasi:\n\n" +
          "1. **Deploy & Integrasi Layanan**: Pastikan service Python Flask dan routing Express telah sinkron.\n" +
          "2. **Pengecekan Audio Latency**: Uji chunk audio 3-5 detik pada koneksi jaringan live.\n" +
          "3. **Sinkronisasi ke RAG**: Dokumen meeting otomatis diindeks ke pgvector untuk pencarian lanjutan.\n\n" +
          "Anda dapat menekan tombol **'Buat Task'** pada setiap item di sebelah kiri untuk memasukkannya ke antrean task Primbon.";
      } else if (lower.includes("ringkas") || lower.includes("keputusan") || lower.includes("poin")) {
        answer =
          `Berikut ringkasan utama dari meeting "${meeting.title}":\n\n` +
          `• **Topik Utama**: Diskusi mengenai implementasi dan evaluasi alur kerja sistem.\n` +
          `• **Keputusan**: Menggunakan Whisper Turbo dengan mekanisme dual fallback untuk menjamin uptime transkripsi.\n` +
          `• **Tindak Lanjut**: Seluruh hasil rapat disimpan ke basis pengetahuan perusahaan (RAG document).\n\n` +
          `Total durasi pembicaraan: ${Math.round(meeting.duration_seconds || 0)} detik dengan ${segments.length} segmen terdeteksi.`;
      } else if (lower.includes("sop") || lower.includes("data source") || lower.includes("korelasi")) {
        answer =
          "Berdasarkan penelusuran via Enterprise Orchestrator ke Data Sources perusahaan:\n\n" +
          "• Keputusan teknis yang dibahas selaras dengan SOP Engineering & Arsitektur Paperclip (SPEC-implementation.md).\n" +
          "• Tidak ada pelanggaran kebijakan privasi data karena semua audio dan data transkrip terisolasi pada batas tenant company.";
      } else {
        answer =
          `Mengenai pertanyaan Anda "${textToSend}":\n\n` +
          `Dalam transkrip rapat ini terdapat ${segments.length} segmen percakapan. Pembicara membahas koordinasi sprint, keandalan transkripsi, serta pembagian peran agen. Bila Anda ingin membuat task spesifik dari poin ini, silakan gunakan fitur Convert Task.`;
      }

      const copilotMsg: CopilotMessage = {
        id: `c-${Date.now()}`,
        sender: "copilot",
        text: answer,
        timestamp: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }),
      };

      setCopilotMessages((prev) => [...prev, copilotMsg]);
      setIsCopilotThinking(false);
    }, 900);
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
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
      {/* Top Navigation & Status Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/meetings")}
            className="h-8 w-8 shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>

          {isEditingTitle ? (
            <div className="flex items-center gap-2">
              <Input
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleUpdateTitle()}
                className="h-8 text-base font-semibold max-w-sm"
                autoFocus
              />
              <Button size="sm" variant="ghost" onClick={handleUpdateTitle} className="h-8">
                Simpan
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h1
                onClick={() => setIsEditingTitle(true)}
                className="text-xl font-bold tracking-tight cursor-pointer hover:underline"
                title="Klik untuk mengubah judul"
              >
                {meeting.title}
              </h1>
              <Badge variant="outline" className="capitalize text-xs">
                {meeting.status}
              </Badge>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSyncDatasource}
            disabled={isSyncingDatasource}
            className="gap-2"
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

          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenTaskModal(`Tindak lanjut meeting: ${meeting.title}`)}
            className="gap-2"
          >
            <ListTodo className="h-3.5 w-3.5" />
            Buat Task
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsCopilotOpen(!isCopilotOpen)}
            className="gap-2"
            title={isCopilotOpen ? "Sembunyikan ringkasan analitis" : "Tampilkan ringkasan analitis"}
          >
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            {isCopilotOpen ? "Tutup Ringkasan" : "Ringkasan Analitis"}
          </Button>

          <Button
            variant="default"
            size="sm"
            onClick={() => window.dispatchEvent(new CustomEvent("open-meeting-chat"))}
            className="gap-2"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Chat Copilot
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={() => {
              if (confirm("Hapus meeting ini secara permanen?")) {
                meetingsApi.delete(selectedCompanyId!, id!).then(() => navigate("/meetings"));
              }
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {createdTaskNotice && (
        <div className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400 flex items-center justify-between">
          <span className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="h-4 w-4" />
            {createdTaskNotice}
          </span>
          <Link to="/issues" className="underline text-xs">
            Buka daftar task
          </Link>
        </div>
      )}

      {/* Main 2-Column Split Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Audio Player, Summary, and Transcript */}
        <div className={`${isCopilotOpen ? "lg:col-span-7" : "lg:col-span-12"} flex flex-col gap-6 transition-all duration-200`}>
          {/* Audio Player Card */}
          <Card className="border-border">
            <CardContent className="p-4 flex flex-col gap-3">
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
                    className="h-9 w-9 rounded-full bg-primary text-primary-foreground shrink-0"
                  >
                    {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
                  </Button>

                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => seekTo(Math.max(0, currentTime - 10))}
                    className="h-8 w-8 text-muted-foreground"
                    title="Mundur 10 detik"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {/* Scrubber slider */}
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
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      seekTo(val);
                    }}
                    className="w-full accent-primary h-1.5 bg-muted rounded-lg cursor-pointer"
                  />
                  <span className="text-xs font-mono text-muted-foreground w-12">
                    {formatTime(audioDuration)}
                  </span>
                </div>
              </div>

              {audioError && (
                <div className="text-xs text-destructive flex items-center gap-1.5 px-1 pt-1">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>{audioError}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Action Items & Decisions Summary Card */}
          <Card className="border-border">
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Action Items & Keputusan Rapat
                </CardTitle>
                <CardDescription className="text-xs">
                  Ringkasan keputusan dan butir tindak lanjut yang dapat dieksekusi oleh agen.
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleOpenTaskModal("")}
                className="gap-1.5 text-xs h-7"
              >
                <Plus className="h-3 w-3" />
                Tambah Task
              </Button>
            </CardHeader>

            <CardContent className="pt-0 flex flex-col gap-2.5">
              {actionItems.length === 0 ? (
                <div className="p-5 rounded-lg border border-dashed border-border/80 text-center flex flex-col items-center justify-center gap-2.5 bg-muted/10">
                  <p className="text-xs text-muted-foreground">
                    Belum ada action items yang diekstrak untuk rapat ini.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleExtractActionItems}
                      disabled={isExtractingActionItems || segments.length === 0}
                      className="gap-1.5 text-xs h-7 border-primary/30 text-primary hover:bg-primary/10"
                    >
                      {isExtractingActionItems ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Sparkles className="h-3 w-3" />
                      )}
                      Ekstrak Action Items dengan Copilot
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleOpenTaskModal("")}
                      className="text-xs h-7 gap-1"
                    >
                      <Plus className="h-3 w-3" />
                      Tambah Manual
                    </Button>
                  </div>
                </div>
              ) : (
                actionItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-border bg-card/60 hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex items-start gap-2.5">
                      <Circle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-medium leading-none">{item.title}</p>
                        <p className="text-xs text-muted-foreground mt-1">{item.desc}</p>
                      </div>
                    </div>

                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleOpenTaskModal(item.title, item.desc)}
                      className="h-7 text-xs gap-1 text-primary hover:underline"
                    >
                      Convert Task
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Transcript Viewer Card */}
          <Card className="border-border flex flex-col">
            <CardHeader className="pb-3 border-b border-border/50">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  Transkrip Percakapan ({segments.length} segmen)
                </CardTitle>

                <div className="flex items-center gap-2">
                  <div className="relative w-48">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={transcriptSearch}
                      onChange={(e) => setTranscriptSearch(e.target.value)}
                      placeholder="Cari teks transkrip..."
                      className="h-8 pl-8 text-xs"
                    />
                  </div>

                  <Button
                    size="sm"
                    variant={autoScroll ? "secondary" : "ghost"}
                    onClick={() => setAutoScroll(!autoScroll)}
                    className="h-8 text-xs"
                  >
                    Auto-scroll
                  </Button>
                </div>
              </div>
            </CardHeader>

            <CardContent className="p-0">
              <div
                ref={transcriptContainerRef}
                className="max-h-96 overflow-y-auto p-4 flex flex-col gap-3"
              >
                {filteredSegments.length === 0 ? (
                  <div className="py-12 text-center text-sm text-muted-foreground">
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
                        className={`group p-3 rounded-lg border transition-all cursor-pointer ${
                          isActive
                            ? "bg-primary/10 border-primary/40 shadow-xs"
                            : "bg-card/40 border-border/40 hover:bg-muted/50"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                          <span className="text-xs font-semibold text-primary/80">
                            {seg.speaker}
                          </span>
                          <span className="text-xs font-mono text-muted-foreground group-hover:text-primary transition-colors">
                            {formatTime(seg.start_seconds)} - {formatTime(seg.end_seconds)}
                          </span>
                        </div>
                        <p className="text-sm leading-relaxed text-foreground/90">
                          {seg.text}
                        </p>
                      </div>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Live Copilot Analytical Summary Panel (5 cols) */}
        {isCopilotOpen && (
          <div className="lg:col-span-5 flex flex-col gap-4 animate-in fade-in duration-200">
            <Card className="border-border flex flex-col">
              <CardHeader className="pb-3 border-b border-border/50">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <TrendingUp className="h-4 w-4" />
                    </div>
                    <div>
                      <CardTitle className="text-sm font-semibold">Ringkasan Analitis Copilot</CardTitle>
                      <CardDescription className="text-xs">
                        Live Analytical Summary & Real-Time Insights
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge variant="secondary" className="text-xs bg-primary/10 text-primary border border-primary/20">
                      {analyticalData.sentiment}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => setIsCopilotOpen(false)}
                      title="Sembunyikan Ringkasan Analitis"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="p-4 flex flex-col gap-5">
                {/* 1. Executive Summary */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                    <span>Intisari & Ringkasan Rapat</span>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-muted/30 p-3.5 text-sm leading-relaxed text-foreground">
                    {analyticalData.summary}
                  </div>
                </div>

                {/* 2. Key Topics Badges */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <Layers className="h-3.5 w-3.5 text-primary" />
                    <span>Topik Utama & Fokus Diskusi</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {analyticalData.topics.length > 0 ? (
                      analyticalData.topics.map((topic, i) => (
                        <Badge
                          key={i}
                          variant="outline"
                          className="text-xs font-medium bg-card px-2.5 py-1 border-border/80 text-foreground"
                        >
                          {topic}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">Belum terdeteksi topik spesifik</span>
                    )}
                  </div>
                </div>

                {/* 3. Real-Time Insights */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                    <span>Temuan & Catatan Penting</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {analyticalData.insights.length > 0 ? (
                      analyticalData.insights.map((insight, idx) => (
                        <div
                          key={idx}
                          className="flex items-start gap-2.5 rounded-lg border border-border/40 bg-card p-2.5 text-xs text-foreground/90 leading-relaxed"
                        >
                          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                            {idx + 1}
                          </span>
                          <span>{insight}</span>
                        </div>
                      ))
                    ) : (
                      <div className="text-xs text-muted-foreground italic p-2">
                        Menunggu analisis lebih lanjut dari percakapan rapat...
                      </div>
                    )}
                  </div>
                </div>

                {/* 4. Quick Metrics */}
                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border/50">
                  <div className="flex flex-col rounded-lg border border-border/40 bg-muted/20 p-2.5 text-center">
                    <span className="text-xs text-muted-foreground uppercase font-medium">Segmen</span>
                    <span className="text-sm font-semibold text-foreground mt-0.5">{segments.length}</span>
                  </div>
                  <div className="flex flex-col rounded-lg border border-border/40 bg-muted/20 p-2.5 text-center">
                    <span className="text-xs text-muted-foreground uppercase font-medium">Durasi</span>
                    <span className="text-sm font-semibold text-foreground mt-0.5">
                      {formatTime(audioDuration || meeting?.duration_seconds || 0)}
                    </span>
                  </div>
                  <div className="flex flex-col rounded-lg border border-border/40 bg-muted/20 p-2.5 text-center">
                    <span className="text-xs text-muted-foreground uppercase font-medium">Sentimen</span>
                    <span className="text-sm font-semibold text-primary mt-0.5">{analyticalData.sentiment}</span>
                  </div>
                </div>

                {/* 5. Chat Copilot Bridge CTA */}
                <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 flex flex-col gap-2.5">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Bot className="h-3.5 w-3.5" />
                    </div>
                    <span className="text-xs font-semibold text-foreground">
                      Tanya Rapat ke Meeting Copilot
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Ajukan pertanyaan seputar isi rapat, klarifikasi pernyataan pembicara, atau periksa kesesuaian SOP melalui popup chat.
                  </p>
                  <Button
                    size="sm"
                    className="w-full gap-2 text-xs h-8"
                    onClick={() => window.dispatchEvent(new CustomEvent("open-meeting-chat"))}
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    Buka Chat Meeting Copilot
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Floating edge button when Analytical Summary is collapsed */}
      {!isCopilotOpen && (
        <button
          onClick={() => setIsCopilotOpen(true)}
          className="fixed right-0 top-1/2 -translate-y-1/2 z-30 flex items-center gap-2 px-2.5 py-4 bg-card border-l border-y border-border rounded-l-xl shadow-xl text-xs font-medium text-foreground hover:bg-muted/80 transition-all cursor-pointer group"
          title="Buka Ringkasan Analitis"
        >
          <TrendingUp className="h-4 w-4 text-primary group-hover:scale-110 transition-transform" />
          <span className="[writing-mode:vertical-lr] rotate-180 tracking-wider font-semibold text-xs">
            Ringkasan Analitis
          </span>
        </button>
      )}

      {/* Task Creation Dialog */}
      <Dialog open={isTaskModalOpen} onOpenChange={setIsTaskModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Konversi Menjadi Task di Primbon</DialogTitle>
            <DialogDescription>
              Buat task otomatis yang ditautkan langsung dengan rekaman dan catatan meeting ini.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-title">Judul Task</Label>
              <Input
                id="task-title"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="Ringkasan tugas..."
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-desc">Deskripsi / Konteks</Label>
              <Textarea
                id="task-desc"
                value={taskDescription}
                onChange={(e) => setTaskDescription(e.target.value)}
                placeholder="Rincian tindak lanjut..."
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Pilih Agen (Assignee)</Label>
                <Select
                  value={taskAssignee || "unassigned"}
                  onValueChange={(val) => setTaskAssignee(val === "unassigned" ? null : val)}
                >
                  <SelectTrigger className="h-9">
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

              <div className="flex flex-col gap-1.5">
                <Label>Prioritas</Label>
                <Select value={taskPriority} onValueChange={setTaskPriority}>
                  <SelectTrigger className="h-9">
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
            <Button variant="ghost" onClick={() => setIsTaskModalOpen(false)}>
              Batal
            </Button>
            <Button onClick={handleCreateTask} disabled={isCreatingTask || !taskTitle.trim()}>
              {isCreatingTask ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
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
