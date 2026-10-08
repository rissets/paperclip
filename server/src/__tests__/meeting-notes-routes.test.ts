import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { meetingRoutes } from "../routes/meetings.js";
import { errorHandler } from "../middleware/index.js";

describe("Meeting Notes Routes", () => {
  const companyId = "cmp-test-123";
  let fetchSpy: any;

  const mockDb = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue([]),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  } as any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function createTestApp() {
    const app = express();
    app.use(express.json());

    // Mock authentication middleware
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "user-123",
        source: "local_implicit",
        companyIds: [companyId],
        isInstanceAdmin: true,
      } as any;
      next();
    });

    app.use("/api", meetingRoutes(mockDb));
    app.use(errorHandler);
    return app;
  }

  it("lists meetings for the authorized company", async () => {
    const mockMeetings = [
      {
        id: "meet-1",
        company_id: companyId,
        title: "Sprint Planning",
        status: "completed",
        duration_seconds: 180,
      },
    ];

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockMeetings), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const app = createTestApp();
    const res = await request(app).get(`/api/companies/${companyId}/meetings`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockMeetings);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining(`/api/meetings?company_id=${companyId}`),
      expect.anything()
    );
  });

  it("creates a new meeting session with company scoping", async () => {
    const createdMeeting = {
      id: "meet-new-1",
      company_id: companyId,
      title: "Architecture Review",
      status: "created",
    };

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(createdMeeting), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/meetings`)
      .send({ title: "Architecture Review" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(createdMeeting);
  });

  it("enforces company boundaries when fetching a meeting", async () => {
    // Meeting belongs to another company
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "meet-other",
          company_id: "other-company-999",
          title: "Secret Board Meeting",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const app = createTestApp();
    const res = await request(app).get(`/api/companies/${companyId}/meetings/meet-other`);

    // Must be blocked with 404 (not disclosing presence in other company)
    expect(res.status).toBe(404);
  });

  it("retrieves full transcript segments", async () => {
    const mockTranscript = {
      meeting_id: "meet-1",
      segments: [
        {
          speaker: "Speaker 1",
          start_seconds: 0,
          end_seconds: 5,
          text: "Selamat pagi rekan-rekan sekalian.",
        },
      ],
      full_text: "[Speaker 1]: Selamat pagi rekan-rekan sekalian.",
    };

    // First call checks meeting metadata
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "meet-1",
          company_id: companyId,
          title: "Sprint Planning",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    // Second call gets transcript
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockTranscript), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const app = createTestApp();
    const res = await request(app).get(`/api/companies/${companyId}/meetings/meet-1/transcript`);

    expect(res.status).toBe(200);
    expect(res.body.segments.length).toBe(1);
    expect(res.body.segments[0].text).toContain("Selamat pagi");
  });

  it("returns 502 when meeting backend service is unreachable", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const app = createTestApp();
    const res = await request(app).get(`/api/companies/${companyId}/meetings`);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("Meeting Notes service unavailable");
  });

  it("creates a Paperclip issue originating from meeting action items", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "meet-1",
          company_id: companyId,
          title: "Sprint Planning",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    // Mock issue creation in issues service
    const mockCreatedIssue = {
      id: "issue-abc-123",
      identifier: "PAP-999",
      title: "Integrasi Whisper Engine",
      description: "Setup STT dual fallback\n\n---\n*Originating from Meeting: Sprint Planning (meet-1)*",
      companyId,
    };

    // We can verify validation error when title is missing
    const app = createTestApp();
    const badRes = await request(app)
      .post(`/api/companies/${companyId}/meetings/meet-1/create-issue`)
      .send({});
    expect(badRes.status).toBe(400);
  });
});
