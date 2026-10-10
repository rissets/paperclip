import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiReasoningService,
  buildPiReasoningArguments,
  sanitizeDatabaseSchemaSamples,
  validateDatabaseObservationRequests,
} from "./ai-reasoning.js";

const validResponse = JSON.stringify({ domain: "network", table: "ran_kpi" });
const validator = (value: unknown) => ({ valid: true, errors: [], sanitized: value as { domain: string; table: string } });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AiReasoningService runtime selection", () => {
  it("prefers local Pi for Pi-backed agents and appends resolved instruction content", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ai-reasoning-"));
    const instructionsPath = path.join(temporaryDirectory, "AGENTS.md");
    const instructions = "Map one table at a time and preserve identifiers.";
    await fs.writeFile(instructionsPath, instructions, { mode: 0o600 });

    try {
      const service = new AiReasoningService();
      const pi = vi.spyOn(service as any, "runViaPiCli").mockResolvedValue(validResponse);
      const router = vi.spyOn(service as any, "runViaRouterHttp").mockResolvedValue(validResponse);
      const result = await service.executeAgenticLoop("table mapping", "Map table ran_kpi", validator, {
        adapterType: "pi_local",
        model: "rissets/llm-hd/qwen3.8-27b",
        instructionsPath,
      });

      expect(pi).toHaveBeenCalledWith(
        "Map table ran_kpi",
        "rissets/llm-hd/qwen3.8-27b",
        instructions,
        undefined,
        undefined,
      );
      expect(router).not.toHaveBeenCalled();
      expect(result.backend).toBe("pi_cli");
      expect(result.validationStatus).toBe("validated");
      expect(result.reasoningSteps.at(-1)?.backend).toBe("pi_cli");
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("records the router as the explicit fallback when local Pi fails", async () => {
    const service = new AiReasoningService();
    (service as any).routerApiKey = "test-key";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pi = vi.spyOn(service as any, "runViaPiCli").mockRejectedValue(new Error("spawn pi ENOENT"));
    const router = vi.spyOn(service as any, "runViaRouterHttp").mockResolvedValue(validResponse);

    const result = await service.executeAgenticLoop("table mapping", "Map table ran_kpi", validator, {
      adapterType: "pi_local",
      model: "test/pi-router-fallback",
    });

    expect(pi).toHaveBeenCalledOnce();
    expect(router).toHaveBeenCalledOnce();
    expect(result.backend).toBe("router_http");
    expect(result.validationStatus).toBe("validated");
    expect(result.reasoningSteps.at(-1)?.backend).toBe("router_http");
  });

  it("applies bounded Pi and router deadlines to a datasource mapping call", async () => {
    const service = new AiReasoningService();
    (service as any).routerApiKey = "test-key";
    const pi = vi.spyOn(service as any, "runViaPiCli").mockRejectedValue(new Error("Pi execution timed out (75s)"));
    const router = vi.spyOn(service as any, "runViaRouterHttp").mockResolvedValue(validResponse);

    const result = await service.executeAgenticLoop("table mapping", "Map table ran_kpi", validator, {
      adapterType: "pi_local",
      model: `test/bounded-timeouts-${Date.now()}`,
      maxRetries: 1,
      piTimeoutMs: 75_000,
      routerTimeoutMs: 45_000,
    });

    expect(pi).toHaveBeenCalledWith("Map table ran_kpi", expect.any(String), "", undefined, 75_000);
    expect(router).toHaveBeenCalledWith("Map table ran_kpi", expect.any(String), undefined, "", 45_000);
    expect(result.backend).toBe("router_http");
    expect(result.validationStatus).toBe("validated");
  });

  it("keeps upstream request disconnects distinct from local inference timeouts", async () => {
    const service = new AiReasoningService();
    (service as any).routerApiKey = "test-key";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pi = vi.spyOn(service as any, "runViaPiCli").mockRejectedValue(new Error(
      "Pi exited with code 1: Client disconnected: request_signal_aborted",
    ));
    const router = vi.spyOn(service as any, "runViaRouterHttp").mockResolvedValue(validResponse);

    const result = await service.executeAgenticLoop("table mapping", "Map table ran_kpi", validator, {
      adapterType: "pi_local",
      model: `test/disconnected-request-${Date.now()}`,
      maxRetries: 1,
      logContext: "schema mapping group 1/14",
    });

    expect(pi).toHaveBeenCalledOnce();
    expect(router).toHaveBeenCalledOnce();
    expect(result.backend).toBe("router_http");
    expect(result.validationStatus).toBe("validated");
    const diagnostics = `${JSON.stringify(result.reasoningSteps)} ${JSON.stringify(warn.mock.calls)}`;
    expect(diagnostics).toContain("schema mapping group 1/14");
    expect(diagnostics).toContain("Pi CLI request was disconnected before completion");
    expect(diagnostics).not.toContain("inference timed out");
    expect(diagnostics).not.toContain("request_signal_aborted");
  });

  it("stops provider-failure retries and keeps authentication and gateway details out of agent logs", async () => {
    const service = new AiReasoningService();
    (service as any).routerApiKey = "test-key";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pi = vi.spyOn(service as any, "runViaPiCli").mockRejectedValue(new Error(
      'Pi exited with code 1: 401: {"message":"No active credentials for provider: private-provider-id"}',
    ));
    const router = vi.spyOn(service as any, "runViaRouterHttp").mockRejectedValue(new Error(
      "HTTP 502: <!doctype html><title>Cloudflare edge failure</title>",
    ));

    const result = await service.executeAgenticLoop("provider failure", "Map one table", validator, {
      adapterType: "pi_local",
      model: `test/provider-failure-${Date.now()}`,
      maxRetries: 3,
      logContext: "schema mapping group 2/14",
    });

    expect(pi).toHaveBeenCalledOnce();
    expect(router).toHaveBeenCalledOnce();
    expect(result.iterations).toBe(1);
    expect(result.validationStatus).toBe("failed");
    const diagnostics = `${JSON.stringify(result.reasoningSteps)} ${JSON.stringify(warn.mock.calls)}`;
    expect(diagnostics).toContain("credentials are not accepted (HTTP 401)");
    expect(diagnostics).toContain("router is temporarily unavailable (HTTP 502)");
    expect(diagnostics).toContain("schema mapping group 2/14");
    expect(diagnostics).not.toContain("private-provider-id");
    expect(diagnostics).not.toContain("Cloudflare");
  });

  it("honors model cooldowns across schema batches and skips same-model fallback calls", async () => {
    const service = new AiReasoningService();
    (service as any).routerApiKey = "test-key";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const model = `test/cooldown-${Date.now()}`;
    const pi = vi.spyOn(service as any, "runViaPiCli").mockRejectedValue(new Error(
      'Pi exited with code 1: 429: {"message":"model cooling down","reset_seconds":56}',
    ));
    const router = vi.spyOn(service as any, "runViaRouterHttp").mockResolvedValue(validResponse);

    const first = await service.executeAgenticLoop("first batch", "Map table one", validator, {
      adapterType: "pi_local",
      model,
      maxRetries: 3,
    });
    const second = await service.executeAgenticLoop("second batch", "Map table two", validator, {
      adapterType: "pi_local",
      model,
      maxRetries: 3,
    });

    expect(first.iterations).toBe(1);
    expect(second.iterations).toBe(0);
    expect(pi).toHaveBeenCalledOnce();
    expect(router).not.toHaveBeenCalled();
  });

  it("does not expose the router response body when an HTTP request fails", async () => {
    const service = new AiReasoningService();
    (service as any).routerApiKey = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "<html>private edge diagnostics</html>",
      { status: 502, headers: { "content-type": "text/html" } },
    )));

    const error = await (service as any).runViaRouterHttp("prompt", "test/router").catch((value: unknown) => value);
    expect(error).toMatchObject({ message: "Router request failed with HTTP 502" });
    expect((error as Error).message).not.toContain("private edge diagnostics");
  });

  it("keeps router-first behavior for agents configured with another adapter", async () => {
    const service = new AiReasoningService();
    const router = vi.spyOn(service as any, "runViaRouterHttp").mockResolvedValue(validResponse);
    const pi = vi.spyOn(service as any, "runViaPiCli").mockResolvedValue(validResponse);

    const result = await service.executeAgenticLoop("table mapping", "Map table ran_kpi", validator, {
      adapterType: "codex_local",
    });

    expect(router).toHaveBeenCalledOnce();
    expect(pi).not.toHaveBeenCalled();
    expect(result.backend).toBe("router_http");
  });

  it("marks exhausted invalid output as best-effort so ingestion cannot mistake it for a validated mapping", async () => {
    const service = new AiReasoningService();
    vi.spyOn(service as any, "runViaPiCli").mockResolvedValue(validResponse);
    const invalidValidator = () => ({ valid: false, errors: ["semantic evidence is incomplete"], sanitized: { domain: "network" } });

    const result = await service.executeAgenticLoop("table mapping", "Map one table", invalidValidator, {
      adapterType: "pi_local",
      model: "test/best-effort",
      maxRetries: 1,
    });

    expect(result.result).toEqual({ domain: "network" });
    expect(result.validationStatus).toBe("best_effort");
  });

  it("disables Pi tools for the bounded schema-mapping request", () => {
    expect(buildPiReasoningArguments("return JSON", "rissets/llm-hd/qwen3.8-27b", "agent instructions")).toEqual([
      "--model", "rissets/llm-hd/qwen3.8-27b",
      "--no-session",
      "--no-extensions",
      "--no-tools",
      "--append-system-prompt", "agent instructions",
      "-p", "return JSON",
    ]);
  });

  it("fails before inference when configured instructions cannot be read", async () => {
    const service = new AiReasoningService();
    const pi = vi.spyOn(service as any, "runViaPiCli").mockResolvedValue(validResponse);
    const router = vi.spyOn(service as any, "runViaRouterHttp").mockResolvedValue(validResponse);

    await expect(service.executeAgenticLoop("table mapping", "Map table ran_kpi", validator, {
      adapterType: "pi_local",
      instructionsPath: path.join(os.tmpdir(), "paperclip-missing-instructions.md"),
    })).rejects.toThrow("Could not load Ingestion Agent instructions");

    expect(pi).not.toHaveBeenCalled();
    expect(router).not.toHaveBeenCalled();
  });

  it("stops before model execution when the onboarding job is already cancelled", async () => {
    const service = new AiReasoningService();
    const controller = new AbortController();
    controller.abort();
    const pi = vi.spyOn(service as any, "runViaPiCli").mockResolvedValue(validResponse);
    const router = vi.spyOn(service as any, "runViaRouterHttp").mockResolvedValue(validResponse);

    await expect(service.executeAgenticLoop("table mapping", "Map table ran_kpi", validator, {
      adapterType: "pi_local",
      model: "test/cancelled-pi",
      signal: controller.signal,
    })).rejects.toThrow("Agentic reasoning was cancelled");

    expect(pi).not.toHaveBeenCalled();
    expect(router).not.toHaveBeenCalled();
  });

  it("does not start router fallback after Pi is cancelled in flight", async () => {
    const service = new AiReasoningService();
    (service as any).routerApiKey = "test-key";
    const controller = new AbortController();
    const pi = vi.spyOn(service as any, "runViaPiCli").mockImplementation(async () => {
      controller.abort();
      throw new Error("Pi execution aborted by caller");
    });
    const router = vi.spyOn(service as any, "runViaRouterHttp").mockResolvedValue(validResponse);

    await expect(service.executeAgenticLoop("table mapping", "Map table ran_kpi", validator, {
      adapterType: "pi_local",
      model: "test/cancelled-in-flight-pi",
      signal: controller.signal,
    })).rejects.toThrow("Agentic reasoning was cancelled");

    expect(pi).toHaveBeenCalledOnce();
    expect(router).not.toHaveBeenCalled();
  });

  it("propagates worker cancellation into database schema reasoning", async () => {
    const service = new AiReasoningService();
    const controller = new AbortController();
    const execute = vi.spyOn(service, "executeAgenticLoop").mockResolvedValue({
      result: null,
      iterations: 0,
      reasoningSteps: [],
      validationStatus: "failed",
    });

    await service.analyzeDatabaseSchema("postgres", "warehouse", [], {
      signal: controller.signal,
      piTimeoutMs: 8_000,
      routerTimeoutMs: 40_000,
      logContext: "schema mapping group 1/1",
    });

    expect(execute.mock.calls.at(-1)?.[3]).toMatchObject({
      signal: controller.signal,
      piTimeoutMs: 8_000,
      routerTimeoutMs: 40_000,
      logContext: "schema mapping group 1/1",
    });
  });

  it("uses frozen instruction content supplied by a multi-batch mapping job", async () => {
    const service = new AiReasoningService();
    const execute = vi.spyOn(service, "executeAgenticLoop").mockResolvedValue({
      result: null,
      iterations: 0,
      reasoningSteps: [],
      validationStatus: "failed",
    });
    await service.analyzeDatabaseSchema("postgres", "warehouse", [], {
      instructionsPath: "/must/not/read/during/frozen-mapping.md",
      instructionsContent: "Use schema-qualified names and preserve source identifiers.",
    });

    expect(execute.mock.calls.at(-1)?.[3]).toMatchObject({
      instructionsPath: "/must/not/read/during/frozen-mapping.md",
      instructionsContent: "Use schema-qualified names and preserve source identifiers.",
    });
  });

  it("keeps every supplied column and explicit foreign-key target in the bounded schema prompt", async () => {
    const service = new AiReasoningService();
    const execute = vi.spyOn(service as any, "executeAgenticLoop").mockResolvedValue({
      result: null,
      iterations: 0,
      reasoningSteps: [],
      validationStatus: "failed",
    });
    const columns: Array<{
      name: string;
      dataType: string;
      isPrimary?: boolean;
      isForeign?: boolean;
      references?: string;
      sampleValues?: unknown[];
      distinctCount?: number;
      nullRatio?: number;
      role?: string;
    }> = Array.from({ length: 20 }, (_, index) => ({
      name: `column_${index + 1}`,
      dataType: "string",
    }));
    columns[0] = { name: "status", dataType: "string", sampleValues: ["active", "closed"], distinctCount: 2, nullRatio: 0 };
    columns[19] = {
      name: "customer_id",
      dataType: "number",
      isForeign: true,
      references: "customers.id",
      sampleValues: [123456],
    };

    await service.analyzeDatabaseSchema("postgres", "warehouse", [{
      tableName: "orders",
      rowCount: 500,
      columns,
    }]);

    const prompt = execute.mock.calls.at(-1)?.[1] as string;
    expect(prompt).toContain('safe samples=["active","closed"]');
    expect(prompt).toContain("[redacted number samples]");
    expect(prompt).not.toContain("123456");
    expect(prompt).toContain("column_19 (string)");
    expect(prompt).toContain("customer_id (number [FK->customers.id]; safe samples=[\"[redacted number samples]\"])");
    expect(prompt).not.toContain("more columns");
  });

  it("redacts identifier and contact samples before database values enter the model prompt", () => {
    expect(sanitizeDatabaseSchemaSamples("nama_pelanggan", ["Budi Santoso"], { dataType: "string" }))
      .toEqual(["[redacted string samples]"]);
    expect(sanitizeDatabaseSchemaSamples("nik", ["3174010101900001"], { dataType: "string" }))
      .toEqual(["[redacted string samples]"]);
    expect(sanitizeDatabaseSchemaSamples("customer_email", ["person@example.com"], { dataType: "string" }))
      .toEqual(["[redacted string samples]"]);
    expect(sanitizeDatabaseSchemaSamples("status", ["active", "person@example.com"], { dataType: "string" }))
      .toEqual(["active", "[redacted email-like sample]"]);
    expect(sanitizeDatabaseSchemaSamples("amount", [10, 20, 30, 40], { dataType: "number" })).toEqual([10, 20, 30]);
  });
});

