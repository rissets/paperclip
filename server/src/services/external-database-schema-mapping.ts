import type {
  AgenticLoopResult,
  AgentReasoningOptions,
  AiDatabaseAnalysisResult,
  DatabaseSchemaObservationRequest,
} from "./ai-reasoning.js";

export interface ExternalDatabaseSchemaColumn {
  name: string;
  dataType: string;
  isPrimary?: boolean;
  isForeign?: boolean;
  references?: string;
  sampleValues?: unknown[];
  distinctCount?: number;
  nullRatio?: number;
  role?: string;
  observedValues?: unknown[];
}

export interface ExternalDatabaseSchemaTable {
  tableName: string;
  rowCount: number;
  columns: ExternalDatabaseSchemaColumn[];
}

export type ExternalDatabaseSchemaAnalysis = AgenticLoopResult<AiDatabaseAnalysisResult>;
export type AnalyzeExternalDatabaseSchema = (
  databaseType: string,
  databaseName: string,
  tables: ExternalDatabaseSchemaTable[],
  options?: AgentReasoningOptions,
) => Promise<ExternalDatabaseSchemaAnalysis>;

export interface ExternalDatabaseObservationResult {
  valuesByColumn: Record<string, unknown[]>;
  rowCount: number;
  executionTimeMs: number;
}

/**
 * Execute at most one application-controlled observation round for a table
 * batch. The model only selects exact columns from its inspected schema; the
 * caller constructs the bounded source query. A final inference cannot ask
 * for another observation.
 */
export async function analyzeExternalDatabaseSchemaBatch(input: {
  databaseType: string;
  databaseName: string;
  table: ExternalDatabaseSchemaTable;
  options: Omit<AgentReasoningOptions, "allowDatabaseObservations" | "databaseObservationFollowup">;
  analyze: AnalyzeExternalDatabaseSchema;
  observe: (columns: string[]) => Promise<ExternalDatabaseObservationResult>;
  onObservationRequested?: (requests: DatabaseSchemaObservationRequest[]) => void | Promise<void>;
  onObservationCompleted?: (
    requests: DatabaseSchemaObservationRequest[],
    result: ExternalDatabaseObservationResult,
  ) => void | Promise<void>;
}): Promise<ExternalDatabaseSchemaAnalysis> {
  const initial = await input.analyze(
    input.databaseType,
    input.databaseName,
    [input.table],
    { ...input.options, allowDatabaseObservations: true },
  );

  const requests = initial.validationStatus === "validated"
    ? initial.result?.observationRequests || []
    : [];
  if (requests.length === 0) return initial;

  await input.onObservationRequested?.(requests);
  const observed = await input.observe(requests.map((request) => request.columnName));
  await input.onObservationCompleted?.(requests, observed);

  const final = await input.analyze(
    input.databaseType,
    input.databaseName,
    [{
      ...input.table,
      columns: input.table.columns.map((column) => ({
        ...column,
        observedValues: observed.valuesByColumn[column.name] || [],
      })),
    }],
    {
      ...input.options,
      allowDatabaseObservations: false,
      databaseObservationFollowup: true,
    },
  );

  return {
    ...final,
    iterations: initial.iterations + final.iterations,
    backend: final.backend ?? initial.backend,
    reasoningSteps: [...initial.reasoningSteps, ...final.reasoningSteps],
  };
}
