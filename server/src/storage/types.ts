import type { StorageProvider as StorageProviderId } from "@paperclipai/shared";
import type { Readable } from "node:stream";

export interface PutObjectInput {
  objectKey: string;
  // Readable bodies stream straight to the backend (contentLength must be the
  // exact byte size); Buffer stays supported for small payloads.
  body: Buffer | Readable;
  contentType: string;
  contentLength: number;
  /** Stable content identity copied into provider metadata for post-upload verification. */
  sha256?: string;
}

export type MultipartPart = { partNumber: number; etag: string };

export interface CreateMultipartObjectInput {
  objectKey: string;
  contentType: string;
  sha256?: string;
}

export interface UploadMultipartObjectPartInput {
  objectKey: string;
  uploadId: string;
  partNumber: number;
  body: Buffer;
}

export interface CompleteMultipartObjectInput {
  objectKey: string;
  uploadId: string;
  parts: MultipartPart[];
}

export interface GetObjectInput {
  objectKey: string;
  // S3 reads cancel pending requests and their response streams.
  signal?: AbortSignal;
  range?: {
    start: number;
    end: number;
  };
}

export interface GetObjectResult {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  lastModified?: Date;
}

export interface HeadObjectResult {
  exists: boolean;
  contentType?: string;
  contentLength?: number;
  sha256?: string;
  etag?: string;
  lastModified?: Date;
}

export interface StorageProvider {
  id: StorageProviderId;
  putObject(input: PutObjectInput): Promise<void>;
  getObject(input: GetObjectInput): Promise<GetObjectResult>;
  headObject(input: GetObjectInput): Promise<HeadObjectResult>;
  deleteObject(input: GetObjectInput): Promise<void>;
  createMultipartUpload?(input: CreateMultipartObjectInput): Promise<{ uploadId: string }>;
  uploadMultipartPart?(input: UploadMultipartObjectPartInput): Promise<{ etag: string }>;
  completeMultipartUpload?(input: CompleteMultipartObjectInput): Promise<void>;
  abortMultipartUpload?(input: Pick<CompleteMultipartObjectInput, "objectKey" | "uploadId">): Promise<void>;
}

export type PutFileInput = {
  /** Server-allocated, company-prefixed key for durable idempotent uploads. Never accept from client input. */
  objectKey?: string;
  companyId: string;
  namespace: string;
  originalFilename: string | null;
  contentType: string;
  /** Optional deterministic company-scoped key for resumable operator migrations. */
  objectKey?: string;
} & ({ body: Buffer } | { body: Readable; byteSize: number; sha256: string });

export interface PutFileResult {
  provider: StorageProviderId;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
}

export interface StorageService {
  provider: StorageProviderId;
  putFile(input: PutFileInput): Promise<PutFileResult>;
  getObject(companyId: string, objectKey: string, options?: Pick<GetObjectInput, "range">): Promise<GetObjectResult>;
  headObject(companyId: string, objectKey: string): Promise<HeadObjectResult>;
  deleteObject(companyId: string, objectKey: string): Promise<void>;
  createMultipartUpload?(input: {
    companyId: string;
    namespace: string;
    originalFilename: string;
    contentType: string;
    sha256?: string;
  }): Promise<{ objectKey: string; uploadId: string }>;
  uploadMultipartPart?(input: UploadMultipartObjectPartInput & { companyId: string }): Promise<{ etag: string }>;
  completeMultipartUpload?(input: CompleteMultipartObjectInput & { companyId: string }): Promise<void>;
  abortMultipartUpload?(input: { companyId: string; objectKey: string; uploadId: string }): Promise<void>;
}
