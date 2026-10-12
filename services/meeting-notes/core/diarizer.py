import os
import wave
import sqlite3
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

import numpy as np
from scipy.fft import dct
from scipy.signal import correlate
from sklearn.cluster import AgglomerativeClustering, KMeans
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import silhouette_score

from config import Config
from models.schema import get_db_connection, update_meeting

logger = logging.getLogger("diarizer")


def build_mel_filterbank(sr: int = 16000, n_fft: int = 512, n_mels: int = 20) -> np.ndarray:
    """Constructs Mel-scale triangular filterbank matrix."""
    low_mel = 0.0
    high_mel = 2595.0 * np.log10(1.0 + (sr / 2.0) / 700.0)
    mel_points = np.linspace(low_mel, high_mel, n_mels + 2)
    hz_points = 700.0 * (10.0 ** (mel_points / 2595.0) - 1.0)
    bin_points = np.floor((n_fft + 1) * hz_points / sr).astype(int)

    fbank = np.zeros((n_mels, int(np.floor(n_fft / 2 + 1))))
    for m in range(1, n_mels + 1):
        f_m_minus = bin_points[m - 1]
        f_m = bin_points[m]
        f_m_plus = bin_points[m + 1]
        if f_m > f_m_minus:
            for k in range(f_m_minus, f_m):
                fbank[m - 1, k] = (k - bin_points[m - 1]) / (f_m - bin_points[m - 1])
        if f_m_plus > f_m:
            for k in range(f_m, f_m_plus):
                fbank[m - 1, k] = (bin_points[m + 1] - k) / (f_m_plus - f_m)
    return fbank


