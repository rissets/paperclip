import { describe, expect, it } from "vitest";
import {
  externalSchemaMappingBatchTimeoutMs,
  EXTERNAL_SCHEMA_MAPPING_BATCH_TIMEOUT_MS,
  EXTERNAL_SCHEMA_MAPPING_TABLE_TIMEOUT_MS,
  fingerprintExternalDatabaseMappingBatch,
  fingerprintExternalDatabaseSchema,
} from "./external-database-mapping-checkpoints.js";

describe("external database mapping fingerprints", () => {
  it("uses schema-qualified table identity and column constraints", () => {
    const columns = [{ name: "tenant_id", dataType: "number", nativeType: "int8", isForeignKey: true }];
    const first = fingerprintExternalDatabaseSchema([{ schemaName: "sales", tableName: "orders", rowCount: 120, schemaDefinition: columns }]);
    const same = fingerprintExternalDatabaseSchema([{ schemaName: "sales", tableName: "orders", rowCount: 120, schemaDefinition: [...columns] }]);
    const anotherSchema = fingerprintExternalDatabaseSchema([{ schemaName: "archive", tableName: "orders", rowCount: 120, schemaDefinition: columns }]);
    const changedSize = fingerprintExternalDatabaseSchema([{ schemaName: "sales", tableName: "orders", rowCount: 121, schemaDefinition: columns }]);
    const configured = fingerprintExternalDatabaseSchema([{ schemaName: "sales", tableName: "orders", rowCount: 120, schemaDefinition: columns }], {
      databaseType: "postgres",
      databaseName: "warehouse",
      agentModel: "router/qwen",
      instructionsPath: "/agents/db/AGENTS.md",
      instructionsFingerprint: "a".repeat(64),
    });
    const changedAgent = fingerprintExternalDatabaseSchema([{ schemaName: "sales", tableName: "orders", rowCount: 120, schemaDefinition: columns }], {
      databaseType: "postgres",
      databaseName: "warehouse",
      agentModel: "router/bge",
      instructionsPath: "/agents/db/AGENTS.md",
      instructionsFingerprint: "a".repeat(64),
    });
    const changedInstructions = fingerprintExternalDatabaseSchema([{ schemaName: "sales", tableName: "orders", rowCount: 120, schemaDefinition: columns }], {
      databaseType: "postgres",
      databaseName: "warehouse",
      agentModel: "router/qwen",
      instructionsPath: "/agents/db/AGENTS.md",
      instructionsFingerprint: "b".repeat(64),
    });
    const anotherForeignKey = fingerprintExternalDatabaseSchema([{
      schemaName: "sales",
      tableName: "orders",
      schemaDefinition: [{ ...columns[0], foreignKeyTarget: { schema: "core", table: "tenants", column: "id" } }],
    }]);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(same).toBe(first);
    expect(anotherSchema).not.toBe(first);
    expect(changedSize).not.toBe(first);
    expect(changedAgent).not.toBe(configured);
    expect(changedInstructions).not.toBe(configured);
    expect(anotherForeignKey).not.toBe(first);
  });

  it("caps each batch by a finite per-table mapping deadline", () => {
    expect(EXTERNAL_SCHEMA_MAPPING_BATCH_TIMEOUT_MS).toBeGreaterThanOrEqual(110_000);
    expect(externalSchemaMappingBatchTimeoutMs(1_000, 1_000)).toBe(Math.min(EXTERNAL_SCHEMA_MAPPING_BATCH_TIMEOUT_MS, EXTERNAL_SCHEMA_MAPPING_TABLE_TIMEOUT_MS));
    expect(externalSchemaMappingBatchTimeoutMs(1_000, 61_000)).toBe(EXTERNAL_SCHEMA_MAPPING_TABLE_TIMEOUT_MS - 60_000);
    expect(externalSchemaMappingBatchTimeoutMs(1_000, 61_001)).toBe(EXTERNAL_SCHEMA_MAPPING_TABLE_TIMEOUT_MS - 60_001);
    expect(externalSchemaMappingBatchTimeoutMs(1_000, 91_000)).toBe(0);
  });

  it("gives every bounded column batch a stable table-scoped identity", () => {
    const batch = [{ name: "order_id", dataType: "number", isPrimaryKey: true }];

    expect(fingerprintExternalDatabaseMappingBatch("sales.orders", batch))
      .toBe(fingerprintExternalDatabaseMappingBatch("sales.orders", [...batch]));
    expect(fingerprintExternalDatabaseMappingBatch("archive.orders", batch))
      .not.toBe(fingerprintExternalDatabaseMappingBatch("sales.orders", batch));
    expect(fingerprintExternalDatabaseMappingBatch("sales.orders", [{ ...batch[0], isPrimaryKey: false }]))
      .not.toBe(fingerprintExternalDatabaseMappingBatch("sales.orders", batch));
  });
});
