import { File as NodeFile } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dataSourcesApi } from "./data-sources.js";

const companyId = "company-1";
const fileSize = 16 * 1024 * 1024;
const fileName = "orders.csv";
const lastModified = 1_728_000_000_000;
const sessionId = "upload-session-1";
const objectKey = `${companyId}/uploads/sessions/${sessionId}/orders.csv`;

function makeFile(): File {
  return new NodeFile([new Uint8Array(fileSize).fill(7)], fileName, { type: "text/csv", lastModified }) as unknown as File;
}

function makeSession(uploadedParts: Array<{ partNumber: number; byteSize: number; sha256: string }> = []) {
  return {
    id: sessionId,
    companyId,
    fileName,
    expectedBytes: fileSize,
    partSize: fileSize,
    partCount: 1,
    uploadedParts,
    status: "uploading",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function installLocalStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  return values;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resumable datasource file uploads", () => {
  it("uploads a bounded binary part and completes with the browser SHA-256 manifest", async () => {
    const localStorage = installLocalStorage();
    const file = makeFile();
    const expectedSha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
    const completedSource = { id: "source-1", name: "orders" };
    let currentSession = makeSession();
    let completionBody: unknown;
    const binaryParts: Blob[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      if (url.endsWith("/data-source-upload-sessions") && method === "POST") return Response.json(currentSession, { status: 201 });
      if (url.endsWith("/parts/1") && method === "PUT") {
        binaryParts.push(init?.body as Blob);
        currentSession = makeSession([{ partNumber: 1, byteSize: fileSize, sha256: expectedSha }]);
        return Response.json(currentSession);
      }
      if (url.endsWith(`/data-source-upload-sessions/${sessionId}`) && method === "GET") return Response.json(currentSession);
      if (url.endsWith("/complete") && method === "POST") {
        completionBody = JSON.parse(String(init?.body));
        return Response.json(completedSource, { status: 202 });
      }
      throw new Error(`Unexpected datasource upload request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(dataSourcesApi.upload(companyId, file)).resolves.toMatchObject({ id: "source-1" });
    expect(binaryParts[0]).toBeInstanceOf(Blob);
    expect(binaryParts[0]?.size).toBe(fileSize);
    expect(completionBody).toEqual({ partSha256s: [expectedSha] });
    expect(localStorage.size).toBe(0);
  });

  it("discards a same-name, same-size resume session when its saved part differs from the selected file", async () => {
    const localStorage = installLocalStorage();
    const file = makeFile();
    const key = `paperclip:data-source-upload:${companyId}:none:${fileName}:${fileSize}:${lastModified}`;
    localStorage.set(key, "stale-session");
    let currentSession = makeSession();
    let created = 0;
    let aborted = false;
    const expectedSha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      if (url.endsWith("/data-source-upload-sessions/stale-session") && method === "GET") {
        return Response.json({ ...makeSession([{ partNumber: 1, byteSize: fileSize, sha256: "0".repeat(64) }]), id: "stale-session" });
      }
      if (url.endsWith("/data-source-upload-sessions/stale-session") && method === "DELETE") {
        aborted = true;
        return Response.json({ success: true });
      }
      if (url.endsWith("/data-source-upload-sessions") && method === "POST") {
        created++;
        return Response.json(currentSession, { status: 201 });
      }
      if (url.endsWith("/parts/1") && method === "PUT") {
        currentSession = makeSession([{ partNumber: 1, byteSize: fileSize, sha256: expectedSha }]);
        return Response.json(currentSession);
      }
      if (url.endsWith(`/data-source-upload-sessions/${sessionId}`) && method === "GET") return Response.json(currentSession);
      if (url.endsWith("/complete") && method === "POST") return Response.json({ id: "source-2" }, { status: 202 });
      throw new Error(`Unexpected datasource upload request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(dataSourcesApi.upload(companyId, file)).resolves.toMatchObject({ id: "source-2" });
    expect(aborted).toBe(true);
    expect(created).toBe(1);
    expect(localStorage.size).toBe(0);
  });
});

describe("external datasource snapshots", () => {
  it("sends the selected table's incremental watermark and tombstone policy", async () => {
    const body = { success: true, data: { id: "source-1", status: "queued", tableCount: 1, skippedTableCount: 0 } };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(body, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(dataSourcesApi.snapshotExternalDatabase("company-1", "source-1", {
      mode: "incremental",
      tableIds: ["11111111-1111-4111-8111-111111111111"],
      tablePolicies: [{
        tableId: "11111111-1111-4111-8111-111111111111",
        updatedAtColumn: "updated_at",
        deletedAtColumn: "deleted_at",
      }],
    })).resolves.toEqual(body);

    const [url, request] = fetchMock.mock.calls[0]!;
    if (!request) throw new Error("Snapshot API request was not sent");
    expect(String(url)).toContain("/companies/company-1/data-sources/source-1/snapshot");
    expect(request.method).toBe("POST");
    expect(JSON.parse(String(request.body))).toEqual({
      mode: "incremental",
      tableIds: ["11111111-1111-4111-8111-111111111111"],
      tablePolicies: [{
        tableId: "11111111-1111-4111-8111-111111111111",
        updatedAtColumn: "updated_at",
        deletedAtColumn: "deleted_at",
      }],
    });
  });
});

describe("RAG embedding generation migration", () => {
  it("queues a model-generation reindex and can name a retained generation for rollback", async () => {
    const body = { success: true, data: { id: "job-1", jobType: "embedding_reindex", status: "queued" } };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(body, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(dataSourcesApi.reindexEmbeddings(companyId, "source-1", {
      targetSpace: "bge-m3",
      targetGeneration: "bge-m3@previous-revision",
    })).resolves.toEqual(body);

    const [url, request] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/companies/company-1/data-sources/source-1/embedding-reindex");
    expect(request?.method).toBe("POST");
    expect(JSON.parse(String(request?.body))).toEqual({
      targetSpace: "bge-m3",
      targetGeneration: "bge-m3@previous-revision",
    });
  });
});