class Diarizer:
    def __init__(self, sample_rate: int = 16000):
        self.sample_rate = sample_rate
        self.mel_filterbank = build_mel_filterbank(sr=sample_rate, n_fft=512, n_mels=20)
        # Running speaker profiles for live classification: { speaker_id: feature_vector }
        self.online_profiles: Dict[str, np.ndarray] = {}

    def extract_slice_features(self, chunk: np.ndarray) -> Optional[np.ndarray]:
        """Extracts 28-dimensional acoustic features: pitch F0, centroid, 13 MFCC means, 13 MFCC stds."""
        sr = self.sample_rate
        if len(chunk) < sr * 0.25:  # At least 250ms of audio needed
            return None

        win_len = int(0.025 * sr)
        hop_len = int(0.010 * sr)
        frames = [chunk[i : i + win_len] for i in range(0, len(chunk) - win_len, hop_len)]
        if not frames:
            return None

        frame_mfccs = []
        pitches = []
        centroids = []

        for f in frames:
            w = f * np.hamming(len(f))
            fft_spec = np.abs(np.fft.rfft(w, 512))
            pow_spec = (fft_spec ** 2) / 512.0
            mel_energy = np.dot(self.mel_filterbank, pow_spec)
            mel_energy = np.where(mel_energy == 0, np.finfo(float).eps, mel_energy)
            log_mel = np.log(mel_energy)
            ceps = dct(log_mel, type=2, axis=0, norm="ortho")[:13]
            frame_mfccs.append(ceps)

            # Pitch estimation via normalized autocorrelation
            mean_f = np.mean(f)
            denom = np.sum((f - mean_f) ** 2)
            if denom > 1e-4:
                corr = correlate(f - mean_f, f - mean_f, mode="full")
                corr = corr[len(corr) // 2 :]
                min_l = int(sr / 350)  # max pitch 350 Hz
                max_l = int(sr / 75)   # min pitch 75 Hz
                if max_l < len(corr):
                    peak_lag = min_l + np.argmax(corr[min_l:max_l])
                    if peak_lag > 0:
                        pitches.append(sr / peak_lag)

            # Spectral centroid
            freqs = np.fft.rfftfreq(512, 1.0 / sr)
            sum_p = np.sum(fft_spec) + 1e-10
            centroids.append(np.sum(freqs * fft_spec) / sum_p)

        mfcc_mean = np.mean(frame_mfccs, axis=0)
        mfcc_std = np.std(frame_mfccs, axis=0)
        p_mean = float(np.mean(pitches)) if pitches else 140.0
        c_mean = float(np.mean(centroids)) if centroids else 1500.0

        vec = np.concatenate([[p_mean, c_mean], mfcc_mean, mfcc_std])
        return vec

    def diarize_meeting(self, meeting_id: str, num_speakers: Optional[int] = None) -> Dict[str, Any]:
        """Performs acoustic voice clustering and diarization on all segments of a meeting."""
        # Find audio file
        wav_path = Config.RECORDINGS_DIR / f"{meeting_id}.wav"
        if not wav_path.exists() or wav_path.stat().st_size == 0:
            accum = Config.CHUNKS_DIR / f"{meeting_id}_accumulated.webm"
            if accum.exists() and accum.stat().st_size > 0:
                from core.audio_processor import audio_processor
                audio_processor.convert_to_wav_16k(accum, wav_path)

        if not wav_path.exists() or wav_path.stat().st_size == 0:
            return {"error": "Audio file not found for meeting", "success": False}

        # Read audio samples
        try:
            with wave.open(str(wav_path), "rb") as wf:
                sr = wf.getframerate()
                audio = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(np.float32)
        except Exception as e:
            logger.error(f"Failed to read WAV for diarization: {e}")
            return {"error": str(e), "success": False}

        # Fetch transcript segments
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, start_seconds, end_seconds, text FROM transcript_segments WHERE meeting_id = ? ORDER BY start_seconds ASC",
            (meeting_id,),
        )
        segments = cursor.fetchall()

        if not segments:
            # Auto-transcribe audio file if available
            if wav_path.exists() and len(audio) > sr * 0.5:
                logger.info(f"No transcript segments found for {meeting_id}. Auto-transcribing from {wav_path}...")
                from core.transcriber import transcriber
                from models.schema import add_transcript_segment
                new_segs = transcriber.transcribe_file_to_segments(wav_path, language="id")
                for seg in new_segs:
                    if seg.get("text", "").strip():
                        add_transcript_segment(
                            meeting_id=meeting_id,
                            speaker="Speaker 1",
                            start_seconds=seg["start_seconds"],
                            end_seconds=seg["end_seconds"],
                            text=seg["text"].strip(),
                            confidence=seg.get("confidence", 0.9)
                        )
                cursor.execute(
                    "SELECT id, start_seconds, end_seconds, text FROM transcript_segments WHERE meeting_id = ? ORDER BY start_seconds ASC",
                    (meeting_id,),
                )
                segments = cursor.fetchall()

        if not segments:
            conn.close()
            return {"error": "No transcript segments found", "success": False}

        # Extract features per segment
        features = []
        valid_indices = []

        for idx, seg in enumerate(segments):
            sid = seg["id"]
            start = seg["start_seconds"]
            end = seg["end_seconds"]
            s_samp = max(0, int(start * sr))
            e_samp = min(len(audio), int(end * sr))
            chunk = audio[s_samp:e_samp]
            feat = self.extract_slice_features(chunk)
            if feat is not None:
                features.append(feat)
                valid_indices.append(idx)

        if len(features) < 2:
            # Only 1 segment or features too short: assign all to Speaker 1
            for seg in segments:
                cursor.execute("UPDATE transcript_segments SET speaker = 'Speaker 1' WHERE id = ?", (seg["id"],))
            total_duration = round(len(audio) / sr, 2)
            cursor.execute(
                "UPDATE meetings SET status = 'completed', duration_seconds = ?, audio_path = ? WHERE id = ?",
                (total_duration, str(wav_path), meeting_id),
            )
            conn.commit()
            conn.close()
            return {
                "success": True,
                "meeting_id": meeting_id,
                "num_speakers": 1,
                "speaker_counts": {"Speaker 1": len(segments)},
                "total_segments": len(segments),
                "duration_seconds": total_duration,
            }

        X = np.array(features)
        X_norm = StandardScaler().fit_transform(X)

        # Determine optimal number of speakers if not specified
        if num_speakers is None or num_speakers <= 0:
            best_k = 3  # default fallback
            best_score = -1.0
            candidate_range = range(2, min(6, len(X_norm)))
            for k in candidate_range:
                try:
                    clusterer = AgglomerativeClustering(n_clusters=k, linkage="ward")
                    cand_labels = clusterer.fit_predict(X_norm)
                    score = silhouette_score(X_norm, cand_labels)
                    if score > best_score:
                        best_score = score
                        best_k = k
                except Exception:
                    pass
            k = best_k
        else:
            k = min(num_speakers, len(X_norm))

        # Perform clustering
        clusterer = AgglomerativeClustering(n_clusters=k, linkage="ward")
        cluster_labels = clusterer.fit_predict(X_norm)

        # Map labels back to full segments array
        final_labels = [-1] * len(segments)
        for i, seg_idx in enumerate(valid_indices):
            final_labels[seg_idx] = int(cluster_labels[i])

        # Fill any missing/short segments with neighbor label
        last_known = 0
        for i in range(len(final_labels)):
            if final_labels[i] == -1:
                final_labels[i] = last_known
            else:
                last_known = final_labels[i]

        # Conversational smoothing: single-segment switch smoothing
        # If pattern is A -> B -> A and B duration is short (< 3.0s), smooth B to A
        for i in range(1, len(final_labels) - 1):
            if final_labels[i - 1] == final_labels[i + 1] and final_labels[i] != final_labels[i - 1]:
                seg_dur = segments[i]["end_seconds"] - segments[i]["start_seconds"]
                if seg_dur < 3.0:
                    final_labels[i] = final_labels[i - 1]

        # Update database with speaker names
        speaker_counts: Dict[str, int] = {}
        for idx, seg in enumerate(segments):
            cluster_id = final_labels[idx]
            speaker_name = f"Speaker {cluster_id + 1}"
            speaker_counts[speaker_name] = speaker_counts.get(speaker_name, 0) + 1
            cursor.execute(
                "UPDATE transcript_segments SET speaker = ? WHERE id = ?",
                (speaker_name, seg["id"]),
            )

        # Update meeting status to completed and calculate total duration
        total_duration = round(len(audio) / sr, 2)
        cursor.execute(
            "UPDATE meetings SET status = 'completed', duration_seconds = ?, audio_path = ? WHERE id = ?",
            (total_duration, str(wav_path), meeting_id),
        )

        conn.commit()
        conn.close()

        logger.info(f"Diarized meeting {meeting_id} into {k} speakers: {speaker_counts}")
        return {
            "success": True,
            "meeting_id": meeting_id,
            "num_speakers": k,
            "speaker_counts": speaker_counts,
            "total_segments": len(segments),
            "duration_seconds": total_duration,
        }

    def rename_speaker(self, meeting_id: str, from_speaker: str, to_speaker: str) -> Dict[str, Any]:
        """Renames a speaker label across all segments of a meeting."""
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE transcript_segments SET speaker = ? WHERE meeting_id = ? AND speaker = ?",
            (to_speaker.strip(), meeting_id, from_speaker.strip()),
        )
        updated_rows = cursor.rowcount
        conn.commit()
        conn.close()
        return {
            "success": True,
            "meeting_id": meeting_id,
            "from_speaker": from_speaker,
            "to_speaker": to_speaker,
            "updated_count": updated_rows,
        }

    def live_classify_speaker(self, audio_chunk_wav: Path, meeting_id: str, max_speakers: int = 4) -> str:
        """Online acoustic speaker classification for live streaming chunks."""
        try:
            with wave.open(str(audio_chunk_wav), "rb") as wf:
                sr = wf.getframerate()
                chunk = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(np.float32)
            feat = self.extract_slice_features(chunk)
            if feat is None:
                return "Speaker 1"

            # Check existing profiles for this meeting
            meeting_profiles = {k: v for k, v in self.online_profiles.items() if k.startswith(f"{meeting_id}:")}
            if not meeting_profiles:
                # First speaker
                spk = "Speaker 1"
                self.online_profiles[f"{meeting_id}:{spk}"] = feat
                return spk

            # Compute Euclidean distances to existing centroids
            best_spk = "Speaker 1"
            min_dist = float("inf")
            for spk_key, profile in meeting_profiles.items():
                spk_name = spk_key.split(":")[1]
                # Normalized distance
                diff = (feat - profile) / (np.abs(profile) + 1e-4)
                dist = np.linalg.norm(diff)
                if dist < min_dist:
                    min_dist = dist
                    best_spk = spk_name

            # Distance threshold for discovering a new speaker
            if min_dist > 5.5 and len(meeting_profiles) < max_speakers:
                new_idx = len(meeting_profiles) + 1
                best_spk = f"Speaker {new_idx}"
                self.online_profiles[f"{meeting_id}:{best_spk}"] = feat
                logger.info(f"Discovered new live speaker {best_spk} in meeting {meeting_id} (dist={min_dist:.2f})")
            else:
                # Smooth profile centroid
                current_profile = self.online_profiles[f"{meeting_id}:{best_spk}"]
                self.online_profiles[f"{meeting_id}:{best_spk}"] = 0.8 * current_profile + 0.2 * feat

            return best_spk
        except Exception as e:
            logger.warning(f"Error in live speaker classification: {e}")
            return "Speaker 1"


diarizer = Diarizer()
