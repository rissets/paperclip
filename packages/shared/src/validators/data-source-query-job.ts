import { z } from "zod";

export const dataSourceQueryJobRequestSchema = z.object({
  sql: z.string().trim().min(1).max(64 * 1024),
  params: z.array(z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
  ])).max(200).optional(),
  rowLimit: z.number().int().min(1).max(1_000).optional(),
  statementTimeoutMs: z.number().int().min(1_000).max(60_000).optional(),
}).strict();

export type DataSourceQueryJobRequest = z.infer<typeof dataSourceQueryJobRequestSchema>;
