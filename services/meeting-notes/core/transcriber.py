import logging
import requests
from pathlib import Path
from typing import Dict, Any, Optional, List
from config import Config

logger = logging.getLogger("transcriber")

class Transcriber:
    def __init__(self):
        self.primary_url = Config.PRIMARY_STT_URL
        self.primary_key = Config.PRIMARY_STT_KEY
        self.primary_model = Config.PRIMARY_STT_MODEL
        
        self.fallback_url = Config.FALLBACK_STT_URL
        self.fallback_key = Config.FALLBACK_STT_KEY
        self.fallback_model = Config.FALLBACK_STT_MODEL
        
    def transcribe(self, wav_path: Path, language: str = "id", prompt: Optional[str] = None, response_format: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Transcribes a WAV file using Primary STT with automatic fallback."""
        if not wav_path.exists() or wav_path.stat().st_size == 0:
            return None
            
        # Try Primary STT
        try:
            res = self._call_stt(self.primary_url, self.primary_key, self.primary_model, wav_path, language, prompt=prompt, response_format=response_format)
            if res and (res.get("text") or res.get("segments")):
                return res
        except Exception as e:
            logger.warning(f"Primary STT ({self.primary_url}) failed: {e}. Trying fallback...")
            
        # Try Fallback STT
        try:
            res = self._call_stt(self.fallback_url, self.fallback_key, self.fallback_model, wav_path, language, prompt=prompt, response_format=response_format)
            if res and (res.get("text") or res.get("segments")):
                return res
        except Exception as e:
            logger.error(f"Fallback STT ({self.fallback_url}) also failed: {e}")
            
        return None

    def _call_stt(self, url: str, api_key: str, model: str, wav_path: Path, language: str, prompt: Optional[str] = None, response_format: Optional[str] = None) -> Optional[Dict[str, Any]]:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "curl/8.7.1",
        }
        with open(wav_path, "rb") as f:
            files = {
                "file": (wav_path.name, f, "audio/wav")
            }
            data = {
                "model": model,
                "language": language
            }
            if response_format:
                data["response_format"] = response_format
            if prompt:
                data["prompt"] = prompt[-500:]
            resp = requests.post(url, headers=headers, files=files, data=data, timeout=60)
            if resp.status_code != 200:
                logger.error(f"STT Error {resp.status_code} from {url}: {resp.text}")
                return None
            return resp.json()

    def transcribe_file_to_segments(self, wav_path: Path, language: str = "id") -> List[Dict[str, Any]]:
        """Transcribes a full audio file into timed transcript segments with automatic chunking for long files."""
        from core.audio_processor import audio_processor

        if not wav_path.exists() or wav_path.stat().st_size == 0:
            return []

        duration = audio_processor.get_duration(wav_path)
        if duration <= 0.2:
            return []

        file_size = wav_path.stat().st_size
        max_chunk_sec = 300.0  # 5 minutes per chunk

        # Short file: transcribe directly
        if duration <= max_chunk_sec and file_size <= 20 * 1024 * 1024:
            res = self.transcribe(wav_path, language=language, response_format="verbose_json")
            if res:
                raw_segs = res.get("segments") or []
                if raw_segs:
                    return [
                        {
                            "start_seconds": round(float(s.get("start", 0.0)), 2),
                            "end_seconds": round(float(s.get("end", s.get("start", 0.0) + 1.0)), 2),
                            "text": s.get("text", "").strip(),
                            "confidence": float(s.get("avg_logprob", 0.9)),
                        }
                        for s in raw_segs
                        if s.get("text", "").strip()
                    ]
                full_text = res.get("text", "").strip()
                if full_text:
                    return [{
                        "start_seconds": 0.0,
                        "end_seconds": round(duration, 2),
                        "text": full_text,
                        "confidence": 0.9,
                    }]

        # Longer file: slice and transcribe each chunk
        all_segments: List[Dict[str, Any]] = []
        curr_offset = 0.0
        tmp_slice = wav_path.parent / f"tmp_slice_{wav_path.stem}.wav"

        while curr_offset < duration:
            chunk_dur = min(max_chunk_sec, duration - curr_offset)
            if chunk_dur < 0.3:
                break

            ok = audio_processor.extract_wav_slice(
                wav_path, tmp_slice, start_seconds=curr_offset, duration_seconds=chunk_dur
            )
            if ok and tmp_slice.exists():
                res = self.transcribe(tmp_slice, language=language, response_format="verbose_json")
                if res:
                    raw_segs = res.get("segments") or []
                    if raw_segs:
                        for s in raw_segs:
                            t = s.get("text", "").strip()
                            if t:
                                all_segments.append({
                                    "start_seconds": round(curr_offset + float(s.get("start", 0.0)), 2),
                                    "end_seconds": round(curr_offset + float(s.get("end", s.get("start", 0.0) + 1.0)), 2),
                                    "text": t,
                                    "confidence": float(s.get("avg_logprob", 0.9)),
                                })
                    elif res.get("text", "").strip():
                        all_segments.append({
                            "start_seconds": round(curr_offset, 2),
                            "end_seconds": round(curr_offset + chunk_dur, 2),
                            "text": res.get("text", "").strip(),
                            "confidence": 0.9,
                        })

            curr_offset += chunk_dur

        if tmp_slice.exists():
            try:
                tmp_slice.unlink()
            except Exception:
                pass

        return all_segments

transcriber = Transcriber()

