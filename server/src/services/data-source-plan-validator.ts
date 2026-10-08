export interface PlanValidationColumnRef {
  table: string;
  column: string;
}

export interface PlanValidationMetricRef {
  name: string;
  formula?: string;
  column?: string;
  aggregation?: string;
  grain?: string;
  timezone?: string;
}

export interface PlanValidationJoinRef {
  leftTable: string;
  rightTable: string;
  leftColumn: string;
  rightColumn: string;
}

export interface PlanValidationTableMeta {
  id: string;
  dataSourceId: string;
  tableName: string;
  schemaDefinition?: Array<{ name: string; dataType: string; isPrimaryKey?: boolean }>;
  semanticModel?: {
    relationships?: Array<{
      sourceTable: string;
      sourceColumn: string;
      targetTable: string;
      targetColumn: string;
      relationType?: string;
    }>;
    externalSnapshot?: {
      status: string;
      syncMode?: string;
      watermarkMicros?: string | null;
      lastIncrementalAt?: string;
      completedAt?: string;
    };
    pendingExternalSnapshot?: {
      status: string;
    };
    metrics?: Array<{
      name: string;
      column?: string;
      aggregation?: string;
      grain?: string;
      timezone?: string;
    }>;
  };
  rowCount?: number;
}

export interface PlanValidationInput {
  companyId: string;
  allowedDataSourceIds: string[];
  tables: PlanValidationTableMeta[];
  referencedTables: string[];
  referencedColumns: PlanValidationColumnRef[];
  metrics?: PlanValidationMetricRef[];
  joins?: PlanValidationJoinRef[];
  estimatedRowsScan?: number;
}

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  costEstimate: {
    estimatedRows: number;
    estimatedCostUnits: number;
    riskLevel: "low" | "medium" | "high";
  };
}

export class DataSourcePlanValidator {
  /**
   * Validate physical binding, metrics, grain, join paths, data freshness, and query cost.
   */
  validatePlan(input: PlanValidationInput): PlanValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const allowedSourceSet = new Set(input.allowedDataSourceIds);

    const tableMap = new Map<string, PlanValidationTableMeta>();
    for (const t of input.tables) {
      tableMap.set(t.tableName.toLowerCase(), t);
    }

    // 1. Physical Binding Verification
    for (const refTableName of input.referencedTables) {
      const lowerName = refTableName.toLowerCase();
      const meta = tableMap.get(lowerName);
      if (!meta) {
        errors.push(`Table '${refTableName}' is not available or does not exist`);
        continue;
      }
      if (!allowedSourceSet.has(meta.dataSourceId)) {
        errors.push(`Access to table '${refTableName}' is not authorized for this agent`);
      }
    }

    for (const colRef of input.referencedColumns) {
      const tableMeta = tableMap.get(colRef.table.toLowerCase());
      if (!tableMeta) {
        // Table error already recorded
        continue;
      }
      const schema = tableMeta.schemaDefinition || [];
      const colExists = schema.some((c) => c.name.toLowerCase() === colRef.column.toLowerCase());
      if (!colExists && schema.length > 0) {
        errors.push(`Column '${colRef.column}' does not exist on table '${colRef.table}'`);
      }
    }

    // 2. Metric and Grain Verification
    const allowedAggregations = new Set(["sum", "avg", "count", "min", "max", "uniq", "uniqexact"]);
    for (const metric of input.metrics || []) {
      if (metric.aggregation && !allowedAggregations.has(metric.aggregation.toLowerCase())) {
        errors.push(`Invalid aggregation function '${metric.aggregation}' for metric '${metric.name}'`);
      }
      if (metric.column && metric.column !== "*") {
        let foundCol = false;
        for (const t of input.referencedTables) {
          const tMeta = tableMap.get(t.toLowerCase());
          if (tMeta?.schemaDefinition?.some((c) => c.name.toLowerCase() === metric.column!.toLowerCase())) {
            foundCol = true;
            break;
          }
        }
        if (!foundCol && input.referencedTables.length > 0) {
          errors.push(`Metric '${metric.name}' references non-existent physical column '${metric.column}'`);
        }
      }
      if (metric.timezone) {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: metric.timezone });
        } catch {
          errors.push(`Metric '${metric.name}' has invalid timezone '${metric.timezone}'`);
        }
      }
    }

    // 3. Join Verification
    for (const join of input.joins || []) {
      const left = tableMap.get(join.leftTable.toLowerCase());
      const right = tableMap.get(join.rightTable.toLowerCase());
      if (!left || !right) {
        errors.push(`Join references unknown table(s): ${join.leftTable} <-> ${join.rightTable}`);
        continue;
      }

      // Check whether verified relationship exists
      const relations = [
        ...(left.semanticModel?.relationships || []),
        ...(right.semanticModel?.relationships || []),
      ];
      const hasVerifiedEdge = relations.some(
        (r) =>
          (r.sourceTable.toLowerCase() === join.leftTable.toLowerCase() &&
            r.targetTable.toLowerCase() === join.rightTable.toLowerCase()) ||
          (r.sourceTable.toLowerCase() === join.rightTable.toLowerCase() &&
            r.targetTable.toLowerCase() === join.leftTable.toLowerCase()),
      );

      if (!hasVerifiedEdge) {
        warnings.push(
          `Join between '${join.leftTable}' and '${join.rightTable}' uses unverified relationship edge`,
        );
      }
    }

    // 4. Freshness and Snapshot Verification
    for (const refTableName of input.referencedTables) {
      const meta = tableMap.get(refTableName.toLowerCase());
      if (!meta) continue;

      if (meta.semanticModel?.pendingExternalSnapshot) {
        warnings.push(
          `Table '${refTableName}' has an in-progress snapshot sync; results may not reflect current state`,
        );
      }
      if (
        meta.semanticModel?.externalSnapshot &&
        meta.semanticModel.externalSnapshot.status !== "ready"
      ) {
        errors.push(
          `Snapshot for table '${refTableName}' is not ready (status: ${meta.semanticModel.externalSnapshot.status})`,
        );
      }
    }

    // 5. Query Cost Estimation
    let totalRows = 0;
    for (const refTableName of input.referencedTables) {
      const meta = tableMap.get(refTableName.toLowerCase());
      totalRows += meta?.rowCount ?? 1000;
    }
    const estimatedRows = input.estimatedRowsScan ?? totalRows;
    const estimatedCostUnits = Math.ceil(estimatedRows / 1000);
    let riskLevel: "low" | "medium" | "high" = "low";
    if (estimatedRows > 5_000_000) {
      riskLevel = "high";
      warnings.push(`Query scans estimated ${estimatedRows.toLocaleString()} rows; consider narrower date/key filters`);
    } else if (estimatedRows > 500_000) {
      riskLevel = "medium";
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      costEstimate: {
        estimatedRows,
        estimatedCostUnits,
        riskLevel,
      },
    };
  }
}
