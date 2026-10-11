import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface CandidateAgent {
  id: string;
  name: string;
  role?: string | null;
  title?: string | null;
  capabilities?: string | null;
}

export interface ExtractedTicket {
  title: string;
  description: string;
  priority: "urgent" | "high" | "medium" | "low";
  suggestedAgentId: string | null;
  suggestedAgentName: string | null;
  rationale: string;
}

function resolvePiCommand(): string {
  if (process.env.PAPERCLIP_PI_COMMAND && fs.existsSync(process.env.PAPERCLIP_PI_COMMAND)) {
    return process.env.PAPERCLIP_PI_COMMAND;
  }
  const userPi = path.join(os.homedir(), ".local", "bin", "pi");
  if (fs.existsSync(userPi)) return userPi;
  return "pi";
}

async function runPiPrompt(prompt: string, timeoutMs: number = 25_000): Promise<string> {
  const command = resolvePiCommand();
  return new Promise((resolve, reject) => {
    const proc = spawn(command, ["-p", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Pi CLI timed out"));
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Pi CLI exited with code ${code}: ${stderr || stdout}`));
      }
    });
  });
}

function extractJsonObject(text: string): any {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // ignore
    }
  }
  return null;
}

export const meetingIntelligence = {
  async extractTickets(input: {
    meetingTitle: string;
    notes?: string;
    enhancedNotes?: string;
    segments?: Array<{ speaker: string; text: string; start_seconds: number; end_seconds: number }>;
    availableAgents: CandidateAgent[];
  }): Promise<ExtractedTicket[]> {
    const agents = input.availableAgents || [];
    const rosterText = agents.length > 0
      ? agents.map((a) => `- [${a.name}] (ID: ${a.id}) | Role: ${a.role || a.title || "Specialist"} | Kapabilitas: ${(a.capabilities || "").slice(0, 100)}`).join("\n")
      : "- (Tidak ada agen khusus, gunakan general assignment)";

    const transcriptExcerpt = (input.segments || [])
      .slice(-35)
      .map((s) => `[${s.speaker}]: ${s.text}`)
      .join("\n");

    const prompt = `Anda adalah Executive Chief of Staff AI di Paperclip. Analisis notulen dan transkrip rapat berikut dan ekstraksi 1-5 butir tiket tindakan (Action Items) yang konkret dan perlu dieksekusi.

DAFTAR AGEN YANG TERSEDIA:
${rosterText}

INFORMASI RAPAT:
Judul: ${input.meetingTitle}
Notes Manual: ${input.notes || "(Belum ada catatan)"}
Enhanced Notes: ${input.enhancedNotes || "(Belum ada)"}
Transkrip Percakapan:
${transcriptExcerpt || "(Belum ada transkrip)"}

INSTRUKSI:
1. Identifikasi butir-butir tugas yang actionable dan relevan dengan tujuan rapat.
2. Setiap tugas HARUS ditugaskan ke salah satu agen dari daftar di atas yang paling sesuai keahliannya.
3. Berikan alasan (rationale) singkat mengapa agen tersebut yang dipilih.
4. Prioritas: "urgent", "high", "medium", atau "low".

Keluarkan respon STRICTLY JSON dalam format ini:
{
  "tickets": [
    {
      "title": "Judul tugas singkat dan jelas",
      "description": "Deskripsi tugas terstruktur, konteks dari rapat, langkah kerja, dan kriteria selesai",
      "priority": "urgent" | "high" | "medium" | "low",
      "suggestedAgentId": "id-agen-dari-daftar-diatas",
      "suggestedAgentName": "nama-agen-dari-daftar-diatas",
      "rationale": "Alasan mengapa agen ini yang ditugaskan"
    }
  ]
}`;

    try {
      const raw = await runPiPrompt(prompt, 25_000);
      const parsed = extractJsonObject(raw);
      if (parsed && Array.isArray(parsed.tickets) && parsed.tickets.length > 0) {
        return parsed.tickets.map((t: any) => {
          const matchedAgent = agents.find((a) => a.id === t.suggestedAgentId || a.name?.toLowerCase() === t.suggestedAgentName?.toLowerCase());
          return {
            title: String(t.title || "Tindak Lanjut Rapat").trim(),
            description: String(t.description || "").trim(),
            priority: ["urgent", "high", "medium", "low"].includes(t.priority) ? t.priority : "medium",
            suggestedAgentId: matchedAgent ? matchedAgent.id : (agents[0]?.id || null),
            suggestedAgentName: matchedAgent ? matchedAgent.name : (agents[0]?.name || "Unassigned"),
            rationale: String(t.rationale || "Rekomendasi otomatis berdasarkan peran agen").trim(),
          };
        });
      }
    } catch (err: any) {
      console.warn("[meetingIntelligence] Pi extraction failed, falling back to heuristic:", err.message);
    }

    // Heuristic Fallback if Pi fails
    const defaultAgent = agents[0] || null;
    const fallbackTitle = input.notes?.split("\n").find((l) => l.trim().length > 5) || `Tindak Lanjut: ${input.meetingTitle}`;

    return [
      {
        title: fallbackTitle.replace(/^[-*#0-9.\s]+/, "").trim(),
        description: `Diekstrak dari notulen rapat "${input.meetingTitle}".\n\nCatatan:\n${input.notes || input.enhancedNotes || "Perlu tindak lanjut hasil diskusi rapat."}`,
        priority: "medium",
        suggestedAgentId: defaultAgent?.id || null,
        suggestedAgentName: defaultAgent?.name || "Unassigned",
        rationale: defaultAgent ? `Ditugaskan ke ${defaultAgent.name} untuk memimpin eksekusi tindak lanjut.` : "Belum ada agen khusus yang ditugaskan.",
      },
    ];
  },

  async enhanceNotes(input: {
    meetingTitle: string;
    notes: string;
    transcriptSummary?: string;
    style?: string;
  }): Promise<string> {
    const prompt = `Anda adalah Executive Meeting Secretary. Tingkatkan dan rapikan catatan rapat shorthand berikut menjadi notulen rapat eksekutif yang elegan, jelas, dan berstruktur rapi dalam format Markdown.

Gaya: ${input.style || "Standard Executive"}
Judul Rapat: ${input.meetingTitle}

Catatan Shorthand Pengguna:
${input.notes}

${input.transcriptSummary ? `Konteks Percakapan Transkrip Terkini:\n${input.transcriptSummary}\n` : ""}

Instruksi Struktur Markdown:
### Ringkasan & Tujuan Rapat
(Jelaskan objektif utama dalam 1-2 kalimat)

### Poin Pembahasan Utama
(Tuliskan poin-poin diskusi secara terstruktur dengan bullet points)

### Keputusan & Kesepakatan
(Poin keputusan krusial yang dicapai)

### Tindak Lanjut (Action Items)
(Daftar butir tindakan dengan penanggung jawab)

Keluarkan HANYA isi markdown tanpa komentar pembuka atau penutup:`;

    try {
      const raw = await runPiPrompt(prompt, 25_000);
      if (raw && raw.length > 20) {
        return raw.trim();
      }
    } catch (err: any) {
      console.warn("[meetingIntelligence] enhanceNotes failed, formatting raw notes:", err.message);
    }

    // Fallback format
    return [
      `### Ringkasan Rapat: ${input.meetingTitle}`,
      "",
      "#### Catatan Utama",
      input.notes.trim() ? input.notes.split("\n").map((l) => l.startsWith("-") || l.startsWith("#") ? l : `- ${l}`).join("\n") : "- Belum ada catatan yang ditulis.",
      "",
      "#### Tindak Lanjut",
      "- Tinjau hasil pertemuan dan diskusikan langkah selanjutnya.",
    ].join("\n");
  },

  async askCopilot(input: {
    meetingTitle: string;
    notes?: string;
    transcriptText?: string;
    query: string;
  }): Promise<string> {
    const prompt = `Anda adalah Meeting Copilot Agent di Paperclip. Jawab pertanyaan pengguna mengenai rapat berikut secara ramah, akurat, dan berbasis data percakapan.

Data Rapat:
Judul: ${input.meetingTitle}
Catatan Rapat: ${input.notes || "-"}
Transkrip Percakapan:
${(input.transcriptText || "").slice(-2500) || "-"}

Pertanyaan Pengguna:
"${input.query}"

Jawablah secara informatif dalam Bahasa Indonesia:`;

    try {
      const reply = await runPiPrompt(prompt, 20_000);
      if (reply) return reply.trim();
    } catch (err: any) {
      console.warn("[meetingIntelligence] askCopilot failed:", err.message);
    }

    return `Berdasarkan catatan rapat "${input.meetingTitle}", topik yang dibahas mencakup poin-poin yang tercatat di ringkasan. Apakah ada bagian spesifik dari transkrip yang ingin Anda gali lebih dalam?`;
  },
};
