import { z } from "zod";

const tableSyncPolicySchema = z.object({
  tableId: z.string().uuid(),
  updatedAtColumn: z.string().trim().min(1).max(256),
  deletedAtColumn: z.string().trim().min(1).max(256).optional(),
}).strict();

export const dataSourceSnapshotRequestSchema = z.object({
  mode: z.enum(["full", "incremental"]).default("full"),
  tableIds: z.array(z.string().uuid()).min(1).max(100).optional(),
  tablePolicies: z.array(tableSyncPolicySchema).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === "incremental" && (!value.tablePolicies || value.tablePolicies.length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["tablePolicies"],
      message: "Incremental sync requires an updated-at policy for every selected table",
    });
  }
  const tableIds = value.tableIds || [];
  if (new Set(tableIds).size !== tableIds.length) {
    context.addIssue({ code: "custom", path: ["tableIds"], message: "tableIds must be unique" });
  }
  const policyIds = (value.tablePolicies || []).map((policy) => policy.tableId);
  if (new Set(policyIds).size !== policyIds.length) {
    context.addIssue({ code: "custom", path: ["tablePolicies"], message: "Each table may have one sync policy" });
  }
  if (tableIds.length && policyIds.some((tableId) => !tableIds.includes(tableId))) {
    context.addIssue({ code: "custom", path: ["tablePolicies"], message: "A sync policy refers to an unselected table" });
  }
});

export type DataSourceSnapshotRequest = z.infer<typeof dataSourceSnapshotRequestSchema>;
