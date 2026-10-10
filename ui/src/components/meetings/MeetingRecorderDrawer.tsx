import React from "react";
import { Link, useNavigate } from "@/lib/router";
import {
  Mic,
  Square,
  Loader2,
  Volume2,
  AlertCircle,
  ExternalLink,
  Minus,
  Maximize2,
  X,
  Radio,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCompany } from "@/context/CompanyContext";
import { useOptionalMeetingRecorder } from "@/context/MeetingRecorderContext";

export function MeetingRecorderDrawer() {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const recorder = useOptionalMeetingRecorder();
  if (!recorder || !recorder.isOpen) return null;

  const {
    isOpen,
    isMinimized,
    isRecording,
    isProcessing,
    currentMeeting,
    title,
    setTitle,
    elapsedSeconds,
    audioLevel,
    liveSegments,
    liveInsights,
    errorMessage,
    closeRecorder,
    setIsMinimized,
    startRecording,
    stopRecording,
  } = recorder;

  const formatTimer = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remaining = secs % 60;
    return `${mins.toString().padStart(2, "0")}:${remaining.toString().padStart(2, "0")}`;
  };

  if (!isOpen) return null;

  // Render Minimized Floating Shortcut Pill
  if (isMinimized) {
    return (
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-card border border-border/80 shadow-2xl rounded-full px-5 py-2.5 backdrop-blur-md animate-in fade-in slide-in-from-bottom-2">
        {/* Status indicator */}
        <span className="relative flex h-3 w-3 shrink-0">
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-full ${
              isRecording ? "bg-destructive opacity-75" : "bg-primary opacity-40"
            }`}
          ></span>
          <span
            className={`relative inline-flex rounded-full h-3 w-3 ${
              isRecording ? "bg-destructive" : "bg-primary"
            }`}
          ></span>
        </span>

        {/* Live Timer or Standby */}
        <span className="font-mono text-sm font-semibold text-foreground tracking-wider">
          {isRecording ? formatTimer(elapsedSeconds) : "Standby"}
        </span>

        {/* Meeting title preview */}
        <span className="text-xs text-muted-foreground max-w-40 truncate hidden sm:inline-block font-medium">
          {title || "Meeting"}
        </span>

        {/* Mini waveform bars */}
        {isRecording && (
          <div className="flex items-center gap-0.5 h-4 px-1">
            {[1, 2, 3, 4].map((i) => {
              const h = Math.max(4, Math.min(16, (audioLevel / 100) * 16 * (i % 2 === 0 ? 1.2 : 0.8)));
              return (
                <div
                  key={i}
                  className="w-1 bg-primary rounded-full transition-all duration-75"
                  style={{ height: `${h}px` }}
                />
              );
            })}
          </div>
        )}

        {/* Shortcut Action Buttons */}
        <div className="flex items-center gap-1.5 border-l border-border/60 pl-2">
          {isRecording && (
            <Button
              size="sm"
              variant="destructive"
              className="h-7 px-2.5 text-xs gap-1 font-medium"
              onClick={stopRecording}
              disabled={isProcessing}
            >
              {isProcessing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Square className="h-3 w-3 fill-current" />
              )}
              Selesai
            </Button>
          )}

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground"
            onClick={() => setIsMinimized(false)}
            title="Perbesar Panel Rekaman"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  // Render Full Right Drawer (Non-blocking: no backdrop overlay)
  return (
    <div className="fixed top-0 right-0 h-full w-96 z-40 bg-card border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
      {/* Drawer Header */}
      <div className="flex items-center justify-between p-4 border-b border-border/60 bg-muted/20">
        <div className="flex items-center gap-2">
          {isRecording ? (
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-destructive"></span>
            </span>
          ) : (
            <Mic className="h-4 w-4 text-primary" />
          )}
          <span className="font-semibold text-sm text-foreground">
            {isRecording ? "Live Meeting Recorder" : "Mulai Rapat Baru"}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setIsMinimized(true)}
            title="Minimize ke Shortcut Pill"
          >
            <Minus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={closeRecorder}
            title="Tutup / Batal"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Drawer Body */}
      <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
        {errorMessage && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive flex items-start gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Title input */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Judul Meeting</label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isRecording || isProcessing}
            placeholder="Misal: Sprint Planning & Sync Data..."
            className="h-9 text-sm"
          />
        </div>

        {/* Audio Visualizer & Timer Area */}
        <div className="flex flex-col items-center justify-center p-6 rounded-xl border border-border/60 bg-muted/30 gap-4">
          <div
            className={`flex h-16 w-16 items-center justify-center rounded-full transition-all duration-300 ${
              isRecording
                ? "bg-destructive/10 text-destructive scale-105"
                : "bg-primary/10 text-primary"
            }`}
          >
            {isRecording ? (
              <Radio className="h-8 w-8 animate-pulse text-destructive" />
            ) : (
              <Mic className="h-8 w-8 text-primary" />
            )}
          </div>

          <div className="flex flex-col items-center gap-1">
            <span className="font-mono text-3xl font-bold tracking-wider text-foreground">
              {formatTimer(elapsedSeconds)}
            </span>
            <span className="text-xs text-muted-foreground font-medium">
              {isRecording
                ? "SEDANG MEREKAM & TRANSCRIBE"
                : "Mikrofon siap untuk merekam"}
            </span>
          </div>

          {/* Dynamic Audio Level Meter */}
          {isRecording && (
            <div className="w-full flex flex-col gap-1.5 items-center">
              <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-primary h-full rounded-full transition-all duration-75"
                  style={{ width: `${Math.max(5, audioLevel)}%` }}
                />
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Volume2 className="h-3 w-3" />
                <span>Level input audio</span>
              </div>
            </div>
          )}
        </div>

        {/* Direct link to meeting detail while recording */}
        {isRecording && currentMeeting && (
          <div className="p-3 rounded-lg border border-primary/20 bg-primary/5 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Ingin chat atau melihat transkrip penuh?
            </span>
            <button
              onClick={() => {
                setIsMinimized(true);
                const targetPath = selectedCompany?.issuePrefix
                  ? `/${selectedCompany.issuePrefix}/meetings/${currentMeeting.id}`
                  : `/meetings/${currentMeeting.id}`;
                navigate(targetPath);
              }}
              className="text-xs font-semibold text-primary hover:underline flex items-center gap-1"
            >
              Buka Rapat <ExternalLink className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Live Copilot Analysis Insights */}
        {isRecording && (
          <div className="flex flex-col gap-2 p-3 rounded-lg border border-border/60 bg-card/60">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                Live Copilot Analysis
              </span>
              <span className="text-xs text-muted-foreground font-mono">
                {liveSegments.length > 0 ? "Analyzing" : "Listening..."}
              </span>
            </div>
            {liveInsights.length > 0 ? (
              <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                {liveInsights.map((insight, idx) => (
                  <div key={idx} className="flex items-start gap-1.5">
                    <span className="text-primary mt-0.5">•</span>
                    <span>{insight}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                {liveSegments.length > 0
                  ? "Menganalisis poin-poin utama percakapan secara langsung..."
                  : "Mulai berbicara, ringkasan percakapan dan topik akan dianalisis secara real-time."}
              </p>
            )}
          </div>
        )}

        {/* Live Segments Feed Preview */}
        {isRecording && liveSegments.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Transkrip Masuk ({liveSegments.length} segmen)
            </span>
            <div className="max-h-44 overflow-y-auto flex flex-col gap-2 p-2.5 rounded-lg border border-border/50 bg-muted/20 text-xs">
              {liveSegments.slice(-4).map((seg, i) => (
                <div key={i} className="flex flex-col gap-0.5">
                  <span className="font-semibold text-primary">{seg.speaker}:</span>
                  <span className="text-foreground/90">{seg.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Drawer Footer Actions */}
      <div className="p-4 border-t border-border/60 bg-muted/10 flex items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={closeRecorder}
          disabled={isProcessing}
          className="text-xs"
        >
          Batal
        </Button>

        {!isRecording ? (
          <Button
            size="sm"
            onClick={startRecording}
            disabled={isProcessing}
            className="gap-2 text-xs"
          >
            {isProcessing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Menyiapkan...
              </>
            ) : (
              <>
                <Mic className="h-3.5 w-3.5" />
                Mulai Merekam
              </>
            )}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="destructive"
            onClick={stopRecording}
            disabled={isProcessing}
            className="gap-2 text-xs"
          >
            {isProcessing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Menyimpan...
              </>
            ) : (
              <>
                <Square className="h-3.5 w-3.5 fill-current" />
                Selesai Rapat
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
