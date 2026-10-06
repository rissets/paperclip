import { z } from "zod";

export const completeDataSourceUploadSessionSchema = z.object({
  partSha256s: z.array(z.string().regex(/^[a-f0-9]{64}$/i)).min(1).max(10_000),
}).strict();

export type CompleteDataSourceUploadSessionRequest = z.infer<typeof completeDataSourceUploadSessionSchema>;
