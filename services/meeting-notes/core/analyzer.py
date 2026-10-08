import logging
import json
import requests
from typing import List, Dict, Any, Optional
from config import Config
from models.schema import update_meeting

logger = logging.getLogger("analyzer")

def extract_json_object(text: Optional[str]) -> Optional[Dict[str, Any]]:
    """Extracts the first valid JSON object from a string."""
    if not text:
        return None
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidate = text[start:end+1].strip()
        try:
            return json.loads(candidate)
        except Exception:
            pass
    return None

class LiveAnalyzer:
    def __init__(self):
        self.api_url = Config.LLM_API_URL
        self.api_key = Config.LLM_API_KEY
        self.model = Config.LLM_MODEL

    def _call_llm(self, url: str, key: str, model: str, prompt: str, timeout: int = 8) -> Optional[Dict[str, Any]]:
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": "You are a professional executive meeting summarizer. Respond ONLY with valid JSON."},
                {"role": "user", "content": prompt}
            ],
            "max_tokens": 500,
            "temperature": 0.2,
        }
        if "qwen" in model.lower():
            body["chat_template_kwargs"] = {"reasoning_effort": "low"}

        resp = requests.post(url, headers=headers, json=body, timeout=timeout)
        if resp.status_code == 200:
            data = resp.json()
            msg = data["choices"][0]["message"]
            content = msg.get("content") or ""
            reasoning = msg.get("reasoning") or ""
            return extract_json_object(content) or extract_json_object(reasoning)
        return None

    def analyze_segments(self, meeting_id: str, segments: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Analyzes meeting segments to generate live summary, topics, and insights."""
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

        prompt = (
            "Anda adalah Meeting Copilot Agent. Analisis percakapan rapat berikut dalam Bahasa Indonesia.\n"
            f"Transkrip rapat:\n\"{full_text[-1200:]}\"\n\n"
            "Berikan respon strictly dalam format JSON:\n"
            "{\n"
            '  "summary": "Ringkasan 1-2 kalimat mengenai poin utama rapat saat ini",\n'
            '  "topics": ["Topik 1", "Topik 2", "Topik 3"],\n'
            '  "insights": ["Insight atau poin penting 1", "Poin penting 2"],\n'
            '  "sentiment": "Produktif / Fokus / Brainstorming"\n'
            "}"
        )

        # 1. Try Primary LLM
        try:
            parsed = self._call_llm(self.api_url, self.api_key, self.model, prompt, timeout=7)
            if parsed and isinstance(parsed, dict) and "summary" in parsed:
                try:
                    update_meeting(meeting_id, summary=json.dumps(parsed, ensure_ascii=False))
                except Exception:
                    pass
                return parsed
        except Exception as e:
            logger.warning(f"Primary LLM ({self.api_url}) failed: {e}. Trying fallback...")

        # 2. Try Fallback LLM
        try:
            fallback_url = getattr(Config, "FALLBACK_LLM_URL", None)
            fallback_key = getattr(Config, "FALLBACK_LLM_KEY", None)
            fallback_model = getattr(Config, "FALLBACK_LLM_MODEL", None)
            if fallback_url and fallback_key:
                parsed = self._call_llm(fallback_url, fallback_key, fallback_model, prompt, timeout=7)
                if parsed and isinstance(parsed, dict) and "summary" in parsed:
                    try:
                        update_meeting(meeting_id, summary=json.dumps(parsed, ensure_ascii=False))
                    except Exception:
                        pass
                    return parsed
        except Exception as e:
            logger.warning(f"Fallback LLM failed: {e}. Using heuristic fallback.")

        # Heuristic fallback if LLM times out or fails
        sentences = [s.get("text", "").strip() for s in segments if len(s.get("text", "").strip()) > 8]
        recent_sentence = sentences[-1] if sentences else full_text[:80]
        
        # Build dynamic topics based on recent sentences
        dynamic_topics = []
        for s in reversed(sentences[-4:]):
            words = s.split()
            if len(words) >= 2:
                topic_cand = " ".join(words[:4]).strip(".,!?")
                if topic_cand and topic_cand not in dynamic_topics:
                    dynamic_topics.append(topic_cand)
        if not dynamic_topics:
            dynamic_topics = ["Koordinasi Tim", "Progres Rapat", "Tindak Lanjut"]

        fallback_data = {
            "summary": f"Diskusi berfokus pada: {recent_sentence}",
            "topics": dynamic_topics[:3],
            "insights": [
                f"Pembahasan aktif mengenai '{recent_sentence[:70]}...'",
                f"Terdeteksi {len(segments)} segmen percakapan audio secara real-time."
            ],
            "sentiment": "Produktif",
        }
        try:
            update_meeting(meeting_id, summary=json.dumps(fallback_data, ensure_ascii=False))
        except Exception:
            pass
        return fallback_data

analyzer = LiveAnalyzer()
