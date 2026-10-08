import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { dataSourceRoutes } from "../routes/data-sources.js";

describe("semantic mapping review route authorization", () => {
  it("rejects agent credentials before reading or mutating table mapping", async () => {
    const companyId = "company-review";
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "api_key", companyId, agentId: "agent-1" } as typeof req.actor;
      next();
    });
    app.use("/api", dataSourceRoutes({} as any));
    app.use(errorHandler);

    await request(app)
      .post(`/api/companies/${companyId}/data-sources/source-1/tables/table-1/mapping-review`)
      .send({ decision: "approved" })
      .expect(403)
      .expect(({ body }) => expect(body.error).toContain("board operator"));
  });
});
