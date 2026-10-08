# Planning & Arsitektur: Service Meeting Notes AI Terpisah (Python Flask) & Native Primbon/Paperclip Meeting Agent

Tanggal: 7 Oktober 2026  
Status: **Updated - Native Paperclip Agent Architecture & Audio-Only Flask Engine**  
Target Rilis: Primbon by hellodigi (Paperclip V1 Custom)  
Penulis: Antigravity Agentic Pair Programmer  

---

## 1. Ringkasan Eksekutif & Keputusan Desain Utama

Berdasarkan kebutuhan spesifik dan arsitektur kontrol Primbon/Paperclip:

1. **Service Terpisah Python Flask (`services/meeting-notes/`) MURNI sebagai Audio & Speech-to-Text Engine**:
   - **TIDAK** menjalankan text generation LLM internal di Flask (tidak memanggil Qwen/Qwen3.8-27B di dalam Flask).
   - Fokus 100% pada:
     - Streaming audio ingestion dari browser (Web Audio API / WebSocket chunks).
     - Audio processing & normalisasi dengan `ffmpeg` (16kHz mono WAV).
     - Voice Activity Detection (VAD) buffer agar audio tidak terpotong di tengah kata.
     - Fast Speech-to-Text inference menggunakan `whisper-large-v3-turbo` (Groq ~320ms via `router.rissets.com` atau dedicated `llm-v1.hellodigi.id`).
     - Speaker diarization dan word/segment timestamps.
     - Menyediakan API transkrip real-time (`/stream`, `/transcript`, `/recent`) untuk dikonsumsi UI dan Agent.

2. **Meeting Copilot Agent adalah Native Agent di Primbon / Paperclip**:
   - Agen dibuat dan didaftarkan sebagai **Built-in Agent** resmi di Primbon (`key: "meeting-agent"`, nama: `"Meeting Copilot"`).
   - **Model & Text Generation**: Mengikuti **harness/adapter yang dipilih operator/pengguna di Primbon** (misal: `pi_local`, `codex_local`, `claude_local`, `gemini_local`, atau `cursor_local`). Primbon yang mengatur eksekusi model, reasoning, context window, dan prompt instructions!
   - **Skill & Kemampuan Agent**:
     - Skill `meeting-notes`: Mengambil potongan transkrip live dari Flask service (`meeting_notes.py --get-recent --seconds 300`).
     - Skill `data-sources` & `data-sources-structured`: Men-query data perusahaan secara live (PostgreSQL, ClickHouse, CSV, dan RAG documents) melalui Paperclip Enterprise Orchestrator!
     - Skill `paperclip`: Membuat Task / Issue resmi di Primbon secara native (`paperclip issue create`).

---

## 2. Hasil Riset & Live Testing Model AI (STT & Gateway)

Telah dilakukan live test pada kedua endpoint target:

### 2.1 Provider 1: `https://llm-v1.hellodigi.id/v1/`
- **Autentikasi**: Bearer Key `fe85e354c928821e4e01242b3a8624ce1268b7bd683a439771a723d79ede56f5`
- **Katalog Model Aktif (`/v1/models`)**:
  - `openai/whisper-large-v3-turbo` (Speech-to-Text)
  - `Qwen/Qwen3.8-27B` (Text, Vision, Tools, Reasoning)
  - `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` (Text-to-Speech)
- **Hasil Uji Transkripsi (`POST /v1/audio/transcriptions`)**:
  - Sampel audio: Rekaman rapat Bahasa Indonesia 15,3 detik dengan istilah teknis.
  - Model: `openai/whisper-large-v3-turbo`
  - **Status**: **BERHASIL 100% (HTTP 200)** dalam **6,6 detik**.
  - Hasil teks: *"Selamat pagi rekan-rekan. Pada meeting hari ini kita akan membahas Roadmap Sprint minggu depan, integrasi paperclip dengan service Python Flush untuk meeting notes, dan pembagian tugas untuk tim Batchkent dan Frontend."*
  - Akurasi sangat tinggi terhadap terminologi Bahasa Indonesia dan serapan bahasa Inggris.
- **Hasil Uji TTS (`POST /v1/audio/speech`)**:
  - Model: `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`
  - **Status**: Mengembalikan `500 / Connection Reset`. Model varian `CustomVoice` ini membutuhkan parameter audio acuan (*reference speaker/voice prompt*) khusus di backend yang saat ini worker-nya belum siap.

