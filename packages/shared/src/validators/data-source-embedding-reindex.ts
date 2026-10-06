import { z } from "zod";

export const dataSourceEmbeddingReindexRequestSchema = z.object({
  targetSpace: z.enum(["bge-m3", "openrouter-text-embedding-3-small"]),
  targetGeneration: z.string().trim().min(1).max(256).regex(/^[a-zA-Z0-9._:/@-]+$/).optional(),
}).strict();

export type DataSourceEmbeddingReindexRequest = z.infer<typeof dataSourceEmbeddingReindexRequestSchema>;
