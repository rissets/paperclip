import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Mic, MicOff, Square, Loader2, Radio } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/context/CompanyContext";
import { meetingsApi, type Meeting } from "@/api/meetings";

interface MeetingRecorderModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMeetingCreated?: (meeting: Meeting) => void;
}

export function MeetingRecorderModal({ open, onOpenChange, onMeetingCreated }: MeetingRecorderModalProps) {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();

  const [title, setTitle] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const currentMeetingRef = useRef<Meeting | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (open) {
      const now = new Date();
      const dateStr = now.toLocaleDateString("id-ID", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      setTitle(`Meeting - ${dateStr}`);
      setElapsedSeconds(0);
      setAudioLevel(0);
      setErrorMessage(null);
      setIsRecording(false);
      setIsProcessing(false);
      recordedChunksRef.current = [];
    } else {
      cleanupAudio();
    }
    return () => {
      cleanupAudio();
    };
  }, [open]);

  const cleanupAudio = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
  };

  const startVisualizer = (stream: MediaStream) => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioCtx;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyserRef.current = analyser;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const updateVolume = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        const normalized = Math.min(100, Math.round((average / 128) * 100));
        setAudioLevel(normalized);
        animationFrameRef.current = requestAnimationFrame(updateVolume);
      };

      updateVolume();
    } catch {
      // Visualizer is optional
    }
  };

  const handleStartRecording = async () => {
    if (!selectedCompanyId) return;
    setErrorMessage(null);
    setIsProcessing(true);

    try {
      // 1. Create meeting session
      const meeting = await meetingsApi.create(selectedCompanyId, {
        title: title.trim() || "Untitled Meeting",
      });
      currentMeetingRef.current = meeting;

      // 2. Request microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      mediaStreamRef.current = stream;

      // 3. Connect live WebSocket if available
      try {
        const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${wsProto}//${window.location.hostname}:5001/ws/meetings/${meeting.id}/stream`;
        const ws = new WebSocket(wsUrl);
        socketRef.current = ws;
      } catch {
        // WebSocket fallback to chunk upload
      }

      // 4. Setup MediaRecorder with 3-second slices
      recordedChunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
          if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
            const arrayBuffer = await e.data.arrayBuffer();
            socketRef.current.send(arrayBuffer);
          }
        }
      };

      recorder.start(3000); // 3 second timeslice
      startVisualizer(stream);

      // 5. Start elapsed timer
      setIsRecording(true);
      setIsProcessing(false);
      setElapsedSeconds(0);
      timerIntervalRef.current = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      cleanupAudio();
      setIsProcessing(false);
      setIsRecording(false);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setErrorMessage("Akses mikrofon ditolak. Izinkan izin mikrofon di pengaturan browser Anda.");
      } else {
        setErrorMessage(`Gagal memulai rekaman: ${err.message || String(err)}`);
      }
    }
  };

  const handleStopRecording = async () => {
    if (!selectedCompanyId || !currentMeetingRef.current) return;
    setIsRecording(false);
    setIsProcessing(true);

    const meeting = currentMeetingRef.current;

    // Send EOS (End of Stream) over WebSocket if open
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send("__EOS__");
      socketRef.current.close();
      socketRef.current = null;
    }

    // Stop tracks
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }

    cleanupAudio();

    try {
      // If we have recorded chunks, ensure full upload
      if (recordedChunksRef.current.length > 0) {
        const fullBlob = new Blob(recordedChunksRef.current, {
          type: recordedChunksRef.current[0]?.type || "audio/webm",
        });
        const file = new File([fullBlob], `recording-${meeting.id}.webm`, {
          type: fullBlob.type,
        });
        await meetingsApi.uploadAudio(selectedCompanyId, meeting.id, file);
      } else {
        await meetingsApi.finish(selectedCompanyId, meeting.id);
      }

      onOpenChange(false);
      if (onMeetingCreated) {
        onMeetingCreated(meeting);
      }
      navigate(`/meetings/${meeting.id}`);
    } catch (err: any) {
      setErrorMessage(`Gagal memproses rekaman: ${err.message || String(err)}`);
      setIsProcessing(false);
    }
  };

  const formatTimer = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Radio className="h-5 w-5 text-primary animate-pulse" />
            Live Meeting Recorder
          </DialogTitle>
          <DialogDescription>
            Rekam audio rapat secara realtime dengan transkripsi otomatis dan ekstraksi catatan kecerdasan.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {errorMessage && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              {errorMessage}
            </div>
          )}

          {!isRecording ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="meeting-title">Judul Meeting</Label>
              <Input
                id="meeting-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="cth. Sprint Planning Q3, Review Arsitektur"
                disabled={isProcessing}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-border bg-muted/40 p-6 text-center">
              <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-destructive/20 text-destructive">
                <Mic className="h-8 w-8 animate-pulse" />
                <span className="absolute inset-0 rounded-full border-2 border-destructive animate-ping opacity-25" />
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-2xl font-bold font-mono tracking-wider">
                  {formatTimer(elapsedSeconds)}
                </span>
                <span className="text-xs text-muted-foreground uppercase font-semibold">
                  Sedang Merekam & Transcribe
                </span>
              </div>

              {/* Real-time audio waveform level visualizer */}
              <div className="flex items-center gap-1 h-6">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((idx) => {
                  const active = audioLevel >= idx * 10;
                  return (
                    <div
                      key={idx}
                      className={`w-1 rounded-full transition-all duration-75 ${
                        active ? "h-6 bg-primary" : "h-1.5 bg-muted-foreground/30"
                      }`}
                    />
                  );
                })}
              </div>

              <div className="text-xs text-muted-foreground">
                Judul: <span className="font-medium text-foreground">{title}</span>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex flex-row justify-between sm:justify-between items-center w-full">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isProcessing}
          >
            Batal
          </Button>

          {!isRecording ? (
            <Button
              onClick={handleStartRecording}
              disabled={isProcessing}
              className="gap-2"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Menyiapkan...
                </>
              ) : (
                <>
                  <Mic className="h-4 w-4" />
                  Mulai Merekam
                </>
              )}
            </Button>
          ) : (
            <Button
              variant="destructive"
              onClick={handleStopRecording}
              disabled={isProcessing}
              className="gap-2"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Menyimpan...
                </>
              ) : (
                <>
                  <Square className="h-4 w-4" />
                  Selesai & Proses
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