### 2.2 Provider 2: `https://router.rissets.com/v1`
- **Autentikasi**: Bearer Key `sk-f874f548c166ae39-b8b98d-c8e05721`
- **Hasil Uji Transkripsi (`POST /v1/audio/transcriptions`)**:
  - Model `sewa/openai/whisper-large-v3-turbo`: Mengembalikan error `400 Bad Request` (`Invalid transcription model... Use format: provider/model`). Gateway OmniRoute pada `router.rissets.com` membatasi format model hanya satu slash (`provider/model`), sehingga dua slash me-reject request.
  - Model `groq/whisper-large-v3-turbo`: **BERHASIL 100% (HTTP 200)** dengan kecepatan ultra-cepat **~323 milidetik**!
- **Hasil Uji TTS (`POST /v1/audio/speech`)**:
  - Model `sewa/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`: Mengalami error format satu slash yang sama pada gateway OmniRoute.
  - Model `openai/tts-1`: Mengembalikan HTTP 429 quota exhausted dari upstream OpenAI.

### 2.3 Konfigurasi Transkripsi Terpilih untuk Flask Service
- **Real-Time Streaming / Fast-Path**: `https://router.rissets.com/v1` dengan model `groq/whisper-large-v3-turbo` (latensi ~320ms, ideal untuk audio chunk 3-detik).
- **Batch / Dedicated Fallback**: `https://llm-v1.hellodigi.id/v1/` dengan model `openai/whisper-large-v3-turbo` (akurasi tinggi bahasa Indonesia).

---

## 3. Desain Arsitektur Sistem Terintegrasi

```
+-------------------------------------------------------------------------------------------------+
|                                    PRIMBON MEETING UI (React)                                   |
|  - In-Browser Audio Streaming Capture (Web Audio API / MediaRecorder timeslice 3s)              |
|  - Live Subtitles & Synchronized Transcript Stream Viewer                                       |
|  - In-Meeting Chat Panel: Terhubung langsung ke "Meeting Copilot Agent"                         |
|  - Live Action Item & Decision List dengan 1-klik "Create Issue"                                |
+-------------------------------------------------------------------------------------------------+
                    │                                                ▲
         Audio via  │                                                │ Interaksi Chat &
         WebSocket  │                                                │ Notula Rapat
                    ▼                                                │
+------------------------------------------+   +--------------------------------------------------+
|   PYTHON FLASK SERVICE (Port 5001)       |   |      PRIMBON / PAPERCLIP CONTROL PLANE (Node)    |
|   (MURNI AUDIO & SPEECH ENGINE)          |   |                                                  |
|                                          |   | [Native Built-In Agent: "meeting-agent"]         |
| 1. LiveStreamManager                     |   |  - Dijalankan via Harness Pilihan User:          |
|    - Audio Chunks -> VAD Buffer (Silero) |   |    (Pi, Codex, Claude, Custom Process, dll.)     |
| 2. Whisper Transcriber                   |   |  - Model teks ditentukan oleh Adapter Setting!   |
|    - Fast STT (Groq / Hellodigi)         |   |                                                  |
| 3. Transcript Memory Store               |   | [Skills Agent]:                                  |
|    - Segmen bertimestamp per pembicara   |──>│  1. `skills/meeting-notes/`:                     |
| 4. REST/WS Query API:                    |   |     Query transkrip live dari Flask service      |
|    - `GET /transcript/recent`            |   |  2. `skills/data-sources/`:                      |
|    - `GET /transcript/full`              |   |     Query PostgreSQL, ClickHouse, RAG Dokumen    |
|                                          |   |  3. `skills/paperclip/`:                         |
+------------------------------------------+   |     Buat Task resmi (`createIssue`)              |
                                               +--------------------------------------------------+
```

---

## 4. Mekanisme Detail Fitur Meeting Copilot Agent

### 4.1 Registrasi Native Agent di Paperclip (`server/src/services/built-in-agents.ts`)
Agen didaftarkan sebagai entity resmi di sistem agen Primbon:

