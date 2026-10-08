import os
import mimetypes
from pathlib import Path
from flask import Blueprint, request, jsonify, send_file, Response
from config import Config
from models.schema import (
    create_meeting,
    get_meeting,
    list_meetings,
    update_meeting,
    get_transcript_segments,
    get_recent_transcript_segments,
    search_transcript_segments,
    add_transcript_segment,
    delete_meeting
)
from core.audio_processor import audio_processor
from core.transcriber import transcriber
from core.live_stream_manager import live_stream_manager

meetings_bp = Blueprint("meetings", __name__)

@meetings_bp.route("/api/meetings/sessions", methods=["POST"])
@meetings_bp.route("/api/meetings", methods=["POST"])
def start_meeting_session():
    data = request.get_json() or {}
    company_id = data.get("company_id")
    title = data.get("title", "Untitled Meeting")
    meeting_id = data.get("id")
    
    if not company_id:
        return jsonify({"error": "company_id is required"}), 400
        
    meeting = create_meeting(company_id=company_id, title=title, meeting_id=meeting_id)
    return jsonify(meeting), 201

@meetings_bp.route("/api/meetings", methods=["GET"])
def get_meetings_list():
    company_id = request.args.get("company_id")
    if not company_id:
        return jsonify({"error": "company_id query param is required"}), 400
    meetings = list_meetings(company_id)
    return jsonify(meetings)

@meetings_bp.route("/api/meetings/<meeting_id>", methods=["GET"])
def get_meeting_detail(meeting_id: str):
    meeting = get_meeting(meeting_id)
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404
    segments = get_transcript_segments(meeting_id)
    return jsonify({
        **meeting,
        "segments": segments,
        "segment_count": len(segments)
    })

@meetings_bp.route("/api/meetings/<meeting_id>", methods=["PATCH"])
def patch_meeting(meeting_id: str):
    meeting = get_meeting(meeting_id)
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404
    data = request.get_json() or {}
    allowed = ["title", "status", "summary"]
    updates = {k: v for k, v in data.items() if k in allowed}
    updated = update_meeting(meeting_id, **updates)
    return jsonify(updated)

@meetings_bp.route("/api/meetings/<meeting_id>", methods=["DELETE"])
def remove_meeting(meeting_id: str):
    meeting = get_meeting(meeting_id)
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404
    delete_meeting(meeting_id)
    return jsonify({"success": True, "id": meeting_id})

@meetings_bp.route("/api/meetings/<meeting_id>/transcript", methods=["GET"])
def get_meeting_transcript(meeting_id: str):
    meeting = get_meeting(meeting_id)
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404
    segments = get_transcript_segments(meeting_id)
    full_text = "\n".join([f"[{s['speaker']} ({s['start_seconds']}s)]: {s['text']}" for s in segments])
    return jsonify({
        "meeting_id": meeting_id,
        "segments": segments,
        "full_text": full_text
    })

@meetings_bp.route("/api/meetings/<meeting_id>/transcript/recent", methods=["GET"])
def get_meeting_transcript_recent(meeting_id: str):
    seconds = float(request.args.get("seconds", 120.0))
    segments = get_recent_transcript_segments(meeting_id, seconds=seconds)
    summary_text = "\n".join([f"[{s['speaker']}]: {s['text']}" for s in segments])
    return jsonify({
        "meeting_id": meeting_id,
        "recent_seconds": seconds,
        "segments": segments,
        "summary_text": summary_text
    })

@meetings_bp.route("/api/meetings/<meeting_id>/transcript/search", methods=["GET"])
def search_meeting_transcript(meeting_id: str):
    q = request.args.get("q", "")
    if not q:
        return jsonify({"results": []})
    results = search_transcript_segments(meeting_id, q)
    return jsonify({
        "meeting_id": meeting_id,
        "query": q,
        "results": results
    })

@meetings_bp.route("/api/meetings/<meeting_id>/finish", methods=["POST"])
def finish_meeting(meeting_id: str):
    meeting = get_meeting(meeting_id)
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404
        
    final_path = live_stream_manager.close_session(meeting_id)
    updated = get_meeting(meeting_id)
    return jsonify(updated)

@meetings_bp.route("/api/meetings/<meeting_id>/upload", methods=["POST"])
def upload_meeting_audio(meeting_id: str):
    meeting = get_meeting(meeting_id)
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404
        
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
        
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400
        
    ext = Path(file.filename).suffix.lower() or ".mp3"
    raw_path = Config.RECORDINGS_DIR / f"{meeting_id}_raw{ext}"
    wav_path = Config.RECORDINGS_DIR / f"{meeting_id}.wav"
    
    file.save(raw_path)
    update_meeting(meeting_id, audio_path=str(wav_path), status="transcribing")
    
    # Convert to 16kHz WAV
    ok = audio_processor.convert_to_wav_16k(raw_path, wav_path)
    if not ok:
        update_meeting(meeting_id, status="error")
        return jsonify({"error": "Failed converting audio"}), 500
        
    duration = audio_processor.get_duration(wav_path)
    
    segments = get_transcript_segments(meeting_id)
    summary_update = {}
    if not meeting.get("summary") and segments:
        try:
            analysis = analyzer.analyze_segments(meeting_id, segments)
            summary_update["summary"] = json.dumps(analysis, ensure_ascii=False)
        except Exception as e:
            logger.warning(f"Error generating summary in upload_meeting_audio: {e}")

    update_meeting(meeting_id, status="completed", duration_seconds=duration, **summary_update)
        
    return jsonify(get_meeting(meeting_id))

@meetings_bp.route("/api/meetings/<meeting_id>/audio", methods=["GET"])
def stream_meeting_audio(meeting_id: str):
    meeting = get_meeting(meeting_id)
    if not meeting:
        return jsonify({"error": "Meeting not found"}), 404
        
    audio_path = Path(meeting["audio_path"]) if meeting.get("audio_path") else None
    if not audio_path or not audio_path.exists():
        # Fallback search for any generated audio candidate
        candidates = [
            Config.RECORDINGS_DIR / f"{meeting_id}.wav",
            Config.RECORDINGS_DIR / f"{meeting_id}.m4a",
            Config.RECORDINGS_DIR / f"{meeting_id}_raw.wav",
            Config.RECORDINGS_DIR / f"{meeting_id}_raw.webm",
            Config.CHUNKS_DIR / f"{meeting_id}_accumulated.webm"
        ]
        found = False
        for cand in candidates:
            if cand.exists() and cand.stat().st_size > 0:
                audio_path = cand
                update_meeting(meeting_id, audio_path=str(audio_path))
                found = True
                break
        if not found:
            return jsonify({"error": "Audio file not found on disk"}), 404
        
    # Support HTTP Range for HTML5 Audio Scrubbing/Seeking
    file_size = audio_path.stat().st_size
    range_header = request.headers.get("Range", None)
    
    mime_type, _ = mimetypes.guess_type(str(audio_path))
    mime_type = mime_type or "audio/mpeg"
    
    if not range_header:
        return send_file(audio_path, mimetype=mime_type)
        
    byte_range = range_header.replace("bytes=", "").split("-")
    start = int(byte_range[0])
    end = int(byte_range[1]) if byte_range[1] else file_size - 1
    length = end - start + 1
    
    with open(audio_path, "rb") as f:
        f.seek(start)
        data = f.read(length)
        
    response = Response(
        data,
        206,
        mimetype=mime_type,
        direct_passthrough=True
    )
    response.headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    response.headers["Accept-Ranges"] = "bytes"
    response.headers["Content-Length"] = str(length)
    return response
