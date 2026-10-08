import logging
import uuid
import json
import threading
import concurrent.futures
from pathlib import Path
from typing import Dict, Any, Optional, List, Callable
from config import Config
from core.audio_processor import audio_processor
from core.transcriber import transcriber
from core.analyzer import analyzer
from models.schema import (
    get_meeting,
    update_meeting,
    add_transcript_segment
)

logger = logging.getLogger("live_stream_manager")

DEFAULT_WEBM_OPUS_HEADER = (
    b'\x1aE\xdf\xa3\x9fB\x86\x81\x01B\xf7\x81\x01B\xf2\x81\x04B\xf3\x81\x08B\x82\x84webm'
    b'B\x87\x81\x04B\x85\x81\x02\x18S\x80g\x01\xff\xff\xff\xff\xff\xff\xff\x15I\xa9f\x99'
    b'*\xd7\xb1\x83\x0fB@M\x80\x86ChromeWA\x86Chrome\x16T\xaek\xbe\xae\xbc\xd7\x81\x01'
    b's\xc5\x86\xbb\xed\x10\xee\xac\xe6\x83\x81\x02\x86\x86A_OPUSc\xa2\x93OpusHead\x01\x01'
    b'\x00\x00\x80\xbb\x00\x00\x00\x00\x00\xe1\x8d\xb5\x84G;\x80\x00\x9f\x81\x01bd\x81 '
)

def deduplicate_overlap(prev_text: Optional[str], current_text: str) -> str:
    """Removes overlapping boundary words at the start of current_text matching the end of prev_text."""
    if not prev_text or not current_text:
        return current_text.strip()
    prev_words = prev_text.strip().lower().split()
    curr_words = current_text.strip().split()
    if not prev_words or not curr_words:
        return current_text.strip()

    # Check 4 down to 1 words overlap
    max_k = min(4, len(prev_words), len(curr_words))
    for k in range(max_k, 0, -1):
        prev_tail = [w.strip(".,!?:;\"'()[]{}") for w in prev_words[-k:]]
        curr_head = [w.strip(".,!?:;\"'()[]{}").lower() for w in curr_words[:k]]
        if prev_tail == curr_head:
            remaining = curr_words[k:]
            return " ".join(remaining).strip()

    return current_text.strip()

