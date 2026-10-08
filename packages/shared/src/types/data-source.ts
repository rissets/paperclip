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
export type DataSourceStatus = "uploading" | "onboarding" | "processing" | "ready" | "error";

export type DataSourceUploadSessionStatus = "starting" | "uploading" | "completing" | "verifying" | "completed" | "aborted" | "expired" | "cleanup_pending" | "failed";

export interface DataSourceUploadSession {
  id: string;
  companyId: string;
  fileName: string;
  expectedBytes: number;
  partSize: number;
  partCount: number;
  uploadedParts: Array<{ partNumber: number; byteSize: number; sha256: string }>;
  status: DataSourceUploadSessionStatus;
  expiresAt: string;
  dataSourceId?: string | null;
}

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
  physicalColumn?: string;
  expression?: string;
  aggregation: "sum" | "avg" | "count" | "min" | "max";
  format?: string;
  description?: string;
  synonyms?: string[];
  provenance?: "inferred" | "verified" | "user_defined";
  publicationGateStatus?: "pending" | "verified" | "rejected";
}

export interface SemanticDimension {
  name: string;
  column?: string;
  type?: string;
  description?: string;
  synonyms?: string[];
  sampleValues?: string[];
  provenance?: "inferred" | "verified" | "user_defined";
}

export interface DataSourceMappingReviewHistoryEntry {
  id: string;
  decision: "approved" | "corrected";
  reviewerId: string;
  reviewedAt: string;
  schemaFingerprint: string;
  note?: string;
  metricCorrections: Array<{ index: number; name: string; column: string; aggregation: string; description?: string }>;
  dimensionCorrections: Array<{ index: number; name: string; column: string; description?: string }>;
}

export interface DataSourceMappingReviewState {
  status: "not_reviewed" | "approved" | "corrected";
  revision: number;
  reviewerId?: string;
  reviewedAt?: string;
  schemaFingerprint?: string;
  note?: string;
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
  semanticMappingSummary?: {
    tablesCount: number;
    completeTables: number;
    partialTables: number;
    fallbackTables: number;
    expectedBatches: number;
    validatedBatches: number;
    fallbackBatches: number;
    budgetExceededTables: number;
  };
  documentProfiles?: DocumentSemanticProfile[];
}

export interface TableSemanticMappingCoverage {
  status: "complete" | "partial" | "fallback";
  expectedBatches: number;
  validatedBatches: number;
  fallbackBatches: number;
  timeBudgetExceeded: boolean;
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
  sourceTableId?: string;
  sourceColumn: string;
  targetTable: string;
  targetTableId?: string;
  targetColumn: string;
  relationType: "one_to_many" | "many_to_one" | "one_to_one";
  provenance?: "foreign_key" | "inferred" | "candidate";
  confidence?: number;
  sourceSchema?: string;
  targetSchema?: string;
  cardinalityEvidence?: {
    sourceDistinctCount?: number;
    targetDistinctCount?: number;
    sampleMatchRatio?: number;
  };
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
  nativeType?: string;
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
  foreignKeyTarget?: { schema?: string; table: string; column: string };
  isJson?: boolean;
  jsonStructure?: JsonColumnStructure;
  clickhouseType?: string;
}

export interface TableIndexDefinition {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary?: boolean;
  predicate?: string | null;
  expression?: string | null;
  indexType?: string;
  capabilityFailure?: string | null;
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
  versionColumn?: string;
  deduplicationStrategy?: "final" | "arg_max" | "none";
  projectionDdl?: string;
}

export interface IngestionQualityCounters {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  /** Invalid rows excluded from the published analytical table. */
  quarantinedRows?: number;
  /** Rows actually published to the queryable table after quality quarantine. */
  publishedRows?: number;
  /** Bounded, value-free row references for operator review. */
  quarantineSamples?: Array<{
    rowNumber: number;
    columns: string[];
    reason: "type_violation" | "field_count";
  }>;
  nullValueCount: Record<string, number>;
  typeViolations: number;
  duplicateRows: number;
  duplicateKeyRows?: number;
  duplicateDetection?: "complete" | "deferred";
  temporalBounds?: {
    minDate?: string;
    maxDate?: string;
  };
  /** Full-data temporal bounds keyed by the physical date/timestamp column. */
  temporalBoundsByColumn?: Record<string, {
    minDate?: string;
    maxDate?: string;
  }>;
  sampleErrors?: Array<{ rowNumber: number; column?: string; error: string }>;
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
  dimensions: {
    name: string;
    column?: string;
    description: string;
    sampleValues?: string[];
    synonyms?: string[];
    provenance?: "inferred" | "verified" | "user_defined";
  }[];
  nestedDimensions?: NestedSemanticDimension[];
  metrics: {
    name: string;
    column?: string;
    expression?: string;
    description: string;
    aggregation: "sum" | "avg" | "count" | "min" | "max";
    physicalColumn?: string;
    synonyms?: string[];
    grain?: string;
    timezone?: string;
    nullPolicy?: "zero" | "exclude" | "error";
    provenance?: "inferred" | "verified" | "user_defined";
    publicationGateStatus?: "pending" | "verified" | "rejected";
  }[];
  primaryKey?: string;
  foreignKeys?: { column: string; foreignTable: string; foreignColumn: string }[];
  relationships?: TableRelation[];
  synonyms: Record<string, string[]>;
  sourceSchema?: string;
  rowCountEstimated?: boolean;
  indexes?: TableIndexDefinition[];
  connectedComponentId?: string;
  clickhouseSchema?: ClickhouseSchemaDefinition;
  suggestedQueries?: SuggestedQueryTemplate[];
  jsonStructures?: Record<string, JsonColumnStructure>;
  qualityCounters?: IngestionQualityCounters;
  publicationGateStatus?: "pending" | "verified" | "rejected";
  unresolvedDefinitions?: string[];
  version?: number;
  semanticMapping?: TableSemanticMappingCoverage;
  mappingReview?: DataSourceMappingReviewState;
  mappingReviewHistory?: DataSourceMappingReviewHistoryEntry[];
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
  sourceTableIds?: string[];
  deploymentStatus?: "deployed" | "not_deployed" | "failed";
  deploymentMessage?: string;
}

