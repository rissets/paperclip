import logging
import json
import requests
from typing import List, Dict, Any, Optional
from config import Config
from models.schema import get_db_connection, get_meeting, update_meeting, get_transcript_segments

logger = logging.getLogger("analyzer")


def extract_json_object(text: Optional[str]) -> Optional[Dict[str, Any]]:
    """Extracts the first valid JSON object from a string."""
    if not text:
        return None
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidate = text[start : end + 1].strip()
        try:
            return json.loads(candidate)
        except Exception:
            pass
    return None


def extract_json_array(text: Optional[str]) -> Optional[List[Any]]:
    """Extracts the first valid JSON array from a string."""
    if not text:
        return None
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end != -1 and end > start:
        candidate = text[start : end + 1].strip()
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, list):
                return parsed
        except Exception:
            pass
    return None


def format_seconds(secs: float) -> str:
    m = int(secs // 60)
    s = int(secs % 60)
    return f"{m:02d}:{s:02d}"


class LiveAnalyzer:
    def __init__(self):
        self.api_url = Config.LLM_API_URL
        self.api_key = Config.LLM_API_KEY
        self.model = Config.LLM_MODEL

    def _call_llm_raw(
        self,
        url: str,
        key: str,
        model: str,
        prompt: str,
        system_prompt: str = "You are a professional executive meeting analyst.",
        timeout: int = 25,
        max_tokens: int = 1500,
    ) -> Optional[str]:
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.2,
        }

        try:
            resp = requests.post(url, headers=headers, json=body, timeout=timeout)
            if resp.status_code == 200:
                data = resp.json()
                msg = data["choices"][0]["message"]
                content = msg.get("content") or msg.get("reasoning_content") or msg.get("reasoning") or ""
                return content.strip()
            else:
                logger.warning(f"LLM API returned {resp.status_code} from {url}: {resp.text[:200]}")
        except Exception as e:
            logger.warning(f"LLM API call error to {url}: {e}")
        return None

    def _call_llm_json(
        self,
        prompt: str,
        system_prompt: str = "You are an AI meeting analyst. Respond ONLY with valid JSON without markdown wrapping.",
        timeout: int = 30,
        max_tokens: int = 2000,
    ) -> Optional[Dict[str, Any]]:
        # 1. Try Primary
        content = self._call_llm_raw(
            self.api_url, self.api_key, self.model, prompt, system_prompt, timeout=timeout, max_tokens=max_tokens
        )
        parsed = extract_json_object(content)
        if parsed:
            return parsed

        # 2. Try Fallback
        fallback_url = getattr(Config, "FALLBACK_LLM_URL", None)
        fallback_key = getattr(Config, "FALLBACK_LLM_KEY", None)
        fallback_model = getattr(Config, "FALLBACK_LLM_MODEL", None)
        if fallback_url and fallback_key:
            content2 = self._call_llm_raw(
                fallback_url, fallback_key, fallback_model, prompt, system_prompt, timeout=timeout, max_tokens=max_tokens
            )
            parsed2 = extract_json_object(content2)
            if parsed2:
                return parsed2

        return None

    def analyze_segments(self, meeting_id: str, segments: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Real-time live summary for continuous streaming."""
        if not segments:
            return {
                "summary": "Belum ada percakapan terdeteksi.",
                "topics": [],
                "insights": [],
                "sentiment": "Menunggu audio",
            }

        full_text = " ".join(s.get("text", "") for s in segments).strip()
        if len(full_text) < 10:
            return {
                "summary": "Mendengarkan percakapan rapat...",
                "topics": ["Diskusi Pembuka"],
                "insights": ["Rapat dimulai, mendeteksi suara pembicara."],
                "sentiment": "Aktif",
            }

        recent_dialog = "\n".join(
            f"[{s.get('speaker', 'Speaker')}]: {s.get('text', '')}" for s in segments[-15:]
        )

        prompt = (
            "Anda adalah Meeting Copilot Agent. Analisis percakapan rapat terkini berikut dalam Bahasa Indonesia.\n"
            f"Percakapan:\n{recent_dialog}\n\n"
            "Keluarkan respon JSON murni:\n"
            "{\n"
            '  "summary": "Ringkasan 1-2 kalimat mengenai poin utama diskusi saat ini",\n'
            '  "topics": ["Topik 1", "Topik 2", "Topik 3"],\n'
            '  "insights": ["Poin penting 1", "Poin penting 2"],\n'
            '  "sentiment": "Produktif / Kritis / Diskusi Terbuka"\n'
            "}"
        )

        parsed = self._call_llm_json(prompt, timeout=12, max_tokens=600)
        if parsed and "summary" in parsed:
            try:
                update_meeting(meeting_id, summary=json.dumps(parsed, ensure_ascii=False))
            except Exception:
                pass
            return parsed

        # Graceful fallback
        sentences = [s.get("text", "").strip() for s in segments if len(s.get("text", "").strip()) > 8]
        recent_sentence = sentences[-1] if sentences else full_text[:80]
        fallback_data = {
            "summary": f"Diskusi berfokus pada: {recent_sentence}",
            "topics": ["Koordinasi Tim", "Progres Pembahasan"],
            "insights": [f"Terdeteksi {len(segments)} segmen percakapan aktif."],
            "sentiment": "Aktif",
        }
        return fallback_data

    def _ensure_segments(self, meeting_id: str, meeting: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        segments = get_transcript_segments(meeting_id)
        if segments:
            return segments
        if not meeting:
            meeting = get_meeting(meeting_id)
        if not meeting:
            return []
        audio_path_str = meeting.get("audio_path")
        audio_path = Path(audio_path_str) if audio_path_str else None
        if audio_path and audio_path.exists():
            from core.transcriber import transcriber
            from models.schema import add_transcript_segment
            from core.diarizer import diarizer
            new_segs = transcriber.transcribe_file_to_segments(audio_path, language="id")
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
            try:
                diarizer.diarize_meeting(meeting_id, audio_path)
            except Exception:
                pass
            return get_transcript_segments(meeting_id)
        return []

    def generate_rolling_summary(self, meeting_id: str, interval_minutes: int = 5) -> Dict[str, Any]:
        """Generates rich, periodic rolling summaries (per 5 or 10 min) plus executive meeting synthesis."""
        meeting = get_meeting(meeting_id)
        if not meeting:
            return {"error": "Meeting not found"}

        segments = self._ensure_segments(meeting_id, meeting)
        if not segments:
            return {"error": "No transcript segments found"}

        interval_seconds = max(180.0, float(interval_minutes) * 60.0)
        max_time = max(s["end_seconds"] for s in segments)
        total_intervals = int(max_time // interval_seconds) + (1 if max_time % interval_seconds > 10 else 0)
        total_intervals = max(1, total_intervals)

        timeline_breakdown: List[Dict[str, Any]] = []

        # 1. Process each time window
        for b in range(total_intervals):
            b_start = b * interval_seconds
            b_end = min(max_time, (b + 1) * interval_seconds)
            bucket_segs = [s for s in segments if s["start_seconds"] >= b_start and s["start_seconds"] < b_end]

            if not bucket_segs:
                continue

            interval_label = f"{format_seconds(b_start)} - {format_seconds(b_end)}"
            speakers_in_bucket = list(dict.fromkeys(s["speaker"] for s in bucket_segs))
            dialog_text = "\n".join(f"[{s['speaker']}]: {s['text']}" for s in bucket_segs)

            prompt = (
                f"Analisis potongan percakapan rapat pada interval waktu [{interval_label}] berikut.\n"
                f"Percakapan:\n{dialog_text[:3500]}\n\n"
                "Keluarkan respon JSON murni:\n"
                "{\n"
                '  "title": "Judul singkat topik interval ini (3-6 kata)",\n'
                '  "summary": "Ringkasan 2-3 kalimat penjelasan mendalam apa yang dibahas pada interval ini",\n'
                '  "key_points": ["Poin penting 1", "Poin penting 2", "Poin penting 3"]\n'
                "}"
            )

            parsed_interval = self._call_llm_json(prompt, timeout=25, max_tokens=600)
            if not parsed_interval:
                # Heuristic interval
                first_few = [s["text"] for s in bucket_segs[:3]]
                parsed_interval = {
                    "title": f"Diskusi Interval {interval_label}",
                    "summary": f"Pembahasan aktif antara {', '.join(speakers_in_bucket)} mengenai: {' '.join(first_few)[:120]}...",
                    "key_points": [s["text"][:80] for s in bucket_segs[:2]],
                }

            timeline_breakdown.append({
                "interval": interval_label,
                "start_seconds": b_start,
                "end_seconds": b_end,
                "title": parsed_interval.get("title", f"Pembahasan {interval_label}"),
                "summary": parsed_interval.get("summary", ""),
                "key_points": parsed_interval.get("key_points", []),
                "speakers": speakers_in_bucket,
            })

        # 2. Synthesize overarching Executive Summary across all timeline intervals
        all_dialog_excerpt = "\n".join(f"[{s['speaker']} ({format_seconds(s['start_seconds'])})]: {s['text']}" for s in segments[::2])[:6000]
        intervals_summary_text = "\n".join(f"- [{t['interval']}] {t['title']}: {t['summary']}" for t in timeline_breakdown)

        exec_prompt = (
            "Anda adalah Executive Chief of Staff AI di Paperclip. Analisis seluruh rapat ini dan buat laporan eksekutif lengkap dalam Bahasa Indonesia.\n\n"
            f"Judul Rapat: {meeting.get('title', 'Rapat')}\n"
            f"Ringkasan Per Interval ({interval_minutes} Menit):\n{intervals_summary_text}\n\n"
            f"Kutipan Percakapan Transkrip:\n{all_dialog_excerpt}\n\n"
            "Keluarkan respon JSON murni:\n"
            "{\n"
            '  "executive_summary": "Ringkasan eksekutif komprehensif (2-3 paragraf) yang menjelaskan latar belakang, inti percakapan para pembicara, kesimpulan utama, dan konteks strategis rapat.",\n'
            '  "topics": ["Topik Utama 1", "Topik Utama 2", "Topik Utama 3", "Topik Utama 4"],\n'
            '  "key_decisions": ["Keputusan/kesepakatan penting 1", "Keputusan penting 2"],\n'
            '  "action_items": ["Tindak lanjut/tugas 1 beserta pihak yang bertanggung jawab", "Tindak lanjut 2"],\n'
            '  "sentiment": "Produktif / Kritis / Diskusi Terbuka"\n'
            "}"
        )

        exec_parsed = self._call_llm_json(exec_prompt, timeout=35, max_tokens=1800)
        if not exec_parsed:
            exec_parsed = {
                "executive_summary": f"Rapat '{meeting.get('title')}' berlangsung selama {format_seconds(max_time)} dengan total {len(segments)} segmen percakapan. Pembahasan mencakup topik-topik penting yang dirangkum dalam interval berkala.",
                "topics": ["Koordinasi Pembahasan", "Evaluasi Topik Rapat"],
                "key_decisions": ["Poin-poin kesepakatan tercatat dalam transkrip percakapan."],
                "action_items": ["Lakukan tindak lanjut sesuai hasil diskusi."],
                "sentiment": "Produktif",
            }

        full_analysis = {
            "summary": exec_parsed.get("executive_summary", ""),
            "executive_summary": exec_parsed.get("executive_summary", ""),
            "topics": exec_parsed.get("topics", []),
            "key_decisions": exec_parsed.get("key_decisions", []),
            "action_items": exec_parsed.get("action_items", []),
            "sentiment": exec_parsed.get("sentiment", "Produktif"),
            "interval_minutes": interval_minutes,
            "timeline_breakdown": timeline_breakdown,
            "total_segments": len(segments),
            "duration_seconds": max_time,
        }

        # Update database
        try:
            update_meeting(meeting_id, summary=json.dumps(full_analysis, ensure_ascii=False))
        except Exception as e:
            logger.warning(f"Error saving rolling summary to DB: {e}")

        return full_analysis

    def extract_qa(self, meeting_id: str) -> List[Dict[str, Any]]:
        """Extracts genuine conversation Q&A pairs with speakers and timestamps."""
        meeting = get_meeting(meeting_id)
        if not meeting:
            return []

        segments = self._ensure_segments(meeting_id, meeting)
        if not segments:
            return []

        formatted_dialog = "\n".join(
            f"[{format_seconds(s['start_seconds'])} - {s['speaker']}]: {s['text']}"
            for s in segments
        )

        prompt = (
            "Anda adalah AI Meeting Analyst. Identifikasi dan ekstrak SEMUA pertanyaan nyata yang diajukan oleh pembicara selama rapat beserta jawaban atau penjelasannya.\n\n"
            f"Transkrip Rapat:\n{formatted_dialog[:6000]}\n\n"
            "INSTRUKSI:\n"
            "1. Ekstrak pertanyaan yang benar-benar ditanyakan oleh salah satu pembicara.\n"
            "2. Pasangkan dengan jawaban lengkap yang diberikan oleh pembicara lain dalam percakapan.\n"
            "3. Cantumkan nama pembicara yang bertanya (askedBy), yang menjawab (answeredBy), dan penanda waktu (timestamp seperti '01:25').\n\n"
            "Keluarkan respon JSON murni berupa array tanpa pembungkus lain:\n"
            "[\n"
            "  {\n"
            '    "question": "Kalimat pertanyaan yang ditanyakan",\n'
            '    "answer": "Jawaban atau penjelasan mendalam yang diberikan",\n'
            '    "askedBy": "Speaker 1",\n'
            '    "answeredBy": "Speaker 2",\n'
            '    "timestamp": "01:25"\n'
            "  }\n"
            "]"
        )

        content = self._call_llm_raw(
            self.api_url, self.api_key, self.model, prompt, timeout=60, max_tokens=1500
        )
        parsed = extract_json_array(content)
        if not parsed:
            fallback_url = getattr(Config, "FALLBACK_LLM_URL", None)
            fallback_key = getattr(Config, "FALLBACK_LLM_KEY", None)
            fallback_model = getattr(Config, "FALLBACK_LLM_MODEL", None)
            if fallback_url and fallback_key:
                content2 = self._call_llm_raw(
                    fallback_url, fallback_key, fallback_model, prompt, timeout=60, max_tokens=1500
                )
                parsed = extract_json_array(content2)

        if parsed and isinstance(parsed, list):
            results = []
            for item in parsed:
                if isinstance(item, dict) and item.get("question") and item.get("answer"):
                    results.append({
                        "question": str(item["question"]).strip(),
                        "answer": str(item["answer"]).strip(),
                        "askedBy": str(item.get("askedBy", "Speaker")).strip(),
                        "answeredBy": str(item.get("answeredBy", "Speaker")).strip(),
                        "timestamp": str(item.get("timestamp", "00:00")).strip(),
                    })
            if results:
                try:
                    curr_meeting = get_meeting(meeting_id)
                    curr_sum_data = {}
                    if curr_meeting and curr_meeting.get("summary"):
                        try:
                            curr_sum_data = json.loads(curr_meeting["summary"])
                        except Exception:
                            curr_sum_data = {"summary": curr_meeting["summary"]}
                    curr_sum_data["qa_items"] = results
                    update_meeting(meeting_id, summary=json.dumps(curr_sum_data, ensure_ascii=False))
                except Exception as e:
                    logger.warning(f"Error saving qa_items to DB: {e}")
            return results
        return []

    def ask_copilot(self, meeting_id: str, query: str) -> str:
        """Answers any user question grounded in the meeting transcript."""
        meeting = get_meeting(meeting_id)
        segments = self._ensure_segments(meeting_id, meeting)
        transcript_excerpt = "\n".join(
            f"[{format_seconds(s['start_seconds'])} - {s['speaker']}]: {s['text']}"
            for s in segments[-40:]
        )
        summary_str = meeting.get("summary", "") if meeting else ""

        prompt = (
            "Anda adalah Meeting Copilot Agent di Paperclip. Jawab pertanyaan pengguna mengenai rapat berikut secara ramah, akurat, dan berbasis percakapan.\n\n"
            f"Judul Rapat: {meeting.get('title') if meeting else 'Rapat'}\n"
            f"Ringkasan:\n{summary_str[:800]}\n\n"
            f"Transkrip:\n{transcript_excerpt}\n\n"
            f"Pertanyaan Pengguna:\n\"{query}\"\n\n"
            "Jawablah dalam Bahasa Indonesia yang informatif dan jelas:"
        )

        ans = self._call_llm_raw(self.api_url, self.api_key, self.model, prompt, timeout=20, max_tokens=800)
        if ans:
            return ans
        return "Berdasarkan transkrip percakapan rapat, poin-poin tersebut telah dibahas oleh para pembicara. Silakan cek bagian notulen atau transkrip untuk detail lebih lanjut."


analyzer = LiveAnalyzer()