class LiveMeetingSession:
    def __init__(self, meeting_id: str, ws_callback: Optional[Callable[[Dict[str, Any]], None]] = None):
        self.meeting_id = meeting_id
        self.chunk_index = 0
        self.current_time_offset = 0.0
        self.accumulated_raw_path = Config.CHUNKS_DIR / f"{self.meeting_id}_accumulated.webm"
        self.segments: List[Dict[str, Any]] = []
        self.last_analysis: Optional[Dict[str, Any]] = None
        self.ws_callback = ws_callback

        # Asynchronous background analysis worker
        self._analysis_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self._is_analyzing = False
        self._analysis_lock = threading.Lock()
        self._pending_analysis = False
        self._last_analyzed_count = 0

        if self.accumulated_raw_path.exists():
            try:
                self.accumulated_raw_path.unlink()
            except Exception:
                pass

    def set_ws_callback(self, cb: Callable[[Dict[str, Any]], None]):
        self.ws_callback = cb

    def _trigger_background_analysis(self):
        """Dispatches live analysis in background thread without blocking audio processing."""
        # Trigger on first segment, or every 2 new segments
        if len(self.segments) == 1 or (len(self.segments) - self._last_analyzed_count >= 2):
            with self._analysis_lock:
                if self._is_analyzing:
                    self._pending_analysis = True
                    return
                self._is_analyzing = True
                self._pending_analysis = False
                self._analysis_executor.submit(self._run_analysis_worker)

    def _run_analysis_worker(self):
        try:
            segments_snapshot = list(self.segments)
            self._last_analyzed_count = len(segments_snapshot)
            analysis = analyzer.analyze_segments(self.meeting_id, segments_snapshot)
            if analysis:
                self.last_analysis = analysis
                if self.ws_callback:
                    try:
                        self.ws_callback(analysis)
                    except Exception as e:
                        logger.warning(f"Error in ws_callback: {e}")
        except Exception as e:
            logger.warning(f"Error in background analyzer worker: {e}")
        finally:
            with self._analysis_lock:
                self._is_analyzing = False
                if self._pending_analysis:
                    self._pending_analysis = False
                    self._analysis_executor.submit(self._run_analysis_worker)

    def process_audio_chunk(self, audio_bytes: bytes) -> Optional[Dict[str, Any]]:
        """Processes an incoming raw audio slice from the browser in real time (<0.5s latency)."""
        if not audio_bytes or len(audio_bytes) < 200:
            return None
            
        self.chunk_index += 1
        
        # 1. Append bytes to the continuous accumulated WebM stream
        file_is_new = not self.accumulated_raw_path.exists() or self.accumulated_raw_path.stat().st_size == 0
        if file_is_new:
            has_ebml = b'\x1a\x45\xdf\xa3' in audio_bytes[:512]
            has_mp4 = b'ftyp' in audio_bytes[:512]
            with open(self.accumulated_raw_path, "wb") as f:
                if not has_ebml and not has_mp4:
                    logger.info(f"Injecting standard WebM Opus header for meeting {self.meeting_id}")
                    f.write(DEFAULT_WEBM_OPUS_HEADER)
                f.write(audio_bytes)
                f.flush()
        else:
            with open(self.accumulated_raw_path, "ab") as f:
                f.write(audio_bytes)
                f.flush()
            
        wav_chunk_path = Config.CHUNKS_DIR / f"{self.meeting_id}_{self.chunk_index:04d}.wav"
        
        # 2. Extract slice with 0.6s lookback overlap to prevent clipping word boundaries
        lookback = 0.6 if self.current_time_offset > 0.6 else 0.0
        slice_start = max(0.0, self.current_time_offset - lookback)
        
        ok = audio_processor.extract_wav_slice(
            input_path=self.accumulated_raw_path,
            output_path=wav_chunk_path,
            start_seconds=slice_start
        )
        if not ok or not wav_chunk_path.exists():
            return None
            
        actual_slice_duration = audio_processor.get_duration(wav_chunk_path)
        new_audio_duration = actual_slice_duration - lookback
        
        # Need at least 1.2s of newly accumulated audio to transcribe
        if new_audio_duration < 1.2:
            try:
                wav_chunk_path.unlink()
            except Exception:
                pass
            return None
            
        start_sec = round(self.current_time_offset, 2)
        end_sec = round(self.current_time_offset + new_audio_duration, 2)
        self.current_time_offset = end_sec
        
        # 3. Transcribe slice with previous segment text as context prompt
        prev_prompt = self.segments[-1]["text"] if self.segments else None
        stt_result = transcriber.transcribe(wav_chunk_path, language="id", prompt=prev_prompt)
        
        # Clean up chunk wav file
        try:
            if wav_chunk_path.exists():
                wav_chunk_path.unlink()
        except Exception:
            pass
            
        if stt_result and stt_result.get("text"):
            raw_text = stt_result["text"].strip()
            # Deduplicate boundary overlap words
            text = deduplicate_overlap(prev_prompt, raw_text)
            
            # Filter out empty or hallucinated noise tokens
            if text and text not in [".", "...", "Terima kasih.", "Terima kasih", "Thank you.", "Thank you"]:
                segment = add_transcript_segment(
                    meeting_id=self.meeting_id,
                    text=text,
                    start_seconds=start_sec,
                    end_seconds=end_sec,
                    speaker="Speaker 1"
                )
                self.segments.append(segment)
                
                # 4. Trigger asynchronous live analysis (non-blocking)
                self._trigger_background_analysis()

                return {
                    "segment": segment,
                    "analysis": self.last_analysis
                }
                
        return None

    def finalize(self) -> Optional[Path]:
        """Finalizes recording file from accumulated stream."""
        if not self.accumulated_raw_path.exists() or self.accumulated_raw_path.stat().st_size == 0:
            return None
            
        final_audio_path = Config.RECORDINGS_DIR / f"{self.meeting_id}.wav"
        ok = audio_processor.convert_to_wav_16k(self.accumulated_raw_path, final_audio_path)
        
        total_duration = audio_processor.get_duration(final_audio_path)
        if total_duration <= 0.0:
            total_duration = self.current_time_offset
            
        # Shutdown background worker pool
        try:
            self._analysis_executor.shutdown(wait=False)
        except Exception:
            pass

        # Ensure final analytical summary is saved
        final_summary_str = None
        if self.last_analysis:
            final_summary_str = json.dumps(self.last_analysis, ensure_ascii=False)
        elif self.segments:
            try:
                final_analysis = analyzer.analyze_segments(self.meeting_id, self.segments)
                final_summary_str = json.dumps(final_analysis, ensure_ascii=False)
            except Exception as e:
                logger.warning(f"Failed finalizing analysis: {e}")

        chosen_path = final_audio_path if (ok and final_audio_path.exists()) else self.accumulated_raw_path
        update_meeting(
            self.meeting_id,
            audio_path=str(chosen_path),
            duration_seconds=total_duration,
            status="completed",
            summary=final_summary_str
        )
        return chosen_path

class LiveStreamManager:
    def __init__(self):
        self.sessions: Dict[str, LiveMeetingSession] = {}

    def get_or_create_session(self, meeting_id: str, ws_callback: Optional[Callable[[Dict[str, Any]], None]] = None) -> LiveMeetingSession:
        if meeting_id not in self.sessions:
            self.sessions[meeting_id] = LiveMeetingSession(meeting_id, ws_callback=ws_callback)
            update_meeting(meeting_id, status="recording")
        elif ws_callback:
            self.sessions[meeting_id].set_ws_callback(ws_callback)
        return self.sessions[meeting_id]

    def close_session(self, meeting_id: str) -> Optional[Path]:
        session = self.sessions.pop(meeting_id, None)
        if session:
            return session.finalize()
        return None

live_stream_manager = LiveStreamManager()
