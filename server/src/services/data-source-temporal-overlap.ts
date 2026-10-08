import type {
  IngestionQualityCounters,
  TemporalOverlapAnalysis,
  TemporalOverlapFinding,
} from "@paperclipai/shared";

export interface TemporalOverlapTableInput {
  tableId: string;
  sourceId: string;
  sourceType: string;
  sourceStatus: string;
  tableName: string;
  semanticModel: unknown;
}

const MAX_TEMPORAL_OVERLAP_FINDINGS = 250;
const MAX_TEMPORAL_COLUMNS_PER_TABLE = 128;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeIdentity(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function getStringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.map(normalizeIdentity).filter(Boolean));
}

function getMetricNames(semanticModel: Record<string, unknown>): Set<string> {
  if (!Array.isArray(semanticModel.metrics)) return new Set();
  return new Set(semanticModel.metrics
    .map((metric) => {
      const record = asRecord(metric);
      return normalizeIdentity(record.name ?? record.expression ?? record.column);
    })
    .filter((metric) => metric.length > 2 && !["count", "total", "amount", "value"].includes(metric)));
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function readColumnBounds(value: unknown): {
  bounds: Array<{ column: string; minDate: string; maxDate: string }>;
  truncated: boolean;
} {
  const bounds = asRecord(value) as IngestionQualityCounters["temporalBoundsByColumn"];
  if (!bounds) return { bounds: [], truncated: false };
  const result: Array<{ column: string; minDate: string; maxDate: string }> = [];
  for (const [column, rawRange] of Object.entries(bounds)) {
    const range = asRecord(rawRange);
    if (typeof range.minDate !== "string" || typeof range.maxDate !== "string") continue;
    const minDate = Date.parse(range.minDate);
    const maxDate = Date.parse(range.maxDate);
    if (!Number.isFinite(minDate) || !Number.isFinite(maxDate) || minDate > maxDate) continue;
    result.push({ column, minDate: range.minDate, maxDate: range.maxDate });
  }
  return {
    bounds: result.slice(0, MAX_TEMPORAL_COLUMNS_PER_TABLE),
    truncated: result.length > MAX_TEMPORAL_COLUMNS_PER_TABLE,
  };
}

/**
 * Finds overlapping date windows only for likely equivalent fact tables.
 * A finding is a review hint; date overlap by itself never proves duplicate rows.
 */
export function analyzeTemporalOverlaps(
  input: TemporalOverlapTableInput[],
  options: { tablesTruncated?: boolean } = {},
): TemporalOverlapAnalysis {
  const structuredReady = input
    .filter((table) => table.sourceStatus === "ready" && ["csv", "excel"].includes(table.sourceType))
    .map((table) => {
      const semanticModel = asRecord(table.semanticModel);
      const qualityCounters = asRecord(semanticModel.qualityCounters) as unknown as IngestionQualityCounters;
      const columnBounds = readColumnBounds(qualityCounters.temporalBoundsByColumn);
      const legacyBoundsExist = Boolean(qualityCounters.temporalBounds);
      return {
        ...table,
        semanticModel,
        normalizedTableName: normalizeIdentity(table.tableName),
        metrics: getMetricNames(semanticModel),
        entities: getStringSet(semanticModel.entities),
        temporalBoundsByColumn: columnBounds.bounds,
        hasUnqualifiedLegacyBounds: columnBounds.truncated || (legacyBoundsExist && columnBounds.bounds.length === 0),
      };
    });

  let comparedPairs = 0;
  const findings: TemporalOverlapFinding[] = [];
  let findingsTruncated = false;

  for (let leftIndex = 0; leftIndex < structuredReady.length; leftIndex += 1) {
    const left = structuredReady[leftIndex]!;
    if (left.temporalBoundsByColumn.length === 0) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < structuredReady.length; rightIndex += 1) {
      const right = structuredReady[rightIndex]!;
      if (left.sourceId === right.sourceId || right.temporalBoundsByColumn.length === 0) continue;

      const sameTableName = left.normalizedTableName.length > 0
        && left.normalizedTableName === right.normalizedTableName;
      const sharedEntityAndMetric = intersects(left.entities, right.entities)
        && intersects(left.metrics, right.metrics);
      if (!sameTableName && !sharedEntityAndMetric) continue;
      comparedPairs += 1;

      const rightRangesByColumn = new Map(right.temporalBoundsByColumn
        .map((range) => [normalizeIdentity(range.column), range] as const));
      for (const leftRange of left.temporalBoundsByColumn) {
        const rightRange = rightRangesByColumn.get(normalizeIdentity(leftRange.column));
        if (!rightRange) continue;
        const leftStart = Date.parse(leftRange.minDate);
        const leftEnd = Date.parse(leftRange.maxDate);
        const rightStart = Date.parse(rightRange.minDate);
        const rightEnd = Date.parse(rightRange.maxDate);
        const overlapStart = Math.max(leftStart, rightStart);
        const overlapEnd = Math.min(leftEnd, rightEnd);
        if (overlapStart > overlapEnd) continue;
        if (findings.length >= MAX_TEMPORAL_OVERLAP_FINDINGS) {
          findingsTruncated = true;
          continue;
        }
        findings.push({
          sourceTableId: left.tableId,
          sourceId: left.sourceId,
          sourceTable: left.tableName,
          targetTableId: right.tableId,
          targetSourceId: right.sourceId,
          targetTable: right.tableName,
          sourceDateColumn: leftRange.column,
          targetDateColumn: rightRange.column,
          overlapStart: new Date(overlapStart).toISOString(),
          overlapEnd: new Date(overlapEnd).toISOString(),
          matchedOn: sameTableName ? "same_table_name" : "shared_entity_and_metric",
          reviewRequired: true,
        });
      }
    }
  }

  const tablesWithTemporalBounds = structuredReady.filter((table) => table.temporalBoundsByColumn.length > 0).length;
  const hasLegacyBounds = structuredReady.some((table) => table.hasUnqualifiedLegacyBounds);
  return {
    status: options.tablesTruncated || findingsTruncated || hasLegacyBounds ? "limited" : "complete",
    tablesAnalyzed: structuredReady.length,
    tablesWithTemporalBounds,
    comparedPairs,
    findingsTruncated,
    findings,
  };
}
