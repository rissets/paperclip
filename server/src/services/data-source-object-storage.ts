import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { createStorageService } from "../storage/service.js";
import type { PutFileResult, StorageService } from "../storage/types.js";

let cached: { signature: string; service: StorageService } | undefined;

function configuredStorage(): StorageService | null {
  const endpoint = process.env.DATASOURCE_OBJECT_STORAGE_ENDPOINT?.trim();
  if (!endpoint) return null;

  const bucket = process.env.DATASOURCE_OBJECT_STORAGE_BUCKET?.trim();
  if (!bucket) throw new Error("DATASOURCE_OBJECT_STORAGE_BUCKET is required when datasource object storage is enabled");
  const region = process.env.DATASOURCE_OBJECT_STORAGE_REGION?.trim() || "us-east-1";
  const prefix = process.env.DATASOURCE_OBJECT_STORAGE_PREFIX?.trim() || "data-sources";
  const forcePathStyle = process.env.DATASOURCE_OBJECT_STORAGE_FORCE_PATH_STYLE !== "false";
  const signature = [endpoint, bucket, region, prefix, forcePathStyle].join("\n");
  if (cached?.signature === signature) return cached.service;

  cached = {
    signature,
    service: createStorageService(createS3StorageProvider({
      endpoint,
      bucket,
      region,
      prefix,
      forcePathStyle,
    })),
  };
  return cached.service;
}

export function isDataSourceObjectStorageEnabled(): boolean {
  return Boolean(process.env.DATASOURCE_OBJECT_STORAGE_ENDPOINT?.trim());
}

function requiredMultipartStorage(): StorageService {
  const storage = configuredStorage();
  if (!storage || !storage.createMultipartUpload || !storage.uploadMultipartPart || !storage.completeMultipartUpload || !storage.abortMultipartUpload) {
    throw new Error("Datasource multipart uploads require an S3-compatible object storage provider");
  }
  return storage;
}

export async function createDataSourceMultipartUpload(input: {
  companyId: string;
  sessionId: string;
  fileName: string;
  contentType: string;
  sha256?: string;
}): Promise<{ objectKey: string; uploadId: string }> {
  return requiredMultipartStorage().createMultipartUpload!({
    companyId: input.companyId,
    namespace: `uploads/sessions/${input.sessionId}`,
    originalFilename: input.fileName,
    contentType: input.contentType,
    sha256: input.sha256,
  });
}

export async function uploadDataSourceMultipartPart(input: {
  companyId: string;
  objectKey: string;
  uploadId: string;
  partNumber: number;
  body: Buffer;
}): Promise<{ etag: string }> {
  return requiredMultipartStorage().uploadMultipartPart!(input);
}

export async function completeDataSourceMultipartUpload(input: {
  companyId: string;
  objectKey: string;
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}): Promise<void> {
  await requiredMultipartStorage().completeMultipartUpload!(input);
}

export async function abortDataSourceMultipartUpload(input: {
  companyId: string;
  objectKey: string;
  uploadId: string;
}): Promise<void> {
  await requiredMultipartStorage().abortMultipartUpload!(input);
}

export async function verifyDataSourceObjectManifest(input: {
  companyId: string;
  objectKey: string;
  byteSize: number;
  sha256?: string;
}): Promise<string> {
  const storage = requiredMultipartStorage();
  const head = await storage.headObject(input.companyId, input.objectKey);
  if (!head.exists || head.contentLength !== input.byteSize || (head.sha256 && input.sha256 && head.sha256 !== input.sha256)) {
    throw new Error("Datasource object verification failed: stored size or SHA-256 does not match the upload manifest");
  }
  const object = await storage.getObject(input.companyId, input.objectKey);
  const hash = createHash("sha256");
  let byteSize = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(object.stream, meter, new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
  const sha256 = hash.digest("hex");
  if (byteSize !== input.byteSize || (input.sha256 && sha256 !== input.sha256)) {
    throw new Error("Datasource object verification failed: streamed bytes do not match the upload manifest");
  }
  if (head.sha256 && head.sha256 !== sha256) throw new Error("Datasource object metadata checksum does not match its stored bytes");
  return sha256;
}

export async function readDataSourceObjectHead(companyId: string, objectKey: string) {
  const storage = requiredMultipartStorage();
  return storage.headObject(companyId, objectKey);
}

export async function storeDataSourceFile(input: {
  companyId: string;
  fileName: string;
  contentType: string;
  buffer?: Buffer;
  filePath?: string;
  objectKey?: string;
  sha256?: string;
}): Promise<{ objectKey: string; sha256: string } | null> {
  const storage = configuredStorage();
  if (!storage) return null;
  let stored: PutFileResult;
  if (input.buffer) {
    stored = await storage.putFile({
      companyId: input.companyId,
      namespace: "uploads",
      originalFilename: input.fileName,
      contentType: input.contentType,
      objectKey: input.objectKey,
      body: input.buffer,
    });
  } else if (input.filePath) {
    const byteSize = statSync(input.filePath).size;
    if (byteSize <= 0) throw new Error("Datasource upload is empty");
    let sha256 = input.sha256;
    if (!sha256) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(input.filePath)) hash.update(chunk);
      sha256 = hash.digest("hex");
    }
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Datasource object upload requires a valid SHA-256");
    stored = await storage.putFile({
      companyId: input.companyId,
      namespace: "uploads",
      originalFilename: input.fileName,
      contentType: input.contentType,
      objectKey: input.objectKey,
      body: createReadStream(input.filePath),
      byteSize,
      sha256,
    });
  } else {
    throw new Error("Datasource upload requires a buffer or temporary file path");
  }
  try {
    const persisted = await storage.headObject(input.companyId, stored.objectKey);
    if (!persisted.exists || persisted.contentLength !== stored.byteSize || persisted.sha256 !== stored.sha256) {
      throw new Error("Datasource object verification failed: stored size or SHA-256 does not match the upload manifest");
    }
  } catch (error) {
    await storage.deleteObject(input.companyId, stored.objectKey).catch(() => {});
    throw error;
  }
  return { objectKey: stored.objectKey, sha256: stored.sha256 };
}

export async function readDataSourceFile(companyId: string, objectKey: string, signal?: AbortSignal): Promise<Buffer> {
  const storage = configuredStorage();
  if (!storage) throw new Error("Datasource object storage is not configured");
  if (signal?.aborted) throw new Error("Datasource file download was cancelled");
  const object = await storage.getObject(companyId, objectKey);
  const chunks: Buffer[] = [];
  const abort = () => object.stream.destroy(new Error("Datasource file download was cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for await (const chunk of object.stream) {
      if (signal?.aborted) throw new Error("Datasource file download was cancelled");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export async function downloadDataSourceFileToPath(
  companyId: string,
  objectKey: string,
  destinationPath: string,
  signal?: AbortSignal,
): Promise<{ byteSize: number; sha256: string }> {
  const storage = configuredStorage();
  if (!storage) throw new Error("Datasource object storage is not configured");
  if (signal?.aborted) throw new Error("Datasource file download was cancelled");
  const object = await storage.getObject(companyId, objectKey);
  const hash = createHash("sha256");
  let byteSize = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(object.stream, meter, createWriteStream(destinationPath, { flags: "wx", mode: 0o600 }), { signal });
  return { byteSize, sha256: hash.digest("hex") };
}

export async function deleteDataSourceFile(companyId: string, objectKey: string): Promise<void> {
  const storage = configuredStorage();
  if (!storage) throw new Error("Datasource object storage is not configured");
  await storage.deleteObject(companyId, objectKey);
}
