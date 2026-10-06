import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { storeDataSourceFile } from "../services/data-source-object-storage.js";

describe("datasource object storage verification", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(tempDirectories.map(directory => rm(directory, { recursive: true, force: true })));
    tempDirectories.length = 0;
  });

  async function fixture() {
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-data-source-object-"));
    tempDirectories.push(directory);
    const filePath = path.join(directory, "input.csv");
    const bytes = Buffer.from("id,amount\n1,9\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(filePath, bytes);
    vi.stubEnv("DATASOURCE_OBJECT_STORAGE_ENDPOINT", "http://minio.test");
    vi.stubEnv("DATASOURCE_OBJECT_STORAGE_BUCKET", "data-sources");
    vi.stubEnv("DATASOURCE_OBJECT_STORAGE_REGION", "us-east-1");
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: any) => {
      if (command instanceof PutObjectCommand) return {};
      if (command instanceof HeadObjectCommand) return {
        ContentLength: bytes.length,
        Metadata: { "paperclip-sha256": sha256 },
      };
      if (command instanceof DeleteObjectCommand) return {};
      throw new Error(`Unexpected S3 command ${command.constructor.name}`);
    });
    return { filePath, bytes, sha256, send };
  }

  it("persists and verifies the exact size and SHA-256 in S3 object metadata", async () => {
    const { filePath, bytes, sha256, send } = await fixture();
    const result = await storeDataSourceFile({ companyId: "company-a", fileName: "input.csv", contentType: "text/csv", filePath });

    expect(result).toMatchObject({ sha256 });
    const put = send.mock.calls.map(([command]) => command).find(command => command instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input.ContentLength).toBe(bytes.length);
    expect(put.input.Metadata).toEqual({ "paperclip-sha256": sha256 });
    expect(send.mock.calls.some(([command]) => command instanceof HeadObjectCommand)).toBe(true);
  });

  it("supports deterministic migration keys and rejects keys outside the company prefix", async () => {
    const { filePath, sha256, send } = await fixture();
    const objectKey = `company-a/legacy-migration/source-id/${sha256}`;
    const result = await storeDataSourceFile({
      companyId: "company-a", fileName: "input.csv", contentType: "text/csv", filePath, objectKey, sha256,
    });
    expect(result).toMatchObject({ objectKey, sha256 });
    const put = send.mock.calls.map(([command]) => command).find(command => command instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input.Key).toBe(`data-sources/${objectKey}`);

    await expect(storeDataSourceFile({
      companyId: "company-a", fileName: "input.csv", contentType: "text/csv", filePath,
      objectKey: `another-company/legacy-migration/source-id/${sha256}`, sha256,
    })).rejects.toThrow("Object does not belong to company");
  });

  it("removes an uploaded object when the persisted checksum manifest does not match", async () => {
    const { filePath, send } = await fixture();
    send.mockImplementation(async (command: any) => {
      if (command instanceof PutObjectCommand) return {};
      if (command instanceof HeadObjectCommand) return {
        ContentLength: 2,
        Metadata: { "paperclip-sha256": "0".repeat(64) },
      };
      if (command instanceof DeleteObjectCommand) return {};
      throw new Error(`Unexpected S3 command ${command.constructor.name}`);
    });

    await expect(storeDataSourceFile({ companyId: "company-a", fileName: "input.csv", contentType: "text/csv", filePath }))
      .rejects.toThrow("stored size or SHA-256 does not match");
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(true);
  });
});
