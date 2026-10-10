import { describe, expect, it } from "vitest";
import { DataSourcePlanValidator } from "./data-source-plan-validator.js";

describe("DataSourcePlanValidator PostgreSQL schema identities", () => {
  it("validates schema-qualified physical bindings and their schema-qualified relation", () => {
    const result = new DataSourcePlanValidator().validatePlan({
      companyId: "company",
      allowedDataSourceIds: ["source"],
      tables: [
        {
          id: "geo-orders",
          dataSourceId: "source",
          tableName: "orders",
          rowCount: 10,
          schemaDefinition: [{ name: "customer_id", dataType: "integer" }],
          semanticModel: {
            sourceSchema: "geo",
            relationships: [{
              sourceTable: "orders", sourceSchema: "geo", sourceColumn: "customer_id",
              targetTable: "customers", targetSchema: "geo", targetColumn: "id",
            }],
          },
        },
        {
          id: "geo-customers",
          dataSourceId: "source",
          tableName: "customers",
          rowCount: 5,
          schemaDefinition: [{ name: "id", dataType: "integer" }],
          semanticModel: { sourceSchema: "geo" },
        },
      ],
      referencedTables: ["geo.orders", "geo.customers"],
      referencedColumns: [{ table: "geo.orders", column: "customer_id" }],
      joins: [{ leftTable: "geo.orders", rightTable: "geo.customers", leftColumn: "customer_id", rightColumn: "id" }],
    });

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("rejects a bare table name when multiple schemas expose that name", () => {
    const result = new DataSourcePlanValidator().validatePlan({
      companyId: "company",
      allowedDataSourceIds: ["source"],
      tables: [
        { id: "geo", dataSourceId: "source", tableName: "provinsi", semanticModel: { sourceSchema: "geo" } },
        { id: "legacy", dataSourceId: "source", tableName: "provinsi", semanticModel: { sourceSchema: "legacy" } },
      ],
      referencedTables: ["provinsi"],
      referencedColumns: [],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Table 'provinsi' is not available or does not exist");
  });
});
