import type {
  DataSource,
  DataSourceCollection,
  DataSourceIngestionJob,
  DataSourceEmbeddingReindexRequest,
  DataSourceUploadSession,
  CollectionSemanticProfile,
  DatabaseConnectionConfig,
  DatabaseConnectionTestResult,
  KnowledgeSearchResult,
  OrchestratorMessage,
  OrchestratorSession,
  SqlQueryResult,
  StructuredQueryResult,
  QueryExecutionListItem,
  DataSourceMappingReviewRequest,
} from "@paperclipai/shared";
import { ApiError, api } from "./client";

export interface UploadDataSourceResponse extends DataSource {
  dataSources?: DataSource[];
  count?: number;
  message?: string;
  collectionId?: string | null;
}

const RESUMABLE_UPLOAD_THRESHOLD = 16 * 1024 * 1024;
const uploadResumeKey = (companyId: string, file: File, collectionId?: string) =>
  `paperclip:data-source-upload:${companyId}:${collectionId || "none"}:${file.name}:${file.size}:${file.lastModified}`;

async function sha256Blob(blob: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Secure browser hashing is unavailable; open Paperclip over HTTPS to upload large files");
  const digest = await subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function readUploadResumeId(key: string): string | null {
  try { return globalThis.localStorage?.getItem(key) || null; } catch { return null; }
}

function writeUploadResumeId(key: string, id: string | null): void {
  try {
    if (!globalThis.localStorage) return;
    if (id) globalThis.localStorage.setItem(key, id);
    else globalThis.localStorage.removeItem(key);
  } catch { /* The server session remains recoverable through its normal expiry cleanup. */ }
}

async function uploadOneResumably(
  companyId: string,
  file: File,
  options: { name?: string; description?: string; collectionId?: string },
): Promise<UploadDataSourceResponse> {
  const key = uploadResumeKey(companyId, file, options.collectionId);
  const sessionPath = (id: string) => `/companies/${encodeURIComponent(companyId)}/data-source-upload-sessions/${encodeURIComponent(id)}`;
  const createSession = () => api.post<DataSourceUploadSession>(`/companies/${encodeURIComponent(companyId)}/data-source-upload-sessions`, {
    fileName: file.name,
    contentType: file.type || "application/octet-stream",
    expectedBytes: file.size,
    ...(options.name ? { name: options.name } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(options.collectionId ? { collectionId: options.collectionId } : {}),
  });
  let session: DataSourceUploadSession | null = null;
  const existingId = readUploadResumeId(key);
  if (existingId) {
    try {
      const existing = await api.get<DataSourceUploadSession>(sessionPath(existingId));
      if (existing.fileName === file.name && existing.expectedBytes === file.size && ["uploading", "completing", "verifying", "completed"].includes(existing.status)) {
        session = existing;
      } else writeUploadResumeId(key, null);
    } catch { writeUploadResumeId(key, null); }
  }
  const clientPartHashes = new Map<number, string>();
  if (session) {
    for (const part of session.uploadedParts) {
      const start = (part.partNumber - 1) * session.partSize;
      const end = Math.min(file.size, start + session.partSize);
      const localSha256 = await sha256Blob(file.slice(start, end));
      if (localSha256 !== part.sha256) {
        if (session.status === "uploading") await api.delete(`${sessionPath(session.id)}`);
        writeUploadResumeId(key, null);
        clientPartHashes.clear();
        session = null;
        break;
      }
      clientPartHashes.set(part.partNumber, localSha256);
    }
  }
  if (!session) {
    session = await createSession();
    writeUploadResumeId(key, session.id);
  }

  const uploaded = new Set(session.uploadedParts.map(part => part.partNumber));
  const partNumbers = Array.from({ length: session.partCount }, (_, index) => index + 1).filter(part => !uploaded.has(part));
  let next = 0;
  const transferPart = async (partNumber: number) => {
    const start = (partNumber - 1) * session!.partSize;
    const blob = file.slice(start, Math.min(file.size, start + session!.partSize));
    const partSha256 = await sha256Blob(blob);
    clientPartHashes.set(partNumber, partSha256);
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await api.putRaw(`${sessionPath(session!.id)}/parts/${partNumber}`, blob);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
      }
    }
    throw lastError;
  };
  const workers = Array.from({ length: Math.min(3, partNumbers.length) }, async () => {
    while (next < partNumbers.length) {
      const partNumber = partNumbers[next++];
      await transferPart(partNumber);
    }
  });
  await Promise.all(workers);

  const partSha256s = Array.from({ length: session.partCount }, (_, index) => clientPartHashes.get(index + 1));
  if (partSha256s.some((partSha256): partSha256 is undefined => partSha256 === undefined)) {
    throw new Error("Could not verify every uploaded part before completing the datasource upload");
  }
  const result = await api.post<UploadDataSourceResponse>(`${sessionPath(session.id)}/complete`, { partSha256s });
  writeUploadResumeId(key, null);
  return result;
}