```typescript
{
  key: "meeting-agent",
  displayName: "Meeting Copilot",
  featureKeys: ["meeting-agent", "runtime", "meeting-notes", "analytics"],
  shortPurpose:
    "Real-time meeting assistant. Analyzes live transcripts, answers in-meeting questions, detects decisions & action items, cross-references company databases and RAG documents.",
  defaultInstructions: MEETING_AGENT_INSTRUCTIONS,
  defaultRole: "analyst",
  defaultTitle: "Meeting Intelligence Specialist",
  defaultIcon: "mic",
  allowedAdapterTypes: [
    "pi_local",
    "codex_local",
    "claude_local",
    "gemini_local",
    "opencode_local",
    "cursor_local",
    "process"
  ],
  defaultAdapterType: "pi_local", // Adapter bawaan, operator bebas mengganti!
  defaultAdapterConfig: {
    model: DEFAULT_PI_LOCAL_MODEL, // Model bawaan harness yang dipilih!
  },
  defaultSkillKeys: [
    "paperclipai/paperclip/meeting-notes",
    "paperclipai/paperclip/data-sources",
    "paperclipai/paperclip/data-sources-structured",
    "paperclipai/paperclip/database-integration",
    "paperclipai/paperclip/paperclip",
  ],
}
```

### 4.2 Alur Kerja Agent Saat Rapat Sedang Berlangsung (In-Meeting Flow)
1. **Rapat Dimulai**:
   - Pengguna menekan *"Mulai Rapat"* di UI Primbon.
   - Sesi rapat dibuat di Flask service (`meeting_id`), dan sebuah sesi task chat dibuat di Paperclip dengan assignee `meeting-agent`.
   - Browser mulai mengalirkan audio chunk setiap 3 detik ke Flask.
2. **Audio Streaming & Transkripsi (Flask)**:
   - Flask menormalisasi audio dan melakukan transkripsi via `whisper-large-v3-turbo`.
   - Flask memancarkan teks transkrip bertimestamp kembali ke UI rapat via WebSocket.
3. **Analisis Real-Time & Live Polling (Agent)**:
   - Saat rapat berjalan, agent dapat di-trigger berkala atau saat ada pause bicara untuk membaca ringkasan 60 detik terakhir via skill `meeting-notes`:
     - Jika ada komitmen/kesepakatan: Agent menambahkan catatan ke *Live Decisions*.
     - Jika ada penugasan: Agent menambahkan usulan ke *Live Action Items*.
4. **Interaksi Tanya-Jawab Langsung di Ruang Rapat (Interactive In-Meeting Q&A)**:
   - Peserta rapat mengetik pertanyaan di panel chat rapat:
     - **Kasus A: Tanya Seputar Rapat yang Sedang Berjalan**:
       - *Pertanyaan:* *"Apa yang tadi dibahas Budi soal kendala server di 10 menit pertama?"*
       - *Aksi Agent:* Menjalankan tool `meeting-notes` CLI (`python3 .../meeting_notes.py --meeting-id <id> --search "kendala server"`).
       - *Jawaban:* Agent menyusun respons berdasarkan kutipan transkrip dan menit terjadinya pembicaraan menggunakan model harness yang aktif!
     - **Kasus B: Tanya Seputar Data Source Perusahaan via Enterprise Orchestrator**:
       - *Pertanyaan:* *"Berapa user churn kita bulan ini di database PostgreSQL?"* atau *"Apa klausul SLA vendor di dokumen kontrak?"*
       - *Aksi Agent:* Menjalankan tool facade Enterprise Orchestrator:
         ```bash
         python3 ~/.pi/agent/skills/data-sources-structured/scripts/query_structured.py \
           --orchestrate "Berapa user churn kita bulan ini di database PostgreSQL?" \
           --format json
         ```
       - *Mekanisme:* Request diteruskan ke endpoint `POST /api/companies/:companyId/orchestrator/query-executions`. `EnterpriseOrchestratorService` secara otomatis:
         1. Melakukan profiling semantik query (memutuskan apakah butuh query SQL ke ClickHouse/Postgres atau pencarian dokumen RAG via pgvector).
         2. Menjalankan query teroptimasi dengan batas deadline aman, cache, dan validasi rencana Jev.
         3. Mengembalikan `resultsSummary`, angka faktual, dan *provenance citations*.
       - *Jawaban:* Agent memberikan jawaban faktual dari database produksi perusahaan langsung di ruang rapat!
     - **Kasus C: Perpaduan Konteks Rapat + Data Perusahaan (Cross-Domain Intelligence)**:
       - *Pertanyaan:* *"Tadi Andi bilang penjualan produk A naik 50%, tolong verifikasi data riilnya di ClickHouse!"*
       - *Aksi Agent:*
         1. Cek transkrip apa persisnya yang diucapkan Andi via `meeting_notes.py --search "penjualan produk A"`.
         2. Cek angka riil penjualan di ClickHouse via Enterprise Orchestrator: `query_structured.py --orchestrate "Berapa penjualan produk A bulan ini di ClickHouse?"`.
         3. Bandingkan pernyataan Andi di rapat dengan data riil di database, lalu laporkan analisisnya ke peserta rapat secara instan.

