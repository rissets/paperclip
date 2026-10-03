export type DataSourceType =
  | "csv"
  | "excel"
  | "rag_document"
  | "postgres"
  | "mariadb"
  | "mysql"
  | "clickhouse"
  | "api_rest"
  | "mqtt_iot"
  | "cctv_feed";
export type DataSourceStatus = "onboarding" | "processing" | "ready" | "error";

export interface DatabaseConnectionConfig {
  type: "postgres" | "mariadb" | "mysql" | "clickhouse";
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
  ssl?: boolean;
  allowedSchemas?: string[];
  allowedTables?: string[];
}

export interface ApiConnectionConfig {
  baseUrl: string;
  authType?: "bearer" | "basic" | "api_key" | "none";
  apiKey?: string;
  headerName?: string;
  headers?: Record<string, string>;
  openApiUrl?: string;
}

export interface IotConnectionConfig {
  brokerUrl: string;
  clientId?: string;
  username?: string;
  password?: string;
  topics: string[];
}

export interface CctvConnectionConfig {
  streamUrl: string;
  frigateUrl?: string;
  cameraName: string;
  location?: string;
}

export interface SemanticMetric {
  name: string;
  column?: string;
  expression?: string;
  aggregation: "sum" | "avg" | "count" | "min" | "max";
  format?: string;
  description?: string;
  synonyms?: string[];
}

export interface SemanticDimension {
  name: string;
  column?: string;
  type?: string;
  description?: string;
  sampleValues?: string[];
}

export interface OnboardingReasoningStep {
  stage: number;
  name: string;
  agent: string;
  thought: string;
  decisionSpec?: string;
  findings?: Record<string, any>;
  durationMs?: number;
}

export interface SuggestedQueryTemplate {
  title: string;
  query: string;
  category: "aggregation" | "filtering" | "legal_profiling" | "json_extraction" | "trend" | "general";
  sqlSnippet?: string;
  description?: string;
}

export interface TableSemanticProfile {
  tableName: string;
  tableRole?: "fact_table" | "dimension_table" | "lookup_table" | "bridge_table";
  context?: string;
  topics?: string[];
  entities?: string[];
  decisionSpecRefs?: string[];
  relationships?: TableRelation[];
  metrics?: SemanticMetric[];
  dimensions?: SemanticDimension[];
  suggestedQueries?: SuggestedQueryTemplate[];
  sampleRowCount?: number;
}

export interface CrossTableCluster {
  clusterName: string;
  description: string;
  tables: string[];
  topics: string[];
}

export interface DocumentSemanticProfile {
  id?: string;
  title: string;
  domain?: string;
  context?: string;
  topics?: string[];
  entities?: string[];
  chunkCount?: number;
  wordCount?: number;
  decisionSpecRefs?: string[];
}

