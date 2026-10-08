import logging
import requests
from pathlib import Path
from typing import Dict, Any, Optional
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
        
    def transcribe(self, wav_path: Path, language: str = "id", prompt: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Transcribes a WAV file using Primary STT with automatic fallback."""
        if not wav_path.exists() or wav_path.stat().st_size == 0:
            return None
            
        # Try Primary STT
        try:
            res = self._call_stt(self.primary_url, self.primary_key, self.primary_model, wav_path, language, prompt=prompt)
            if res and res.get("text"):
                return res
        except Exception as e:
            logger.warning(f"Primary STT ({self.primary_url}) failed: {e}. Trying fallback...")
            
        # Try Fallback STT
        try:
            res = self._call_stt(self.fallback_url, self.fallback_key, self.fallback_model, wav_path, language, prompt=prompt)
            if res and res.get("text"):
                return res
        except Exception as e:
            logger.error(f"Fallback STT ({self.fallback_url}) also failed: {e}")
            
        return None

    def _call_stt(self, url: str, api_key: str, model: str, wav_path: Path, language: str, prompt: Optional[str] = None) -> Optional[Dict[str, Any]]:
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
            if prompt:
                data["prompt"] = prompt[-500:]
            resp = requests.post(url, headers=headers, files=files, data=data, timeout=30)
            if resp.status_code != 200:
                logger.error(f"STT Error {resp.status_code} from {url}: {resp.text}")
                return None
            return resp.json()

transcriber = Transcriber()
