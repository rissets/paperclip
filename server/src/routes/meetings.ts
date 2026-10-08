import { Router, type Request, type Response } from "express";
import multer from "multer";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { badRequest, notFound, HttpError } from "../errors.js";
import { OnboardingOrchestratorService } from "../services/onboarding-orchestrator.js";
import { issueService } from "../services/issues.js";
import { logActivity } from "../services/activity-log.js";

const upload = multer({
  dest: path.join(os.tmpdir(), "paperclip-meeting-uploads"),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
});

const MEETING_SERVICE_URL = (process.env.MEETING_SERVICE_URL || "http://127.0.0.1:5001").replace(/\/$/, "");

async function callMeetingService(pathname: string, options: RequestInit = {}) {
  const url = `${MEETING_SERVICE_URL}${pathname}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": "curl/8.7.1",
        ...(options.headers || {}),
      },
    });
    return res;
  } catch (err: any) {
    throw new HttpError(502, `Meeting Notes service unavailable at ${MEETING_SERVICE_URL}: ${err.message}`);
  }
}

export function meetingRoutes(db: Db) {
  const router = Router();
  const onboardingOrchestrator = new OnboardingOrchestratorService(db);
  const issuesSvc = issueService(db);

  // 1. List meetings for company
  router.get("/companies/:companyId/meetings", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const serviceRes = await callMeetingService(`/api/meetings?company_id=${encodeURIComponent(companyId)}`);
    const data = await serviceRes.json();
    res.status(serviceRes.status).json(data);
  });

  // 2. Create meeting session
  router.post("/companies/:companyId/meetings", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const { title, id } = req.body || {};
    const serviceRes = await callMeetingService("/api/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_id: companyId,
        title: title || "Untitled Meeting",
        id,
      }),
    });
    const data = await serviceRes.json();
    res.status(serviceRes.status).json(data);
  });

  // 3. Get meeting details
  router.get("/companies/:companyId/meetings/:id", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const meetingId = req.params.id as string;
    const serviceRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}`);
    if (serviceRes.status === 404) throw notFound("Meeting not found");
    const data = await serviceRes.json();
    if (data.company_id && data.company_id !== companyId) {
      throw notFound("Meeting not found in this company");
    }
    res.status(serviceRes.status).json(data);
  });

  // 4. Update meeting metadata
  router.patch("/companies/:companyId/meetings/:id", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const meetingId = req.params.id as string;

    const checkRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}`);
    if (checkRes.status === 404) throw notFound("Meeting not found");
    const existing = await checkRes.json();
    if (existing.company_id && existing.company_id !== companyId) {
      throw notFound("Meeting not found in this company");
    }

    const serviceRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {}),
    });
    const data = await serviceRes.json();
    res.status(serviceRes.status).json(data);
  });

  // 5. Delete meeting
  router.delete("/companies/:companyId/meetings/:id", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const meetingId = req.params.id as string;

    const checkRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}`);
    if (checkRes.status === 404) throw notFound("Meeting not found");
    const existing = await checkRes.json();
    if (existing.company_id && existing.company_id !== companyId) {
      throw notFound("Meeting not found in this company");
    }

    const serviceRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}`, {
      method: "DELETE",
    });
    const data = await serviceRes.json();
    res.status(serviceRes.status).json(data);
  });

  // 6. Get full transcript
  router.get("/companies/:companyId/meetings/:id/transcript", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const meetingId = req.params.id as string;

    const checkRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}`);
    if (checkRes.status === 404) throw notFound("Meeting not found");
    const existing = await checkRes.json();
    if (existing.company_id && existing.company_id !== companyId) {
      throw notFound("Meeting not found in this company");
    }

    const serviceRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}/transcript`);
    const data = await serviceRes.json();
    res.status(serviceRes.status).json(data);
  });

  // 7. Get recent transcript segments (for realtime Copilot listener)
  router.get("/companies/:companyId/meetings/:id/recent", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const meetingId = req.params.id as string;

    const checkRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}`);
    if (checkRes.status === 404) throw notFound("Meeting not found");
    const existing = await checkRes.json();
    if (existing.company_id && existing.company_id !== companyId) {
      throw notFound("Meeting not found in this company");
    }

    const seconds = typeof req.query.seconds === "string" ? req.query.seconds : "120";
    const serviceRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}/transcript/recent?seconds=${encodeURIComponent(seconds)}`);
    const data = await serviceRes.json();
    res.status(serviceRes.status).json(data);
  });

  // 8. Search transcript segments
  router.get("/companies/:companyId/meetings/:id/search", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const meetingId = req.params.id as string;

    const checkRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}`);
    if (checkRes.status === 404) throw notFound("Meeting not found");
    const existing = await checkRes.json();
    if (existing.company_id && existing.company_id !== companyId) {
      throw notFound("Meeting not found in this company");
    }

    const q = typeof req.query.q === "string" ? req.query.q : (typeof req.query.query === "string" ? req.query.query : "");
    const serviceRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}/transcript/search?q=${encodeURIComponent(q)}`);
    const data = await serviceRes.json();
    res.status(serviceRes.status).json(data);
  });

  // 9. Upload audio file for transcription
  router.post("/companies/:companyId/meetings/:id/upload", upload.single("file"), async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const meetingId = req.params.id as string;

    if (!req.file) throw badRequest("No audio file provided");

    const checkRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}`);
    if (checkRes.status === 404) {
      await fs.unlink(req.file.path).catch(() => {});
      throw notFound("Meeting not found");
    }
    const existing = await checkRes.json();
    if (existing.company_id && existing.company_id !== companyId) {
      await fs.unlink(req.file.path).catch(() => {});
      throw notFound("Meeting not found in this company");
    }

    try {
      const fileBytes = await fs.readFile(req.file.path);
      const formData = new FormData();
      const blob = new Blob([fileBytes], { type: req.file.mimetype || "audio/wav" });
      formData.append("file", blob, req.file.originalname || "recording.wav");

      const serviceRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}/upload`, {
        method: "POST",
        body: formData,
      });
      const data = await serviceRes.json();
      res.status(serviceRes.status).json(data);
    } finally {
      await fs.unlink(req.file.path).catch(() => {});
    }
  });

  // 10. Finish live meeting recording
  router.post("/companies/:companyId/meetings/:id/finish", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const meetingId = req.params.id as string;

    const checkRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}`);
    if (checkRes.status === 404) throw notFound("Meeting not found");
    const existing = await checkRes.json();
    if (existing.company_id && existing.company_id !== companyId) {
      throw notFound("Meeting not found in this company");
    }

    const serviceRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}/finish`, {
      method: "POST",
    });
    const data = await serviceRes.json();
    res.status(serviceRes.status).json(data);
  });

  // 11. Audio playback stream with Range support
  router.get("/companies/:companyId/meetings/:id/audio", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const meetingId = req.params.id as string;

    const checkRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}`);
    if (checkRes.status === 404) throw notFound("Meeting not found");
    const existing = await checkRes.json();
    if (existing.company_id && existing.company_id !== companyId) {
      throw notFound("Meeting not found in this company");
    }

    const headers: Record<string, string> = {};
    if (req.headers.range) {
      headers["Range"] = req.headers.range;
    }

    const serviceRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}/audio`, {
      headers,
    });
    if (serviceRes.status === 404) throw notFound("Audio file not found");

    res.status(serviceRes.status);
    serviceRes.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (["content-type", "content-length", "content-range", "accept-ranges"].includes(lower)) {
        res.setHeader(key, val);
      }
    });

    if (serviceRes.body) {
      const reader = serviceRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } else {
      res.end();
    }
  });

  // 12. Ingest meeting notes into Data Sources as RAG Document
  router.post("/companies/:companyId/meetings/:id/sync-datasource", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const meetingId = req.params.id as string;

    const detailRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}`);
    if (detailRes.status === 404) throw notFound("Meeting not found");
    const meeting = await detailRes.json();
    if (meeting.company_id && meeting.company_id !== companyId) {
      throw notFound("Meeting not found in this company");
    }

    const transcriptRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}/transcript`);
    const transcriptData = await transcriptRes.json();
    const segments: any[] = transcriptData.segments || [];

    const formatTime = (secs: number) => {
      const m = Math.floor(secs / 60);
      const s = Math.floor(secs % 60);
      return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    };

    const markdownContent = [
      `# Meeting Notes: ${meeting.title || "Meeting"}`,
      "",
      `- **Meeting ID**: ${meeting.id}`,
      `- **Date**: ${meeting.created_at || new Date().toISOString()}`,
      `- **Duration**: ${Math.round(meeting.duration_seconds || 0)}s`,
      `- **Status**: ${meeting.status}`,
      ...(meeting.summary ? [`- **Summary**: ${meeting.summary}`] : []),
      "",
      "## Transcript",
      "",
      segments.length > 0
        ? segments
            .map(
              (s) =>
                `[${formatTime(s.start_seconds || 0)} - ${formatTime(s.end_seconds || 0)}] **${s.speaker || "Speaker"}**: ${s.text}`
            )
            .join("\n\n")
        : "*No transcript recorded.*",
      "",
    ].join("\n");

    const fileName = `meeting-notes-${meeting.id}.md`;
    const buffer = Buffer.from(markdownContent, "utf-8");
    const result = await onboardingOrchestrator.onboardSource(
      companyId,
      {
        buffer,
        originalname: fileName,
        mimetype: "text/markdown",
        size: buffer.length,
      },
      {
        name: `Meeting: ${meeting.title || meeting.id}`,
        description: `Meeting notes & transcript from meeting "${meeting.title || meeting.id}"`,
      }
    );

    await logActivity(db, {
      companyId,
      actorType: req.actor.type === "agent" ? "agent" : "user",
      actorId: req.actor.type === "agent" ? (req.actor.agentId || "unknown") : (req.actor.userId || "local-board"),
      action: "data_source.created_from_meeting",
      entityType: "data_source",
      entityId: result.id,
      details: { meetingId, meetingTitle: meeting.title },
    });

    res.status(201).json({
      success: true,
      dataSource: result,
    });
  });

  // 13. Create Paperclip task / issue from action item
  router.post("/companies/:companyId/meetings/:id/create-issue", async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(req, companyId);
    const meetingId = req.params.id as string;

    const { title, description, assigneeAgentId, priority, status } = req.body || {};
    if (!title || typeof title !== "string") {
      throw badRequest("Task title is required");
    }

    const checkRes = await callMeetingService(`/api/meetings/${encodeURIComponent(meetingId)}`);
    if (checkRes.status === 404) throw notFound("Meeting not found");
    const meeting = await checkRes.json();
    if (meeting.company_id && meeting.company_id !== companyId) {
      throw notFound("Meeting not found in this company");
    }

    const desc = [
      description || "",
      "",
      `---`,
      `*Originating from Meeting: ${meeting.title || meetingId} (${meetingId})*`,
    ].filter(Boolean).join("\n");

    const issue = await issuesSvc.create(companyId, {
      title: title.trim(),
      description: desc,
      assigneeAgentId: assigneeAgentId || null,
      priority: priority || "medium",
      status: status || "backlog",
    });

    await logActivity(db, {
      companyId,
      actorType: req.actor.type === "agent" ? "agent" : "user",
      actorId: req.actor.type === "agent" ? (req.actor.agentId || "unknown") : (req.actor.userId || "local-board"),
      action: "issue.created_from_meeting",
      entityType: "issue",
      entityId: issue.id,
      details: { meetingId, issueIdentifier: issue.identifier },
    });

    res.status(201).json({
      success: true,
      issue,
    });
  });

  return router;
}