export interface DataSourceSemanticProfile {
  version: string;
  onboardedBy: string;
  decisionSpecRefs: string[];
  domain?: string;
  targetAgentAffinity?: string;
  entities: string[];
  metrics?: SemanticMetric[];
  dimensions?: SemanticDimension[];
  primaryTopics?: string[];
  topics?: string[];
  tableRoles?: Record<string, string>;
  relationships?: TableRelation[];
  summary: string;
  onboardedAt: string;
  reasoningSteps?: OnboardingReasoningStep[];
  suggestedQueries?: SuggestedQueryTemplate[];
  jsonStructures?: Record<string, JsonColumnStructure>;
  tableProfiles?: Record<string, TableSemanticProfile>;
  crossTableClusters?: CrossTableCluster[];
  documentProfiles?: DocumentSemanticProfile[];
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

export interface JsonSubField {
  name: string;
  dataType: "string" | "number" | "boolean" | "date" | "unknown";
  sampleValues: (string | number | boolean | null)[];
  description?: string;
}

export interface JsonColumnStructure {
  isJson: boolean;
  kind: "object" | "array_of_objects" | "primitive_array" | "scalar";
  subFields: JsonSubField[];
  clickhouseType: string;
}

export interface ColumnDefinition {
  name: string;
  dataType: "string" | "number" | "boolean" | "date" | "json" | "unknown";
  nullCount: number;
  nullRatio: number;
  distinctCount: number;
  min?: string | number | null;
  max?: string | number | null;
  sampleValues: (string | number | boolean | null)[];
  role: "dimension" | "metric" | "identifier" | "timestamp" | "attribute";
  semanticCategory?: "identity" | "location" | "financial" | "contact" | "temporal" | "status" | "classification" | "nested_structure" | "content" | "general";
  humanLabel?: string;
  isSearchable?: boolean;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  foreignKeyTarget?: { table: string; column: string };
  isJson?: boolean;
  jsonStructure?: JsonColumnStructure;
  clickhouseType?: string;
}

export interface NestedSemanticDimension {
  parentColumn: string;
  fieldPath: string;
  name: string;
  description: string;
  dataType: string;
  sampleValues?: string[];
}

export interface ClickhouseSchemaDefinition {
  createTableDdl: string;
  engine: string;
  orderBy: string[];
  columnTypes: Record<string, string>;
}

export interface TableSemanticModel {
  tableName: string;
  description: string;
  context?: string;
  topics?: string[];
  tableRole?: "fact_table" | "dimension_table" | "lookup_table" | "bridge_table";
  decisionSpecs?: string[];
  entities?: string[];
  searchableColumns?: string[];
  dimensions: { name: string; description: string; sampleValues?: string[] }[];
  nestedDimensions?: NestedSemanticDimension[];
  metrics: { name: string; expression: string; description: string; aggregation: "sum" | "avg" | "count" | "min" | "max" }[];
  primaryKey?: string;
  foreignKeys?: { column: string; foreignTable: string; foreignColumn: string }[];
  relationships?: TableRelation[];
  synonyms: Record<string, string[]>;
  clickhouseSchema?: ClickhouseSchemaDefinition;
  suggestedQueries?: SuggestedQueryTemplate[];
  jsonStructures?: Record<string, JsonColumnStructure>;
}

export interface CrossDocumentCorrelation {
  sourceDocId: string;
  sourceDocTitle: string;
  targetDocId: string;
  targetDocTitle: string;
  sharedEntities: string[];
  semanticSimilarity: number;
  correlationSummary: string;
}

export interface CrossModalCorrelation {
  documentId: string;
  documentTitle: string;
  tableId: string;
  tableName: string;
  sharedEntities: string[];
  correlationDescription: string;
}

export interface UnifiedClickhouseView {
  viewName: string;
  description: string;
  joinSql: string;
  sourceTables: string[];
}

export interface CollectionSemanticProfile {
  domain: string;
  primaryTopics: string[];
  entities: string[];
  crossTableRelationships: TableRelation[];
  crossDocumentCorrelations: CrossDocumentCorrelation[];
  crossModalCorrelations: CrossModalCorrelation[];
  unifiedClickhouseViews?: UnifiedClickhouseView[];
  suggestedQueries: SuggestedQueryTemplate[];
  summary: string;
  lastCorrelatedAt: string;
}

export interface DataSourceCollection {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  semanticProfile?: CollectionSemanticProfile | null;
  metadata: Record<string, unknown> | null;
  dataSources?: DataSource[];
  dataSourceCount?: number;
  tableCount?: number;
  documentCount?: number;
  totalRows?: number;
  totalChunks?: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface DataSource {
  id: string;
  companyId: string;
  collectionId?: string | null;
  collectionName?: string | null;
  name: string;
  description: string | null;
  sourceType: DataSourceType;
  status: DataSourceStatus;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  storagePath: string | null;
  metadata: Record<string, unknown> | null;
  semanticProfile?: DataSourceSemanticProfile | null;
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
