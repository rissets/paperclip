import os
from flask import Blueprint, jsonify
from config import Config
from core.audio_processor import audio_processor

health_bp = Blueprint("health", __name__)

@health_bp.route("/health", methods=["GET"])
@health_bp.route("/api/health", methods=["GET"])
def health_check():
    ffmpeg_available = False
    try:
        import subprocess
        res = subprocess.run([Config.FFMPEG_PATH, "-version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        ffmpeg_available = res.returncode == 0
    except Exception:
        ffmpeg_available = False
        
    storage_writable = Config.STORAGE_DIR.exists() and os.access(Config.STORAGE_DIR, os.W_OK)

    return jsonify({
        "status": "healthy",
        "service": "paperclip-meeting-service",
        "ffmpeg_available": ffmpeg_available,
        "ffmpeg_path": Config.FFMPEG_PATH,
        "storage_writable": storage_writable,
        "primary_stt_url": Config.PRIMARY_STT_URL,
        "primary_stt_model": Config.PRIMARY_STT_MODEL,
        "fallback_stt_url": Config.FALLBACK_STT_URL,
        "fallback_stt_model": Config.FALLBACK_STT_MODEL,
    })
