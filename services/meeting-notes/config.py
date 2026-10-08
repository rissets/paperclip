import os
import shutil
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent

class Config:
    HOST = os.getenv("MEETING_SERVICE_HOST", "0.0.0.0")
    PORT = int(os.getenv("MEETING_SERVICE_PORT", "5001"))
    DEBUG = os.getenv("MEETING_SERVICE_DEBUG", "false").lower() == "true"
    
    # Storage
    STORAGE_DIR = Path(os.getenv("MEETING_STORAGE_DIR", str(BASE_DIR / "storage")))
    RECORDINGS_DIR = STORAGE_DIR / "recordings"
    CHUNKS_DIR = STORAGE_DIR / "chunks"
    DB_PATH = STORAGE_DIR / "meetings.db"
    
    # FFmpeg executable
    FFMPEG_PATH = os.getenv("FFMPEG_PATH") or shutil.which("ffmpeg") or ("/opt/homebrew/bin/ffmpeg" if os.path.exists("/opt/homebrew/bin/ffmpeg") else "ffmpeg")
    
    # Primary STT (Hellodigi Whisper Large v3 Turbo ~700ms)
    PRIMARY_STT_URL = os.getenv("PRIMARY_STT_URL", "https://llm-v1.hellodigi.id/v1/audio/transcriptions")
    PRIMARY_STT_KEY = os.getenv("PRIMARY_STT_KEY", "fe85e354c928821e4e01242b3a8624ce1268b7bd683a439771a723d79ede56f5")
    PRIMARY_STT_MODEL = os.getenv("PRIMARY_STT_MODEL", "openai/whisper-large-v3-turbo")
    
    # Fallback STT (OmniRoute / Router Rissets)
    FALLBACK_STT_URL = os.getenv("FALLBACK_STT_URL", "https://router.rissets.com/v1/audio/transcriptions")
    FALLBACK_STT_KEY = os.getenv("FALLBACK_STT_KEY", "sk-f874f548c166ae39-b8b98d-c8e05721")
    FALLBACK_STT_MODEL = os.getenv("FALLBACK_STT_MODEL", "openai/whisper-large-v3-turbo")

    # LLM for Real-time Meeting Analysis & Summarization (Fast primary via router.rissets.com, fallback to hellodigi)
    LLM_API_URL = os.getenv("MEETING_LLM_URL", "https://router.rissets.com/v1/chat/completions")
    LLM_API_KEY = os.getenv("MEETING_LLM_KEY", "sk-f874f548c166ae39-b8b98d-c8e05721")
    LLM_MODEL = os.getenv("MEETING_LLM_MODEL", "neural/qwen-3.8-27b-none")
    
    FALLBACK_LLM_URL = os.getenv("FALLBACK_LLM_URL", "https://llm-v1.hellodigi.id/v1/chat/completions")
    FALLBACK_LLM_KEY = os.getenv("FALLBACK_LLM_KEY", "fe85e354c928821e4e01242b3a8624ce1268b7bd683a439771a723d79ede56f5")
    FALLBACK_LLM_MODEL = os.getenv("FALLBACK_LLM_MODEL", "Qwen/Qwen3.8-27B")

# Ensure storage directories exist
Config.STORAGE_DIR.mkdir(parents=True, exist_ok=True)
Config.RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
Config.CHUNKS_DIR.mkdir(parents=True, exist_ok=True)