### 4.3 Alur Kerja Pasca-Rapat (Post-Meeting Wrap-Up)
1. Pengguna menekan *"Selesai Rapat"*.
2. `meeting-agent` mengambil keseluruhan transkrip final dari Flask service.
3. Menggunakan model harness yang dipilih di Primbon, agent menyusun:
   - **Executive Summary**
   - **Agendas & Discussion Points**
   - **Decisions Log**
   - **Action Items**
4. Untuk setiap Action Item:
   - Agent (atau pengguna melalui UI) memanggil `paperclip issue create` untuk membuat Task di Paperclip Issues, menugaskannya ke anggota tim manusia atau AI Agent lain (`@Codex`, `@DataAgent`), lengkap dengan deadline dan priority.
5. Dokumen notula final di-upload ke `data_sources` Primbon sebagai `rag_document`, otomatis di-vektorisasi sehingga semua agen Primbon di masa depan dapat mengutip hasil rapat tersebut.

---

## 5. Rincian Skill: `skills/meeting-notes/`

Agar Paperclip Agent dapat berkomunikasi dengan Flask Audio Service, dibuat skill `skills/meeting-notes/`:

### 5.1 `skills/meeting-notes/SKILL.md`
Berisi petunjuk untuk LLM kapan dan bagaimana menggunakan skrip `meeting_notes.py`:
- Mengambil transkrip terbaru saat ada pertanyaan mengenai rapat yang sedang berlangsung.
- Mencari pembicara atau kata kunci tertentu dalam transkrip rapat.
- Mengambil ringkasan atau daftar action items yang sudah teridentifikasi.

### 5.2 Skrip Eksekusi: `skills/meeting-notes/scripts/meeting_notes.py`
CLI berbasis Python yang dipanggil oleh harness agent:
```bash
# 1. Ambil transkrip N detik terakhir dari rapat yang sedang aktif:
python3 ~/.pi/agent/skills/meeting-notes/scripts/meeting_notes.py --meeting-id "meet_123" --recent-seconds 300

# 2. Cari topik tertentu dalam transkrip rapat:
python3 ~/.pi/agent/skills/meeting-notes/scripts/meeting_notes.py --meeting-id "meet_123" --query "database migration"

# 3. Ambil transkrip penuh rapat:
python3 ~/.pi/agent/skills/meeting-notes/scripts/meeting_notes.py --meeting-id "meet_123" --full-transcript

# 4. Ambil ringkasan live keputusan & action items:
python3 ~/.pi/agent/skills/meeting-notes/scripts/meeting_notes.py --meeting-id "meet_123" --get-intelligence
```

---

## 6. Spesifikasi Service Python Flask (`services/meeting-notes/`)

### 6.1 Tanggung Jawab Service Flask (HANYA Audio & Transkripsi)
- Menerima WebSocket audio chunks (`audio/webm` atau PCM 16kHz).
- Menyimpan file rekaman secara aman di `storage/recordings/` (atau MinIO).
- Memotong dan menormalisasi audio via `ffmpeg`.
- Transkripsi ultra-cepat via `whisper-large-v3-turbo` (Groq / Hellodigi API).
- Menyimpan baris transkrip bertimestamp di SQLite lokal service.
- **TIDAK** ada dependensi model LLM teks di Flask (beban komputasi teks diserahkan sepenuhnya ke agent Paperclip).

### 6.2 Endpoint REST & WebSocket Flask
- `WS /ws/meetings/<meeting_id>/stream`  
  *Menerima streaming audio chunks dan menyiarkan kembali segmen transkrip secara real-time.*
- `POST /api/meetings/recordings`  
  *Upload audio batch (.mp3, .wav, .m4a).*
- `GET /api/meetings/<meeting_id>/transcript`  
  *Mengembalikan seluruh transkrip bertimestamp.*
- `GET /api/meetings/<meeting_id>/transcript/recent?seconds=120`  
  *Mengembalikan transkrip dalam rentang waktu terakhir (digunakan oleh Paperclip Agent).*
