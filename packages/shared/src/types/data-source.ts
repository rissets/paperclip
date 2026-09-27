export type DataSourceType = "csv" | "excel" | "rag_document" | "postgres" | "mariadb" | "mysql";
export type DataSourceStatus = "onboarding" | "processing" | "ready" | "error";

export interface DatabaseConnectionConfig {
  type: "postgres" | "mariadb" | "mysql";
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
  ssl?: boolean;
  allowedSchemas?: string[];
  allowedTables?: string[];
}

export interface DatabaseConnectionTestResult {
  success: boolean;
  latencyMs?: number;
  database?: string;
  version?: string;
  serverType?: "postgres" | "mariadb" | "mysql";
  error?: string;
}

export interface TableRelation {
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
  relationType: "one_to_many" | "many_to_one" | "one_to_one";
}

export interface ColumnDefinition {
  name: string;
  dataType: "string" | "number" | "boolean" | "date" | "unknown";
  nullCount: number;
  nullRatio: number;
  distinctCount: number;
  min?: string | number | null;
  max?: string | number | null;
  sampleValues: (string | number | boolean | null)[];
  role: "dimension" | "metric" | "identifier" | "timestamp" | "attribute";
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  foreignKeyTarget?: { table: string; column: string };
}

export interface TableSemanticModel {
  tableName: string;
  description: string;
  dimensions: { name: string; description: string; sampleValues?: string[] }[];
  metrics: { name: string; expression: string; description: string; aggregation: "sum" | "avg" | "count" | "min" | "max" }[];
  primaryKey?: string;
  foreignKeys?: { column: string; foreignTable: string; foreignColumn: string }[];
  relationships?: TableRelation[];
  synonyms: Record<string, string[]>;
}

export interface DataSource {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  sourceType: DataSourceType;
  status: DataSourceStatus;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  storagePath: string | null;
  metadata: Record<string, unknown> | null;
  tables?: DataSourceTable[];
  chunks?: DataSourceChunk[];
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface DataSourceTable {
  id: string;
  dataSourceId: string;
  companyId: string;
  tableName: string;
  rowCount: number;
  columnCount: number;
  schemaDefinition: ColumnDefinition[];
  semanticModel: TableSemanticModel | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface DataSourceRecord {
  id: string;
  tableId: string;
  dataSourceId: string;
  companyId: string;
  rowIndex: number;
  data: Record<string, unknown>;
}

export interface DataSourceChunk {
  id: string;
  dataSourceId: string;
  companyId: string;
  chunkIndex: number;
  title: string | null;
  content: string;
  tokenCount: number;
  metadata: Record<string, unknown> | null;
  embedding?: number[] | null;
  createdAt: string | Date;
}

export interface KnowledgeSearchResult {
  chunkId: string;
  dataSourceId: string;
  dataSourceName: string;
  title: string | null;
  content: string;
  score: number;
  snippet: string;
  tokenCount: number;
}

export interface StructuredQueryResult {
  tableId: string;
  tableName: string;
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  summary?: {
    metrics: Record<string, number>;
  };
}

export interface SqlQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTimeMs: number;
  sql: string;
}
