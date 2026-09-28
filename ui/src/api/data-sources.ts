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

export const dataSourcesApi = {
  list: (companyId: string) =>
    api.get<DataSource[]>(`/companies/${encodeURIComponent(companyId)}/data-sources`),

  get: (companyId: string, id: string) =>
    api.get<DataSource>(`/companies/${encodeURIComponent(companyId)}/data-sources/${encodeURIComponent(id)}`),

  upload: (
    companyId: string,
    file: File,
    options: { name?: string; description?: string } = {},
  ) => {
    const formData = new FormData();
    formData.append("file", file);
    if (options.name) formData.append("name", options.name);
    if (options.description) formData.append("description", options.description);

    return api.postForm<DataSource>(`/companies/${encodeURIComponent(companyId)}/data-sources/upload`, formData);
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
};
