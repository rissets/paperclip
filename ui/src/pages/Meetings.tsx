import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  Mic,
  UploadCloud,
  Search,
  Clock,
  FileAudio,
  Trash2,
  ExternalLink,
  Loader2,
  Calendar,
  Layers,
  Sparkles,
} from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { meetingsApi, type Meeting } from "@/api/meetings";
import { useMeetingRecorder } from "@/context/MeetingRecorderContext";

export function Meetings() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { openRecorder } = useMeetingRecorder();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { data: meetings = [], isLoading, isError } = useQuery({
    queryKey: ["meetings", selectedCompanyId],
    queryFn: () => (selectedCompanyId ? meetingsApi.list(selectedCompanyId) : Promise.resolve([])),
    enabled: !!selectedCompanyId,
    refetchInterval: (query) => {
      // Poll faster if any meeting is recording or transcribing
      const list = query.state.data ?? [];
      const hasActive = list.some((m) => m.status === "recording" || m.status === "transcribing");
      return hasActive ? 3000 : 15000;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (meetingId: string) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return meetingsApi.delete(selectedCompanyId, meetingId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meetings", selectedCompanyId] });
    },
  });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedCompanyId) return;

    setIsUploading(true);
    setUploadError(null);

    try {
      const cleanTitle = file.name.replace(/\.[^/.]+$/, "");
      const created = await meetingsApi.create(selectedCompanyId, {
        title: cleanTitle,
      });

      await meetingsApi.uploadAudio(selectedCompanyId, created.id, file);

      queryClient.invalidateQueries({ queryKey: ["meetings", selectedCompanyId] });
      navigate(`/meetings/${created.id}`);
    } catch (err: any) {
      setUploadError(`Gagal mengunggah audio: ${err.message || String(err)}`);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const formatDuration = (seconds: number) => {
    if (!seconds || seconds <= 0) return "0s";
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
  };

  const formatDate = (isoString: string) => {
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString("id-ID", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return isoString;
    }
  };

  interface ParsedSummary {
    text: string;
    topics?: string[];
    sentiment?: string;
  }

  const parseMeetingSummary = (raw?: string | null): ParsedSummary | null => {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return {
          text: parsed.summary || parsed.description || "",
          topics: Array.isArray(parsed.topics) ? parsed.topics : [],
          sentiment: parsed.sentiment || "",
        };
      } catch {
        // Fallback to plain text
      }
    }
    return { text: trimmed };
  };

  const filteredMeetings = meetings.filter((meeting) => {
    const matchesQuery =
      searchQuery.trim() === "" ||
      meeting.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (meeting.summary && meeting.summary.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesStatus =
      statusFilter === "all" || meeting.status.toLowerCase() === statusFilter.toLowerCase();

    return matchesQuery && matchesStatus;
  });

  const getStatusBadge = (status: Meeting["status"]) => {
    switch (status) {
      case "completed":
        return <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">Completed</Badge>;
      case "recording":
        return <Badge variant="default" className="bg-blue-500 text-white animate-pulse">Recording</Badge>;
      case "transcribing":
        return <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 dark:text-amber-400">Transcribing</Badge>;
      case "error":
        return <Badge variant="destructive">Error</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Meeting Notes & Live Copilot</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Transkripsi audio rapat otomatis, ekstraksi notulen dan action items, serta integrasi sumber data perusahaan.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept="audio/*,video/mp4,video/webm"
            className="hidden"
          />

          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="gap-2"
          >
            {isUploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Mengunggah...
              </>
            ) : (
              <>
                <UploadCloud className="h-4 w-4" />
                Upload Audio
              </>
            )}
          </Button>

          <Button
            onClick={() => openRecorder()}
            className="gap-2 bg-primary text-primary-foreground"
          >
            <Mic className="h-4 w-4" />
            Mulai Rapat Baru
          </Button>
        </div>
      </div>

      {uploadError && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {uploadError}
        </div>
      )}

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cari judul meeting atau catatan..."
            className="pl-9"
          />
        </div>

        <div className="flex items-center gap-1 self-start sm:self-auto overflow-x-auto">
          {["all", "recording", "transcribing", "completed"].map((tab) => (
            <Button
              key={tab}
              variant={statusFilter === tab ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter(tab)}
              className="capitalize text-xs"
            >
              {tab === "all" ? "Semua" : tab}
            </Button>
          ))}
        </div>
      </div>

      {/* Meetings Content List */}
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Memuat data rapat...</p>
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-6 text-center text-destructive">
          Gagal mengambil data meeting. Pastikan backend service Meeting Notes aktif.
        </div>
      ) : filteredMeetings.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border p-12 text-center bg-card">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
            <FileAudio className="h-7 w-7 text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold">Belum ada Meeting Notes</h3>
          <p className="text-sm text-muted-foreground max-w-sm mt-1 mb-5">
            Mulai rekam rapat dengan mikrofon langsung atau unggah file rekaman untuk transkripsi otomatis.
          </p>
          <div className="flex gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="gap-2"
            >
              <UploadCloud className="h-4 w-4" />
              Upload Audio
            </Button>
            <Button
              size="sm"
              onClick={() => openRecorder()}
              className="gap-2"
            >
              <Mic className="h-4 w-4" />
              Mulai Rapat
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredMeetings.map((meeting) => (
            <Card
              key={meeting.id}
              className="group flex flex-col justify-between hover:shadow-md transition-shadow border-border"
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <Link
                    to={`/meetings/${meeting.id}`}
                    className="font-semibold text-base hover:underline line-clamp-2"
                  >
                    {meeting.title}
                  </Link>
                  {getStatusBadge(meeting.status)}
                </div>
                <CardDescription className="flex items-center gap-3 text-xs mt-1">
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    {formatDate(meeting.created_at)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatDuration(meeting.duration_seconds)}
                  </span>
                </CardDescription>
              </CardHeader>

              <CardContent className="pt-0">
                {(() => {
                  const parsed = parseMeetingSummary(meeting.summary);
                  if (parsed && parsed.text) {
                    return (
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground line-clamp-3 bg-muted/40 p-2.5 rounded-lg border border-border/50">
                          {parsed.text}
                        </p>
                        {((parsed.topics && parsed.topics.length > 0) || parsed.sentiment) && (
                          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                            {parsed.topics?.slice(0, 3).map((topic, i) => (
                              <Badge key={i} variant="secondary" className="text-xs font-normal">
                                {topic}
                              </Badge>
                            ))}
                            {parsed.sentiment && (
                              <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
                                {parsed.sentiment}
                              </Badge>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  }
                  return (
                    <p className="text-xs text-muted-foreground/60 italic">
                      {meeting.status === "recording"
                        ? "Sedang merekam pembicaraan..."
                        : meeting.status === "transcribing"
                          ? "Sedang memproses transkripsi Whisper..."
                          : "Klik untuk membuka transkrip dan analisa copilot."}
                    </p>
                  );
                })()}

                <div className="flex items-center justify-between border-t border-border/50 pt-3 mt-4 text-xs">
                  <Link
                    to={`/meetings/${meeting.id}`}
                    className="flex items-center gap-1 text-primary hover:underline font-medium"
                  >
                    Buka Rapat
                    <ExternalLink className="h-3 w-3" />
                  </Link>

                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Hapus catatan meeting "${meeting.title}"?`)) {
                        deleteMutation.mutate(meeting.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