async function uploadMany(
  companyId: string,
  files: File[],
  options: { name?: string; description?: string; collectionId?: string },
  endpoint: string,
): Promise<UploadDataSourceResponse> {
  if (!files.some(file => file.size >= RESUMABLE_UPLOAD_THRESHOLD)) {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    if (options.name) form.append("name", options.name);
    if (options.description) form.append("description", options.description);
    if (options.collectionId) form.append("collectionId", options.collectionId);
    return api.postForm<UploadDataSourceResponse>(endpoint, form);
  }

  const results: UploadDataSourceResponse[] = [];
  for (const file of files) {
    if (file.size >= RESUMABLE_UPLOAD_THRESHOLD) {
      try {
        results.push(await uploadOneResumably(companyId, file, {
          ...options,
          name: files.length === 1 ? options.name : undefined,
        }));
        continue;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 422 && error.message.includes("S3-compatible object storage"))) throw error;
      }
    }
    const form = new FormData();
    form.append("file", file);
    if (files.length === 1 && options.name) form.append("name", options.name);
    if (options.description) form.append("description", options.description);
    if (options.collectionId) form.append("collectionId", options.collectionId);
    results.push(await api.postForm<UploadDataSourceResponse>(endpoint, form));
  }
  if (results.length === 1) return results[0];
  const sources = results.flatMap(result => result.dataSources || [result]);
  return { ...sources[0], dataSources: sources, count: sources.length, message: `${sources.length} data sources queued for autonomous onboarding` };
}

