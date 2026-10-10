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

export const EXTERNAL_SCHEMA_MAPPING_REQUEST_MAX_TABLES = 4;
export const EXTERNAL_SCHEMA_MAPPING_REQUEST_MAX_COLUMNS = 60;
export const EXTERNAL_SCHEMA_MAPPING_PI_TIMEOUT_MS = 75_000;
export const EXTERNAL_SCHEMA_MAPPING_ROUTER_TIMEOUT_MS = 45_000;

/**
 * Pack already-bounded table/column batches into fewer model calls while
 * keeping prompts small and avoiding duplicate physical tables in one call.
 */
export function groupExternalDatabaseSchemaTables(
  tables: ExternalDatabaseSchemaTable[],
  limits: { maxTables?: number; maxColumns?: number } = {},
): ExternalDatabaseSchemaTable[][] {
  const maxTables = limits.maxTables ?? EXTERNAL_SCHEMA_MAPPING_REQUEST_MAX_TABLES;
  const maxColumns = limits.maxColumns ?? EXTERNAL_SCHEMA_MAPPING_REQUEST_MAX_COLUMNS;
  if (!Number.isSafeInteger(maxTables) || maxTables < 1 || !Number.isSafeInteger(maxColumns) || maxColumns < 1) {
    throw new Error("External schema mapping group limits must be positive integers");
  }

  const groups: ExternalDatabaseSchemaTable[][] = [];
  let current: ExternalDatabaseSchemaTable[] = [];
  let currentColumns = 0;
  const flush = () => {
    if (current.length === 0) return;
    groups.push(current);
    current = [];
    currentColumns = 0;
  };

  for (const table of tables) {
    if (table.columns.length > maxColumns) {
      throw new Error(`External schema mapping batch '${table.tableName}' exceeds the ${maxColumns}-column request limit`);
    }
    const duplicateTable = current.some((item) => item.tableName.toLocaleLowerCase() === table.tableName.toLocaleLowerCase());
    if (current.length > 0 && (duplicateTable || current.length >= maxTables || currentColumns + table.columns.length > maxColumns)) {
      flush();
    }
    current.push(table);
    currentColumns += table.columns.length;
  }
  flush();
  return groups;
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

export interface ExternalDatabaseTableObservation {
  tableName: string;
  result: ExternalDatabaseObservationResult;
}

/**
 * Run the semantic mapper once for a group of schema-qualified tables. If it
 * requests evidence, collect bounded samples per exact table and make one
 * final inference over the group.
 */
export async function analyzeExternalDatabaseSchemaGroup(input: {
  databaseType: string;
  databaseName: string;
  tables: ExternalDatabaseSchemaTable[];
  options: Omit<AgentReasoningOptions, "allowDatabaseObservations" | "databaseObservationFollowup">;
  analyze: AnalyzeExternalDatabaseSchema;
  observe: (tableName: string, columns: string[]) => Promise<ExternalDatabaseObservationResult>;
  onObservationRequested?: (requests: DatabaseSchemaObservationRequest[]) => void | Promise<void>;
  onObservationCompleted?: (
    requests: DatabaseSchemaObservationRequest[],
    results: ExternalDatabaseTableObservation[],
  ) => void | Promise<void>;
}): Promise<ExternalDatabaseSchemaAnalysis> {
  const initial = await input.analyze(
    input.databaseType,
    input.databaseName,
    input.tables,
    { ...input.options, allowDatabaseObservations: true },
  );

  const requests = initial.validationStatus === "validated"
    ? initial.result?.observationRequests || []
    : [];
  if (requests.length === 0) return initial;

  await input.onObservationRequested?.(requests);
  const requestsByTable = new Map<string, DatabaseSchemaObservationRequest[]>();
  for (const request of requests) {
    const tableRequests = requestsByTable.get(request.tableName) || [];
    tableRequests.push(request);
    requestsByTable.set(request.tableName, tableRequests);
  }

  const observedByTable = new Map<string, ExternalDatabaseObservationResult>();
  const observations: ExternalDatabaseTableObservation[] = [];
  for (const [tableName, tableRequests] of requestsByTable) {
    const columns = [...new Set(tableRequests.map((request) => request.columnName))];
    const result = await input.observe(tableName, columns);
    observedByTable.set(tableName, result);
    observations.push({ tableName, result });
  }
  await input.onObservationCompleted?.(requests, observations);

  const finalTables = input.tables.map((table) => {
    const observed = observedByTable.get(table.tableName);
    if (!observed) return table;
    return {
      ...table,
      columns: table.columns.map((column) => ({
        ...column,
        observedValues: observed.valuesByColumn[column.name] || [],
      })),
    };
  });
  const final = await input.analyze(
    input.databaseType,
    input.databaseName,
    finalTables,
    {
      ...input.options,
      adapterType: initial.backend === "router_http" ? "router_http" : input.options.adapterType,
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

export function mergeExternalDatabaseTableProfileBatches(
  current: Record<string, any> | undefined,
  incoming: Record<string, any>,
): Record<string, any> {
  const previous = current || {};
  const mergeItems = (field: string, identity: (value: any) => string) => {
    const merged = new Map<string, any>();
    for (const item of [...(Array.isArray(previous[field]) ? previous[field] : []), ...(Array.isArray(incoming[field]) ? incoming[field] : [])]) {
      const key = identity(item);
      if (key) merged.set(key, item);
    }
    return [...merged.values()];
  };
  const identity = (value: any) => typeof value === "string" ? value.trim().toLowerCase() : "";

  return {
    ...previous,
    ...incoming,
    context: [...new Set([previous.context, incoming.context].filter((value) => typeof value === "string" && value.trim()))].join("\n\n"),
    topics: mergeItems("topics", identity),
    entities: mergeItems("entities", identity),
    decisionSpecRefs: mergeItems("decisionSpecRefs", identity),
    metrics: mergeItems("metrics", (value) => `${String(value?.name || "").toLowerCase()}|${String(value?.column || "").toLowerCase()}|${String(value?.aggregation || "").toLowerCase()}`),
    dimensions: mergeItems("dimensions", (value) => `${String(value?.name || "").toLowerCase()}|${String(value?.column || "").toLowerCase()}`),
    relationships: mergeItems("relationships", (value) => `${String(value?.sourceTable || "").toLowerCase()}.${String(value?.sourceColumn || "").toLowerCase()}->${String(value?.targetTable || "").toLowerCase()}.${String(value?.targetColumn || "").toLowerCase()}`),
    suggestedQueries: mergeItems("suggestedQueries", (value) => `${String(value?.title || "").toLowerCase()}|${String(value?.query || value?.sqlSnippet || "").trim().toLowerCase()}`),
  };
}

export function mergeExternalDatabaseMappingResults(
  preferred: AiDatabaseAnalysisResult,
  fallback: AiDatabaseAnalysisResult,
): AiDatabaseAnalysisResult {
  const uniqueBy = <T,>(values: T[], identity: (value: T) => string): T[] => {
    const seen = new Set<string>();
    return values.filter((value) => {
      const key = identity(value).trim().toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const relationshipIdentity = (relation: AiDatabaseAnalysisResult["relationships"][number]) => [
    relation.sourceSchema || "", relation.sourceTable, relation.sourceColumn,
    relation.targetSchema || "", relation.targetTable, relation.targetColumn,
  ].join(".");
  const tableProfiles = { ...fallback.tableProfiles };
  for (const [tableName, profile] of Object.entries(preferred.tableProfiles || {})) {
    tableProfiles[tableName] = mergeExternalDatabaseTableProfileBatches(
      tableProfiles[tableName],
      profile as Record<string, any>,
    ) as NonNullable<AiDatabaseAnalysisResult["tableProfiles"]>[string];
  }

  return {
    ...fallback,
    ...preferred,
    domain: preferred.domain || fallback.domain,
    entities: uniqueBy([...preferred.entities, ...fallback.entities], (value) => value),
    primaryTopics: uniqueBy([...preferred.primaryTopics, ...fallback.primaryTopics], (value) => value),
    tableRoles: { ...fallback.tableRoles, ...preferred.tableRoles },
    relationships: uniqueBy([...preferred.relationships, ...fallback.relationships], relationshipIdentity),
    suggestedQueries: uniqueBy(
      [...preferred.suggestedQueries, ...fallback.suggestedQueries],
      (query) => `${query.title}|${query.sqlSnippet || query.query}`,
    ),
    reasoningSummary: preferred.reasoningSummary || fallback.reasoningSummary,
    tableProfiles,
    crossTableClusters: uniqueBy(
      [...(preferred.crossTableClusters || []), ...(fallback.crossTableClusters || [])],
      (cluster) => cluster.clusterName,
    ),
    observationRequests: [],
  };
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
  return analyzeExternalDatabaseSchemaGroup({
    databaseType: input.databaseType,
    databaseName: input.databaseName,
    tables: [input.table],
    options: input.options,
    analyze: input.analyze,
    observe: (_tableName, columns) => input.observe(columns),
    onObservationRequested: input.onObservationRequested,
    onObservationCompleted: async (requests, observations) => {
      if (observations[0]) await input.onObservationCompleted?.(requests, observations[0].result);
    },
  });
}