export interface CollectionSemanticProfile {
  domain: string;
  primaryTopics: string[];
  entities: string[];
  crossTableRelationships: TableRelation[];
  crossDocumentCorrelations: CrossDocumentCorrelation[];
  crossModalCorrelations: CrossModalCorrelation[];
  temporalOverlapAnalysis?: TemporalOverlapAnalysis;
  unifiedClickhouseViews?: UnifiedClickhouseView[];
  suggestedQueries: SuggestedQueryTemplate[];
  summary: string;
  lastCorrelatedAt: string;
}

export interface TemporalOverlapFinding {
  sourceTableId: string;
  sourceId: string;
  sourceTable: string;
  targetTableId: string;
  targetSourceId: string;
  targetTable: string;
  sourceDateColumn: string;
  targetDateColumn: string;
  overlapStart: string;
  overlapEnd: string;
  matchedOn: "same_table_name" | "shared_entity_and_metric";
  reviewRequired: true;
}

export interface TemporalOverlapAnalysis {
  status: "complete" | "limited";
  tablesAnalyzed: number;
  tablesWithTemporalBounds: number;
  comparedPairs: number;
  findingsTruncated: boolean;
  findings: TemporalOverlapFinding[];
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

export interface DataSourceIngestionJob {
  id: string;
  jobType?: string;
  status: "queued" | "running" | "cancel_requested" | "succeeded" | "failed" | "cancelled";
  stage: string;
  attempt: number;
  maxAttempts: number;
  progress: Record<string, unknown>;
  lastError: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  completedAt: string | Date | null;
}

export interface DataSourceQueryJob {
  id: string;
  companyId: string;
  dataSourceId: string;
  status: "queued" | "running" | "cancel_requested" | "succeeded" | "failed" | "cancelled";
  queryFingerprint: string;
  rowLimit: number;
  statementTimeoutMs: number;
  lastError: string | null;
  resultBytes: number | null;
  resultExpiresAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  completedAt: string | Date | null;
}

export interface DataSourceQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTimeMs: number;
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
  ingestionJob?: DataSourceIngestionJob | null;
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
  querySource?: {
    mode: "live" | "snapshot";
    snapshotAt?: string;
    consistency?: "best_effort_keyset" | "best_effort_updated_at";
    syncMode?: "full" | "incremental";
    watermarkMicros?: string | null;
    deleteSemantics?: "soft_delete_column" | "full_reconciliation_required";
  };
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

export type QueryExperienceStatus =
  | "candidate"
  | "execution_checked"
  | "reference_verified"
  | "user_approved"
  | "rejected"
  | "deprecated";

export interface QueryExperienceRecord {
  id: string;
  companyId: string;
  originatingExecutionId: string;
  intent: string;
  parameterizedSql: string;
  parameterSchema?: Record<string, { type: string; description?: string }>;
  referencedDataSourceIds: string[];
  referencedTables: string[];
  referencedColumns: string[];
  metricBindings: string[];
  schemaFingerprint: string;
  engine: "clickhouse" | "live_external" | "hybrid";
  status: QueryExperienceStatus;
  validationEvidence?: Record<string, unknown>;
  feedbackCount: number;
  lastUsedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueryFeedbackRecord {
  id: string;
  companyId: string;
  executionId: string;
  experienceId?: string | null;
  actorType: "board" | "agent" | "user";
  actorId: string;
  sentiment: "positive" | "negative";
  businessFieldsToFix?: string[];
  correctionNote?: string | null;
  createdAt: string;
  updatedAt: string;
}
