export type OrchestratorRoute =
  | "data_agent"
  | "knowledge_agent"
  | "research_agent"
  | "analytics_engineer_agent"
  | "prediction_agent"
  | "action_agent"
  | "onboarding_orchestrator"
  | "agent_builder"
  | "hybrid"
  | "direct";

export interface Citation {
  sourceName: string;
  section?: string;
  chunkIndex?: number;
  snippet?: string;
}

export interface DataSourceStageTimings {
  preflightMs?: number;
  retrievalMs?: number;
  planningMs?: number;
  validationMs?: number;
  databaseExecutionMs?: number;
  synthesisMs?: number;
  totalMs: number;
}

export interface DataSourceQueryTrace {
  traceId: string;
  companyId: string;
  query: string;
  agentId?: string;
  runId?: string;
  sessionId?: string;
  engine: "clickhouse" | "postgres" | "mysql" | "mariadb" | "cache" | "fast_path";
  cacheHit: boolean;
  timings: DataSourceStageTimings;
  outcome: "success" | "error" | "abstained" | "timeout";
  errorMessage?: string;
  createdAt: string;
}

export interface SpecialistExecution {
  agent:
    | "data_agent"
    | "knowledge_agent"
    | "research_agent"
    | "analytics_engineer_agent"
    | "prediction_agent"
    | "action_agent"
    | "onboarding_orchestrator"
    | "agent_builder"
    | string;
  task: string;
  query?: string;
  resultsSummary?: string;
  dataPreview?: any;
  citations?: Citation[];
  traceId?: string;
  stageTimings?: DataSourceStageTimings;
}

export interface JevDecisionChoice {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevDecisionScore {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export interface JevDecisionNoul {
  type: "noul";
  noul: number;
}

export type JevDecisionAnswer = JevDecisionChoice | JevDecisionScore | JevDecisionNoul;

export interface JevDecisionResult {
  model: string;
  answers: Record<string, JevDecisionAnswer>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  latencyMs?: number;
}

export interface OrchestrationPlan {
  intent: string;
  route: OrchestratorRoute;
  confidence: number;
  reasoning: string;
  selectedDataSources: { id: string; name: string; type: string }[];
  specialistExecutions: SpecialistExecution[];
  synthesizedAnswer: string;
  jevDecisions?: JevDecisionResult;
}

export interface OrchestratorSession {
  id: string;
  companyId: string;
  title: string;
  status: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface OrchestratorMessage {
  id: string;
  sessionId: string;
  companyId: string;
  role: "user" | "assistant" | "system";
  content: string;
  orchestrationPlan: OrchestrationPlan | null;
  createdAt: string | Date;
}

export type DataSourceOrchestrationMode = "auto" | "off";

export interface AgentDataSourceOrchestrationConfig {
  mode: DataSourceOrchestrationMode;
}

export interface AgentDataSourceOrchestrationEffectiveState {
  mode: DataSourceOrchestrationMode;
  enabled: boolean;
  adapterSupported: boolean;
  assignmentScope: "all" | "selected" | "none";
  effectiveDataSourceIds: string[];
  reason?: string;
}

export type QueryContextLane =
  | "fast_path_non_data"
  | "fast_path_presentation_reuse"
  | "fast_path_template"
  | "orchestrated"
  | "abstained";

export interface QueryContextRequest {
  agentId?: string;
  query: string;
  sessionId?: string;
  runId?: string;
  previousResultId?: string;
  submittedAt?: string | number;
}

export interface QueryContextTableMetadata {
  id: string;
  dataSourceId: string;
  tableName: string;
  sourceName?: string;
  sourceType?: string;
  clickhouseTable?: string;
  columns?: Array<{ name: string; dataType?: string; role?: string }>;
  columnsTruncated?: boolean;
  metrics: string[];
  dimensions: string[];
}

export interface QueryContextResponse {
  lane: QueryContextLane;
  traceId: string;
  agentId?: string;
  allowedDataSourceIds: string[];
  availableTables: QueryContextTableMetadata[];
  candidateTemplateId?: string;
  previousResultReference?: string;
  reasoning?: string;
}

export interface CreateQueryExecutionRequest {
  query: string;
  agentId?: string;
  runId?: string;
  sessionId?: string;
  dataSourceIds?: string[];
  tables?: string[];
  templateId?: string;
  parameters?: Record<string, any>;
  deadlineMs?: number;
  submittedAt?: string | number;
}

export interface QueryExecutionRecord {
  id: string;
  companyId: string;
  agentId?: string;
  runId?: string;
  sessionId?: string;
  /** Datasource scope authorized when this execution was created. */
  dataSourceIds?: string[];
  query: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  engine?: string;
  resultsSummary?: string;
  data?: any;
  traceId?: string;
  stageTimings?: DataSourceStageTimings;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** Query history omits result rows to keep the list endpoint bounded and safe. */
export type QueryExecutionListItem = Omit<QueryExecutionRecord, "data">;

export interface QueryExecutionFeedbackRequest {
  dataSourceId?: string;
  verdict: "correct" | "needs_correction";
  sentiment?: "positive" | "negative" | "helpful" | "unhelpful";
  correctedDefinition?: string;
  correctionNote?: string;
  businessFieldsToFix?: string[];
  comment?: string;
}