export const dataSourcesApi = {
  list: (companyId: string, collectionId?: string) =>
    api.get<DataSource[]>(
      `/companies/${encodeURIComponent(companyId)}/data-sources${collectionId ? `?collectionId=${encodeURIComponent(collectionId)}` : ""}`,
    ),

  get: (companyId: string, id: string) =>
    api.get<DataSource>(`/companies/${encodeURIComponent(companyId)}/data-sources/${encodeURIComponent(id)}`),

  upload: (
    companyId: string,
    file: File | File[],
    options: { name?: string; description?: string; collectionId?: string } = {},
  ) => {
    const files = Array.isArray(file) ? file : [file];
    return uploadMany(companyId, files, options, `/companies/${encodeURIComponent(companyId)}/data-sources/upload`);
  },

  delete: (companyId: string, id: string) =>
    api.delete<{ success: boolean; id: string }>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/${encodeURIComponent(id)}`,
    ),

  reprocess: (companyId: string, id: string) =>
    api.post<{ success: boolean; data: DataSource }>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/${encodeURIComponent(id)}/reprocess`,
      {},
    ),

  cancelIngestionJob: (companyId: string, id: string, jobId: string) =>
    api.post<{ success: boolean; data: DataSourceIngestionJob }>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/${encodeURIComponent(id)}/ingestion-jobs/${encodeURIComponent(jobId)}/cancel`,
      {},
    ),

  reindexEmbeddings: (companyId: string, id: string, options: DataSourceEmbeddingReindexRequest) =>
    api.post<{ success: boolean; data: DataSourceIngestionJob }>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/${encodeURIComponent(id)}/embedding-reindex`,
      options,
    ),

  reviewSemanticMapping: (
    companyId: string,
    dataSourceId: string,
    tableId: string,
    request: DataSourceMappingReviewRequest,
  ) =>
    api.post<{
      success: boolean;
      data: { tableId: string; tableName: string; semanticModel: Record<string, unknown> };
    }>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/${encodeURIComponent(dataSourceId)}/tables/${encodeURIComponent(tableId)}/mapping-review`,
      request,
    ),

  pruneEmbeddingGenerations: (
    companyId: string,
    id: string,
    request: { confirm: boolean; expectedGenerations?: Array<{ embeddingSpace: string; embeddingGeneration: string }> },
  ) =>
    api.post<{
      success: boolean;
      data: {
        dryRun: boolean;
        retentionDays: number;
        cutoff: string;
        candidates: Array<{ embeddingSpace: string; embeddingGeneration: string; rowCount: number; lastCreatedAt: string }>;
        candidateVectorRows: number;
        deletedGenerations: Array<{ embeddingSpace: string; embeddingGeneration: string; deletedRows: number }>;
        deletedRows: number;
      };
    }>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/${encodeURIComponent(id)}/embedding-generations/prune`,
      request,
    ),

  snapshotExternalDatabase: (
    companyId: string,
    id: string,
    options: {
      mode?: "full" | "incremental";
      tableIds?: string[];
      tablePolicies?: Array<{ tableId: string; updatedAtColumn: string; deletedAtColumn?: string }>;
    } = {},
  ) =>
    api.post<{ success: boolean; data: { id: string; status: string; tableCount: number; skippedTableCount: number } }>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/${encodeURIComponent(id)}/snapshot`,
      options,
    ),

  reprocessStuck: (companyId: string) =>
    api.post<{ success: boolean; count: number; data: DataSource[] }>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/reprocess-stuck`,
      {},
    ),

  queryTable: (
    companyId: string,
    dataSourceId: string,
    tableId: string,
    params: {
      filter?: Record<string, any>;
      limit?: number;
      offset?: number;
      aggregate?: {
        column: string;
        fn: "sum" | "avg" | "count" | "min" | "max";
        groupBy?: string;
      };
      mode?: "live" | "snapshot";
    } = {},
  ) =>
    api.post<StructuredQueryResult>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/${encodeURIComponent(dataSourceId)}/tables/${encodeURIComponent(tableId)}/query`,
      params,
    ),

  searchKnowledge: (
    companyId: string,
    query: string,
    options: { dataSourceId?: string; limit?: number } = {},
  ) =>
    api.post<KnowledgeSearchResult[]>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/search-knowledge`,
      { query, ...options },
    ),

  listSessions: (companyId: string) =>
    api.get<OrchestratorSession[]>(`/companies/${encodeURIComponent(companyId)}/orchestrator/sessions`),

  createSession: (companyId: string, title?: string) =>
    api.post<OrchestratorSession>(`/companies/${encodeURIComponent(companyId)}/orchestrator/sessions`, { title }),

  getMessages: (companyId: string, sessionId: string) =>
    api.get<OrchestratorMessage[]>(
      `/companies/${encodeURIComponent(companyId)}/orchestrator/sessions/${encodeURIComponent(sessionId)}/messages`,
    ),

  chat: (companyId: string, sessionId: string, message: string) =>
    api.post<OrchestratorMessage>(
      `/companies/${encodeURIComponent(companyId)}/orchestrator/sessions/${encodeURIComponent(sessionId)}/chat`,
      { message },
    ),

  testConnection: (companyId: string, config: DatabaseConnectionConfig) =>
    api.post<DatabaseConnectionTestResult>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/test-connection`,
      config,
    ),

  connectDatabase: (
    companyId: string,
    config: DatabaseConnectionConfig,
    options: { name?: string; description?: string } = {},
  ) =>
    api.post<DataSource>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/connect-database`,
      { config, ...options },
    ),

  querySql: (
    companyId: string,
    dataSourceId: string,
    sql: string,
    limit?: number,
  ) =>
    api.post<SqlQueryResult>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/${encodeURIComponent(dataSourceId)}/query-sql`,
      { sql, limit },
    ),

  connectApi: (
    companyId: string,
    config: any,
    options: { name?: string; description?: string } = {},
  ) =>
    api.post<DataSource>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/connect-api`,
      { config, ...options },
    ),

  connectIot: (
    companyId: string,
    config: any,
    options: { name?: string; description?: string } = {},
  ) =>
    api.post<DataSource>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/connect-iot`,
      { config, ...options },
    ),

  connectCctv: (
    companyId: string,
    config: any,
    options: { name?: string; description?: string } = {},
  ) =>
    api.post<DataSource>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/connect-cctv`,
      { config, ...options },
    ),

  backfillProfiles: (companyId: string) =>
    api.post<{ success: boolean; updatedCount: number }>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/backfill-profiles`,
      {},
    ),

  getClickhouseStatus: (companyId: string) =>
    api.get<{
      ok: boolean;
      version?: string;
      error?: string;
      companyDatabase: string;
      tables: string[];
    }>(`/companies/${encodeURIComponent(companyId)}/data-sources/clickhouse/status`),

  queryClickhouse: (companyId: string, sql: string, limit?: number) =>
    api.post<SqlQueryResult>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/clickhouse/query`,
      { sql, limit },
    ),

  syncClickhouse: (companyId: string, dataSourceId: string) =>
    api.post<{
      success: boolean;
      syncedTables: Array<{ tableName: string; rowCount: number; clickhouseTable: string }>;
      totalRows: number;
      companyDatabase: string;
    }>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/${encodeURIComponent(dataSourceId)}/clickhouse-sync`,
      {},
    ),

  syncAllClickhouse: (companyId: string) =>
    api.post<{
      success: boolean;
      syncedTables: Array<{ tableName: string; rowCount: number; clickhouseTable: string }>;
      totalRows: number;
      companyDatabase: string;
    }>(`/companies/${encodeURIComponent(companyId)}/data-sources/clickhouse/sync-all`, {}),

  // Collections API
  listCollections: (companyId: string) =>
    api.get<DataSourceCollection[]>(
      `/companies/${encodeURIComponent(companyId)}/data-source-collections`,
    ),

  getCollection: (companyId: string, id: string) =>
    api.get<DataSourceCollection>(
      `/companies/${encodeURIComponent(companyId)}/data-source-collections/${encodeURIComponent(id)}`,
    ),

  createCollection: (
    companyId: string,
    data: { name: string; description?: string; color?: string; icon?: string },
  ) =>
    api.post<DataSourceCollection>(
      `/companies/${encodeURIComponent(companyId)}/data-source-collections`,
      data,
    ),

  updateCollection: (
    companyId: string,
    id: string,
    data: { name?: string; description?: string; color?: string; icon?: string },
  ) =>
    api.patch<DataSourceCollection>(
      `/companies/${encodeURIComponent(companyId)}/data-source-collections/${encodeURIComponent(id)}`,
      data,
    ),

  deleteCollection: (companyId: string, id: string) =>
    api.delete<{ success: boolean }>(
      `/companies/${encodeURIComponent(companyId)}/data-source-collections/${encodeURIComponent(id)}`,
    ),

  correlateCollection: (companyId: string, id: string) =>
    api.post<CollectionSemanticProfile>(
      `/companies/${encodeURIComponent(companyId)}/data-source-collections/${encodeURIComponent(id)}/correlate`,
      {},
    ),

  addSourcesToCollection: (companyId: string, id: string, dataSourceIds: string[]) =>
    api.post<DataSourceCollection>(
      `/companies/${encodeURIComponent(companyId)}/data-source-collections/${encodeURIComponent(id)}/add-sources`,
      { dataSourceIds },
    ),

  removeSourceFromCollection: (companyId: string, id: string, dataSourceId: string) =>
    api.post<DataSourceCollection>(
      `/companies/${encodeURIComponent(companyId)}/data-source-collections/${encodeURIComponent(id)}/remove-source`,
      { dataSourceId },
    ),

  uploadToCollection: (
    companyId: string,
    collectionId: string,
    files: File | File[],
    description?: string,
  ) => {
    const fileList = Array.isArray(files) ? files : [files];
    return uploadMany(companyId, fileList, { description, collectionId },
      `/companies/${encodeURIComponent(companyId)}/data-source-collections/${encodeURIComponent(collectionId)}/upload`);
  },

  // Query Experience & Evidence API (P6 & P7)
  getQueryExperiences: (companyId: string, dataSourceId: string, status?: string) =>
    api.get<{ experiences: any[] }>(
      `/companies/${encodeURIComponent(companyId)}/orchestrator/query-experiences?dataSourceId=${encodeURIComponent(dataSourceId)}${status ? `&status=${encodeURIComponent(status)}` : ""}`,
    ),

  getQueryExecutions: (companyId: string, dataSourceId: string, limit = 50) =>
    api.get<{ executions: QueryExecutionListItem[] }>(
      `/companies/${encodeURIComponent(companyId)}/orchestrator/query-executions?dataSourceId=${encodeURIComponent(dataSourceId)}&limit=${Math.min(100, Math.max(1, Math.floor(limit)))}`,
    ),

  promoteQueryExperience: (
    companyId: string,
    dataSourceId: string,
    experienceId: string,
    data: { status: "reference_verified" | "user_approved"; verificationEvidence?: string },
  ) =>
    api.post<{ experience: any }>(
      `/companies/${encodeURIComponent(companyId)}/orchestrator/query-experiences/${encodeURIComponent(experienceId)}/promote`,
      {
        dataSourceId,
        targetStatus: data.status,
        evidence: data.verificationEvidence ? { reviewNote: data.verificationEvidence } : { reviewNote: "Approved by a board operator" },
      },
    ),

  submitQueryFeedback: (
    companyId: string,
    dataSourceId: string,
    executionId: string,
    data: {
      verdict: "correct" | "needs_correction";
      sentiment?: "positive" | "negative";
      comment?: string;
      correctionNote?: string;
      businessFieldsToFix?: string[];
    },
  ) =>
    api.post<{ ok: boolean }>(
      `/companies/${encodeURIComponent(companyId)}/orchestrator/query-executions/${encodeURIComponent(executionId)}/feedback`,
      { ...data, dataSourceId },
    ),
};
