import type {
  DataSource,
  DatabaseConnectionConfig,
  DatabaseConnectionTestResult,
  KnowledgeSearchResult,
  OrchestratorMessage,
  OrchestratorSession,
  SqlQueryResult,
  StructuredQueryResult,
} from "@paperclipai/shared";
import { api } from "./client";

export interface UploadDataSourceResponse extends DataSource {
  dataSources?: DataSource[];
  count?: number;
  message?: string;
}

export const dataSourcesApi = {
  list: (companyId: string) =>
    api.get<DataSource[]>(`/companies/${encodeURIComponent(companyId)}/data-sources`),

  get: (companyId: string, id: string) =>
    api.get<DataSource>(`/companies/${encodeURIComponent(companyId)}/data-sources/${encodeURIComponent(id)}`),

  upload: (
    companyId: string,
    file: File | File[],
    options: { name?: string; description?: string } = {},
  ) => {
    const formData = new FormData();
    if (Array.isArray(file)) {
      for (const f of file) {
        formData.append("files", f);
      }
    } else {
      formData.append("file", file);
    }
    if (options.name) formData.append("name", options.name);
    if (options.description) formData.append("description", options.description);

    return api.postForm<UploadDataSourceResponse>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/upload`,
      formData,
    );
  },

  delete: (companyId: string, id: string) =>
    api.delete<{ success: boolean; id: string }>(
      `/companies/${encodeURIComponent(companyId)}/data-sources/${encodeURIComponent(id)}`,
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
};