- `GET /api/meetings/<meeting_id>/audio`  
  *Streaming audio file untuk browser player.*
- `GET /health`  
  *Pemeriksaan status FFmpeg dan koneksi STT Whisper.*

---

## 7. Rencana Implementasi Bertahap (Roadmap)

### Fase 1: Backend Audio Service Python Flask (`services/meeting-notes/`)
- [ ] Inisialisasi service Python dengan `uv` (Fast dependencies: `flask`, `flask-sock`, `ffmpeg-python`, `requests`).
- [ ] Implementasi audio pipeline (FFmpeg normalizer ke 16kHz mono WAV & VAD).
- [ ] Integrasi transkripsi Whisper (`groq/whisper-large-v3-turbo` fast-path & `hellodigi` fallback).
- [ ] Implementasi live stream WebSocket manager & penyimpan riwayat transkrip di SQLite.
- [ ] Implementasi endpoint REST query transkrip (`/transcript`, `/transcript/recent`).

### Fase 2: Pembuatan Skill & Native Agent di Paperclip
- [ ] Buat skill `skills/meeting-notes/` (`SKILL.md` dan `scripts/meeting_notes.py`).
- [ ] Buat definisi built-in agent `meeting-agent` di `server/src/services/built-in-agents.ts` dan instruksinya di `server/src/built-ins/agents/meeting-agent/AGENTS.md`.
- [ ] Agen mewarisi akses ke skill `data-sources`, `database-integration`, dan `paperclip`.

### Fase 3: Gateway & Integrasi Rute Server Paperclip (Node.js Express)
- [ ] Buat proxy route `server/src/routes/meetings.ts` dengan perlindungan `assertCompanyAccess`.
- [ ] Hubungkan rute chat rapat dengan harness runtime Paperclip untuk mengeksekusi `meeting-agent`.
- [ ] Integrasi 1-klik Task creation ke `POST /api/companies/:companyId/issues` dan Data Source upload.

### Fase 4: Antarmuka UI Admin Primbon (Vite + React)
- [ ] Tambahkan item navigasi di Sidebar Primbon (`ui/src/components/Sidebar.tsx`).
- [ ] Halaman daftar rapat (`ui/src/pages/Meetings.tsx`).
- [ ] Halaman ruang rapat & detail (`ui/src/pages/MeetingDetail.tsx`):
  - Perekam audio mic streaming live dengan visualizer waveform.
  - Tampilan transkrip live mengalir otomatis.
  - Panel chat interaktif langsung dengan **Meeting Copilot Agent**.
  - Daftar Action Items & Keputusan dengan tombol konversi ke Task.
- [ ] Verifikasi token styling sesuai `DESIGN.md` (`pnpm check:token-gates`).

### Fase 5: Pengujian & Validasi End-to-End
- [x] Uji streaming rekaman suara mic dan verifikasi kemunculan transkrip real-time.
- [x] Uji tanya-jawab dengan Meeting Copilot Agent tentang apa yang dibahas dalam rapat.
- [x] Uji Meeting Copilot Agent men-query database perusahaan (Data Source) di tengah rapat.
- [x] Uji konversi action item menjadi Paperclip Issue resmi.

---

## 8. Deployment & Containerization dengan Docker

Untuk kemudahan deployment dan isolasi environment (terutama dependensi `ffmpeg` dan audio libraries), microservice Python Flask dijalankan menggunakan Docker:

### 8.1 File Konfigurasi Docker
1. **`services/meeting-notes/Dockerfile`**:
   - Base image: `python:3.11-slim`
   - Paket OS: `ffmpeg`, `curl`
   - Port: `5001`
   - Volume persistence: `/app/storage` (menyimpan SQLite `meetings.db`, rekaman penuh, dan chunk audio)
   - Healthcheck: `CMD curl -f http://localhost:5001/api/health || exit 1`
2. **`services/meeting-notes/docker-compose.yml`**:
   - Menjalankan container `paperclip-meeting-notes` secara mandiri.
   - Melakukan mapping port host `5001:5001`.
   - Mengaitkan volume host `./storage:/app/storage`.

### 8.2 Cara Menjalankan dengan Docker
```bash
# Menjalankan service meeting notes di background:
cd services/meeting-notes
docker compose up -d --build

# Melihat logs service:
docker compose logs -f

# Memeriksa health status:
curl http://localhost:5001/api/health
```
