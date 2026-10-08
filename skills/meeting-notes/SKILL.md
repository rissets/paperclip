---
name: meeting-notes
description: >
  Real-time meeting transcript inspection, topic search, recent discussion retrieval, and
  notetaking skill for Primbon Meeting Copilot. Use when answering questions about live or
  completed meetings, extracting decisions, and finding spoken statements.
---

# Meeting Notes & Live Transcript Intelligence Skill

This skill equips Primbon agents (specifically the **Meeting Copilot Agent**) to inspect live and completed meeting transcripts, retrieve recent discussions, and search speaker statements.

---

## 1. Primary Action Tool: `meeting_notes.py`

Run the Python CLI tool to inspect meeting transcripts:

```bash
# 1. Get recent transcript from the last N seconds (default: 120s):
python3 ~/.pi/agent/skills/meeting-notes/scripts/meeting_notes.py --meeting-id "<id>" --recent --seconds 300

# 2. Search transcript for a specific topic, keyword, or speaker statement:
python3 ~/.pi/agent/skills/meeting-notes/scripts/meeting_notes.py --meeting-id "<id>" --search "database migration"

# 3. Get full meeting transcript:
python3 ~/.pi/agent/skills/meeting-notes/scripts/meeting_notes.py --meeting-id "<id>" --full-transcript

# 4. Inspect meeting metadata (status, duration, title):
python3 ~/.pi/agent/skills/meeting-notes/scripts/meeting_notes.py --meeting-id "<id>" --info
```

---

## 2. In-Meeting Cross-Domain Operations

When a user in a meeting asks you to verify facts against company data or synthesize insights:
1. Use `meeting_notes.py` to verify what was spoken in the meeting.
2. Use `query_structured.py --orchestrate "<question>"` to query company databases (PostgreSQL, ClickHouse) and RAG documents via the Enterprise Orchestrator.
3. Synthesize the factual comparison directly for the meeting participants.
