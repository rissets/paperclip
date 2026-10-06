import { z } from "zod";

export const createDataSourceUploadSessionSchema = z.object({
  fileName: z.string().trim().min(1).max(512),
  contentType: z.string().trim().min(1).max(255),
  expectedBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: z.string().trim().max(255).optional(),
  description: z.string().trim().max(10_000).optional(),
  collectionId: z.string().uuid().optional(),
}).strict();

export type CreateDataSourceUploadSessionRequest = z.infer<typeof createDataSourceUploadSessionSchema>;
