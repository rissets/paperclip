import sqlite3
import uuid
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
from config import Config

def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(Config.DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created', -- 'created', 'recording', 'transcribing', 'completed'
        audio_path TEXT,
        duration_seconds REAL DEFAULT 0.0,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    """)
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS transcript_segments (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL,
        speaker TEXT NOT NULL DEFAULT 'Speaker 1',
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        text TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE
    );
    """)

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_meetings_company ON meetings(company_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_transcripts_meeting ON transcript_segments(meeting_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_transcripts_start ON transcript_segments(meeting_id, start_seconds);")
    conn.commit()
    conn.close()

# Pydantic Schemas
class TranscriptSegmentModel(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    meeting_id: str
    speaker: str = "Speaker 1"
    start_seconds: float
    end_seconds: float
    text: str
    confidence: float = 1.0
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class MeetingModel(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    company_id: str
    title: str
    status: str = "created"
    audio_path: Optional[str] = None
    duration_seconds: float = 0.0
    summary: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

# DB Helpers
def create_meeting(company_id: str, title: str, meeting_id: Optional[str] = None) -> Dict[str, Any]:
    mid = meeting_id or str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO meetings (id, company_id, title, status, duration_seconds, created_at, updated_at)
        VALUES (?, ?, ?, 'created', 0.0, ?, ?)
        """,
        (mid, company_id, title, now, now)
    )
    conn.commit()
    conn.close()
    return get_meeting(mid)

def get_meeting(meeting_id: str) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def list_meetings(company_id: str) -> List[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM meetings WHERE company_id = ? ORDER BY created_at DESC", (company_id,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def update_meeting(meeting_id: str, **kwargs) -> Optional[Dict[str, Any]]:
    if not kwargs:
        return get_meeting(meeting_id)
    kwargs["updated_at"] = datetime.now(timezone.utc).isoformat()
    set_clause = ", ".join([f"{k} = ?" for k in kwargs.keys()])
    values = list(kwargs.values()) + [meeting_id]
    
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(f"UPDATE meetings SET {set_clause} WHERE id = ?", values)
    conn.commit()
    conn.close()
    return get_meeting(meeting_id)

def delete_meeting(meeting_id: str) -> bool:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM transcript_segments WHERE meeting_id = ?", (meeting_id,))
    cursor.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))
    conn.commit()
    conn.close()
    return True

def add_transcript_segment(
    meeting_id: str,
    text: str,
    start_seconds: float,
    end_seconds: float,
    speaker: str = "Speaker 1",
    confidence: float = 1.0
) -> Dict[str, Any]:
    sid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO transcript_segments (id, meeting_id, speaker, start_seconds, end_seconds, text, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (sid, meeting_id, speaker, start_seconds, end_seconds, text, confidence, now)
    )
    conn.commit()
    conn.close()
    return {
        "id": sid,
        "meeting_id": meeting_id,
        "speaker": speaker,
        "start_seconds": start_seconds,
        "end_seconds": end_seconds,
        "text": text,
        "confidence": confidence,
        "created_at": now
    }

def get_transcript_segments(meeting_id: str) -> List[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY start_seconds ASC", (meeting_id,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_recent_transcript_segments(meeting_id: str, seconds: float = 120.0) -> List[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT * FROM transcript_segments 
        WHERE meeting_id = ? 
        ORDER BY start_seconds DESC
        LIMIT 20
        """, 
        (meeting_id,)
    )
    rows = cursor.fetchall()
    conn.close()
    segments = [dict(r) for r in reversed(rows)]
    return segments

def search_transcript_segments(meeting_id: str, query: str) -> List[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT * FROM transcript_segments 
        WHERE meeting_id = ? AND text LIKE ?
        ORDER BY start_seconds ASC
        """,
        (meeting_id, f"%{query}%")
    )
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]
