import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import { useNavigate } from "@/lib/router";
import { useCompany } from "./CompanyContext";
import { meetingsApi, type Meeting, type TranscriptSegment } from "@/api/meetings";

interface MeetingRecorderContextValue {
  isOpen: boolean;
  isMinimized: boolean;
  isRecording: boolean;
  isProcessing: boolean;
  currentMeeting: Meeting | null;
  title: string;
  setTitle: (title: string) => void;
  elapsedSeconds: number;
  audioLevel: number;
  liveSegments: TranscriptSegment[];
  liveInsights: string[];
  errorMessage: string | null;
  openRecorder: (initialTitle?: string) => void;
  closeRecorder: () => void;
  setIsMinimized: (minimized: boolean) => void;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelRecording: () => void;
}

const MeetingRecorderContext = createContext<MeetingRecorderContextValue | null>(null);

export function MeetingRecorderProvider({ children }: { children: ReactNode }) {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();

  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [title, setTitle] = useState("");
  const [currentMeeting, setCurrentMeeting] = useState<Meeting | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [liveSegments, setLiveSegments] = useState<TranscriptSegment[]>([]);
  const [liveInsights, setLiveInsights] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<any>(null);
  const currentMeetingRef = useRef<Meeting | null>(null);

  const cleanupAudio = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
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
      try {
        socketRef.current.close();
      } catch {}
      socketRef.current = null;
    }
    setAudioLevel(0);
  }, []);

  const startVisualizer = useCallback((stream: MediaStream) => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioCtx();
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
      // AudioContext fallback
    }
  }, []);

  const openRecorder = useCallback((initialTitle?: string) => {
    setTitle(
      initialTitle ||
        `Meeting - ${new Date().toLocaleDateString("id-ID", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })}, ${new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`
    );
    setErrorMessage(null);
    setIsOpen(true);
    setIsMinimized(false);
  }, []);

  const closeRecorder = useCallback(() => {
    if (isRecording) {
      const confirmClose = window.confirm("Rapat sedang direkam. Apakah Anda yakin ingin membatalkan rekaman?");
      if (!confirmClose) return;
    }
    cleanupAudio();
    setIsRecording(false);
    setIsProcessing(false);
    setIsOpen(false);
    setIsMinimized(false);
    setCurrentMeeting(null);
    currentMeetingRef.current = null;
    setLiveSegments([]);
    setLiveInsights([]);
  }, [isRecording, cleanupAudio]);

  const startRecording = useCallback(async () => {
    if (!selectedCompanyId) return;
    setErrorMessage(null);
    setIsProcessing(true);

    try {
      // 1. Create meeting session
      const meeting = await meetingsApi.create(selectedCompanyId, {
        title: title.trim() || "Untitled Meeting",
      });
      setCurrentMeeting(meeting);
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

      // 3. Connect live WebSocket
      const chunkBuffer: ArrayBuffer[] = [];

      try {
        const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${wsProto}//${window.location.hostname}:5001/ws/meetings/${meeting.id}/stream`;
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          while (chunkBuffer.length > 0) {
            const buf = chunkBuffer.shift();
            if (buf && ws.readyState === WebSocket.OPEN) {
              ws.send(buf);
            }
          }
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "segment" && msg.segment) {
              setLiveSegments((prev) => [...prev, msg.segment]);
              if (msg.analysis && Array.isArray(msg.analysis.insights) && msg.analysis.insights.length > 0) {
                setLiveInsights(msg.analysis.insights);
              } else if (msg.segment.text) {
                setLiveInsights((ins) => [
                  ...ins.slice(-2),
                  `Topik terdeteksi: "${msg.segment.text.slice(0, 60)}..."`,
                ]);
              }
            } else if (msg.type === "analysis" && msg.analysis) {
              if (Array.isArray(msg.analysis.insights) && msg.analysis.insights.length > 0) {
                setLiveInsights(msg.analysis.insights);
              }
            }
          } catch {
            // ignore non-json
          }
        };
        socketRef.current = ws;
      } catch {
        // WebSocket fallback
      }

      // 4. Setup MediaRecorder with 3-second timeslices
      recordedChunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
          const arrayBuffer = await e.data.arrayBuffer();
          if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
            while (chunkBuffer.length > 0) {
              const buf = chunkBuffer.shift();
              if (buf) socketRef.current.send(buf);
            }
            socketRef.current.send(arrayBuffer);
          } else {
            chunkBuffer.push(arrayBuffer);
          }
        }
      };

      recorder.start(3000);
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
      setErrorMessage(
        err.name === "NotAllowedError"
          ? "Izin mikrofon ditolak oleh browser. Mohon izinkan akses mikrofon di browser."
          : `Gagal memulai rekaman: ${err.message || String(err)}`
      );
    }
  }, [selectedCompanyId, title, startVisualizer, cleanupAudio]);

  const stopRecording = useCallback(async () => {
    if (!selectedCompanyId || !currentMeetingRef.current) return;
    const meeting = currentMeetingRef.current;
    setIsProcessing(true);

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      try {
        socketRef.current.send(JSON.stringify({ action: "finish" }));
      } catch {}
      socketRef.current.close();
      socketRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }

    cleanupAudio();

    try {
      if (recordedChunksRef.current.length > 0) {
        const fullBlob = new Blob(recordedChunksRef.current, {
          type: recordedChunksRef.current[0]?.type || "audio/webm",
        });

        if (fullBlob.size > 0) {
          const file = new File([fullBlob], `recording-${meeting.id}.webm`, {
            type: fullBlob.type,
          });
          await meetingsApi.uploadAudio(selectedCompanyId, meeting.id, file);
        } else {
          await meetingsApi.finish(selectedCompanyId, meeting.id);
        }
      } else {
        await meetingsApi.finish(selectedCompanyId, meeting.id);
      }

      setIsOpen(false);
      setIsMinimized(false);
      setIsRecording(false);
      setIsProcessing(false);
      setCurrentMeeting(null);
      currentMeetingRef.current = null;
      setLiveSegments([]);
      setLiveInsights([]);

      navigate(`/meetings/${meeting.id}`);
    } catch (err: any) {
      setErrorMessage(`Gagal memproses rekaman: ${err.message || String(err)}`);
      setIsProcessing(false);
    }
  }, [selectedCompanyId, cleanupAudio, navigate]);

  const cancelRecording = useCallback(() => {
    cleanupAudio();
    setIsRecording(false);
    setIsProcessing(false);
    setIsOpen(false);
    setIsMinimized(false);
    setCurrentMeeting(null);
    currentMeetingRef.current = null;
    setLiveSegments([]);
    setLiveInsights([]);
  }, [cleanupAudio]);

  return (
    <MeetingRecorderContext.Provider
      value={{
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
        openRecorder,
        closeRecorder,
        setIsMinimized,
        startRecording,
        stopRecording,
        cancelRecording,
      }}
    >
      {children}
    </MeetingRecorderContext.Provider>
  );
}

export function useMeetingRecorder() {
  const context = useContext(MeetingRecorderContext);
  if (!context) {
    throw new Error("useMeetingRecorder must be used within a MeetingRecorderProvider");
  }
  return context;
}