describe("bounded external database observation plans", () => {
  const inspectedTables = [{
    tableName: "public.orders",
    columns: [
      { name: "status", role: "dimension" },
      { name: "amount", role: "metric" },
      { name: "order_id", isPrimary: true, role: "identifier" },
      { name: "customer_email", role: "attribute" },
    ],
  }];

  it("accepts only unique sample requests bound to inspected non-sensitive columns", () => {
    const result = validateDatabaseObservationRequests([
      { tableName: "public.orders", columnName: "status", method: "sample_values", reason: "Values reveal the operational status vocabulary." },
      { tableName: "public.orders", columnName: "status", method: "sample_values", reason: "Duplicate request." },
    ], inspectedTables);

    expect(result.errors).toEqual([]);
    expect(result.requests).toEqual([{
      tableName: "public.orders",
      columnName: "status",
      method: "sample_values",
      reason: "Values reveal the operational status vocabulary.",
    }]);
  });

  it.each([
    ["unknown column", [{ tableName: "public.orders", columnName: "not_a_column", method: "sample_values", reason: "Need more evidence for classification." }]],
    ["primary key", [{ tableName: "public.orders", columnName: "order_id", method: "sample_values", reason: "Need more evidence for classification." }]],
    ["sensitive column", [{ tableName: "public.orders", columnName: "customer_email", method: "sample_values", reason: "Need more evidence for classification." }]],
    ["unsupported method", [{ tableName: "public.orders", columnName: "status", method: "run_sql", reason: "Need more evidence for classification." }]],
  ])("rejects %s observation requests", (_label, requests) => {
    const result = validateDatabaseObservationRequests(requests, inspectedTables);
    expect(result.errors).not.toHaveLength(0);
    expect(result.requests).toEqual([]);
  });

  it("caps observation requests and disallows another request during final validation", () => {
    const requests = ["status", "amount", "status2", "amount2", "too_many"].map((columnName) => ({
      tableName: "public.orders", columnName, method: "sample_values", reason: "Need additional evidence for the mapping.",
    }));
    expect(validateDatabaseObservationRequests(requests, inspectedTables).errors[0]).toMatch(/At most 4/);
    expect(validateDatabaseObservationRequests(
      [{ tableName: "public.orders", columnName: "status", method: "sample_values", reason: "Need additional evidence for mapping." }],
      inspectedTables,
      false,
    ).errors).toContain("Follow-up mapping must not request additional observations");
  });

  it("returns a requested bounded observation plan from a validated per-table mapping", async () => {
    const service = new AiReasoningService();
    const request = {
      tableName: "public.orders",
      columnName: "status",
      method: "sample_values",
      reason: "The initial sample does not establish the operational status vocabulary.",
    };
    const response = JSON.stringify({
      domain: "Commerce operations",
      entities: ["Order"],
      primaryTopics: ["Order lifecycle", "Order volume"],
      tableRoles: { "public.orders": "fact_table" },
      relationships: [],
      suggestedQueries: [],
      reasoningSummary: "Status values need one bounded observation before final classification.",
      observationRequests: [request],
    });
    const pi = vi.spyOn(service as any, "runViaPiCli").mockResolvedValue(response);
    const result = await service.analyzeDatabaseSchema("postgres", "commerce", [{
      tableName: "public.orders",
      rowCount: 100,
      columns: [{ name: "status", dataType: "string", sampleValues: ["pending"] }],
    }], { adapterType: "pi_local", model: "test/observation-plan", allowDatabaseObservations: true });

    expect(result.validationStatus).toBe("validated");
    expect(result.result?.observationRequests).toEqual([request]);
    expect(pi.mock.calls[0]?.[0]).toContain("bounded sample_values observations");
  });

  it("uses sanitized follow-up samples and requires a final response without new requests", async () => {
    const service = new AiReasoningService();
    const response = JSON.stringify({
      domain: "Commerce operations",
      entities: ["Order"],
      primaryTopics: ["Order lifecycle", "Order volume"],
      tableRoles: { "public.orders": "fact_table" },
      relationships: [],
      suggestedQueries: [],
      reasoningSummary: "Final mapping uses the supplied observation.",
      observationRequests: [],
    });
    const pi = vi.spyOn(service as any, "runViaPiCli").mockResolvedValue(response);
    const result = await service.analyzeDatabaseSchema("postgres", "commerce", [{
      tableName: "public.orders",
      rowCount: 100,
      columns: [{ name: "status", dataType: "string", observedValues: ["paid@example.com"] }],
    }], { adapterType: "pi_local", model: "test/observation-followup", databaseObservationFollowup: true });

    const prompt = pi.mock.calls[0]?.[0] as string;
    expect(result.validationStatus).toBe("validated");
    expect(result.result?.observationRequests).toEqual([]);
    expect(prompt).toContain("bounded follow-up samples=[\"[redacted email-like sample]\"]");
    expect(prompt).not.toContain("paid@example.com");
    expect(prompt).toContain("Do not ask for another observation");
  });

  it("does not advertise observations when a caller has no observer wired", async () => {
    const service = new AiReasoningService();
    const response = JSON.stringify({
      domain: "Commerce operations",
      entities: ["Order"],
      primaryTopics: ["Order lifecycle", "Order volume"],
      tableRoles: { "public.orders": "fact_table" },
      relationships: [],
      suggestedQueries: [],
      reasoningSummary: "The supplied catalog evidence is sufficient.",
      observationRequests: [],
    });
    const pi = vi.spyOn(service as any, "runViaPiCli").mockResolvedValue(response);
    const result = await service.analyzeDatabaseSchema("postgres", "commerce", [{
      tableName: "public.orders",
      rowCount: 100,
      columns: [{ name: "status", dataType: "string", sampleValues: ["paid"] }],
    }], { adapterType: "pi_local", model: "test/no-observation" });

    expect(result.validationStatus).toBe("validated");
    expect(result.result?.observationRequests).toEqual([]);
    expect(pi.mock.calls[0]?.[0]).toContain("No observation tool is available in this call");
  });
});
