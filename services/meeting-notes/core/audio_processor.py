import subprocess
import os
import json
import logging
from pathlib import Path
from typing import Optional, List
from config import Config

logger = logging.getLogger("audio_processor")

class AudioProcessor:
    def __init__(self, ffmpeg_bin: str = Config.FFMPEG_PATH):
        self.ffmpeg_bin = ffmpeg_bin
        
    def convert_to_wav_16k(self, input_path: Path, output_path: Path) -> bool:
        """Converts any audio file to 16000Hz mono WAV (optimal for Whisper)."""
        cmd = [
            self.ffmpeg_bin,
            "-y",
            "-i", str(input_path),
            "-ar", "16000",
            "-ac", "1",
            "-c:a", "pcm_s16le",
            str(output_path)
        ]
        try:
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
            return True
        except subprocess.CalledProcessError as e:
            logger.error(f"FFmpeg conversion error: {e.stderr.decode('utf-8', errors='ignore')}")
            return False

    def extract_wav_slice(self, input_path: Path, output_path: Path, start_seconds: float = 0.0, duration_seconds: Optional[float] = None) -> bool:
        """Extracts a slice starting from start_seconds, converting to 16kHz mono WAV."""
        cmd = [
            self.ffmpeg_bin,
            "-y",
            "-ss", f"{start_seconds:.2f}",
            "-i", str(input_path),
        ]
        if duration_seconds is not None and duration_seconds > 0:
            cmd.extend(["-t", f"{duration_seconds:.2f}"])
        cmd.extend([
            "-ar", "16000",
            "-ac", "1",
            "-c:a", "pcm_s16le",
            str(output_path)
        ])
        try:
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
            return True
        except subprocess.CalledProcessError as e:
            err_text = e.stderr.decode('utf-8', errors='ignore')
            err_lines = [
                l.strip() for l in err_text.splitlines() 
                if l.strip() and not l.startswith("configuration:") and not l.startswith("built with") and not l.startswith("ffmpeg version")
            ]
            last_err = err_lines[-1] if err_lines else "unknown error"
            logger.error(f"FFmpeg extract slice error: {last_err}")
            return False

    def concatenate_chunks(self, chunk_paths: List[Path], output_path: Path) -> bool:
        """Concatenates multiple audio chunk files into a single audio file."""
        if not chunk_paths:
            return False
            
        list_file = output_path.parent / f"concat_list_{output_path.stem}.txt"
        with open(list_file, "w") as f:
            for p in chunk_paths:
                f.write(f"file '{p.resolve()}'\n")
                
        cmd = [
            self.ffmpeg_bin,
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", str(list_file),
            "-c:a", "aac",
            "-b:a", "128k",
            str(output_path)
        ]
        try:
            subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
            if list_file.exists():
                list_file.unlink()
            return True
        except subprocess.CalledProcessError as e:
            logger.error(f"FFmpeg concat error: {e.stderr.decode('utf-8', errors='ignore')}")
            if list_file.exists():
                list_file.unlink()
            return False

    def get_duration(self, audio_path: Path) -> float:
        """Gets duration in seconds using WAV size math, ffprobe, or ffmpeg."""
        if not audio_path.exists() or audio_path.stat().st_size == 0:
            return 0.0
            
        # 0. Fast exact math for 16kHz 16-bit mono WAV
        if audio_path.suffix.lower() == ".wav":
            size = audio_path.stat().st_size
            if size > 44:
                return round((size - 44) / 32000.0, 2)
            return 0.0

        # 1. Try ffprobe first
        try:
            cmd = [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(audio_path)
            ]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            out = res.stdout.decode("utf-8").strip()
            if out and out != "N/A":
                dur = float(out)
                if dur > 0:
                    return dur
        except Exception:
            pass

        # 2. Fallback to ffmpeg -i parsing
        cmd = [
            self.ffmpeg_bin,
            "-i", str(audio_path)
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stderr = res.stderr.decode("utf-8", errors="ignore")
        for line in stderr.splitlines():
            if "Duration:" in line and "N/A" not in line:
                try:
                    dur_str = line.split("Duration:")[1].split(",")[0].strip()
                    parts = dur_str.split(":")
                    if len(parts) == 3:
                        hours = float(parts[0])
                        minutes = float(parts[1])
                        seconds = float(parts[2])
                        return hours * 3600 + minutes * 60 + seconds
                except Exception:
                    pass
        return 0.0

audio_processor = AudioProcessor()
