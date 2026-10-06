import { z } from "zod";

const generationIdentitySchema = z.object({
  embeddingSpace: z.enum(["bge-m3", "openrouter-text-embedding-3-small"]),
  embeddingGeneration: z.string().trim().min(1).max(256).regex(/^[a-zA-Z0-9._:/@-]+$/),
}).strict();

/** Cleanup is always previewed first; destructive pruning requires confirm: true. */
export const dataSourceEmbeddingPruneRequestSchema = z.object({
  confirm: z.boolean().default(false),
  expectedGenerations: z.array(generationIdentitySchema).max(2048).optional(),
}).strict().superRefine((value, context) => {
  if (value.confirm && (!value.expectedGenerations || value.expectedGenerations.length === 0)) {
    context.addIssue({ code: "custom", path: ["expectedGenerations"], message: "Confirm cleanup with the generation list returned by preview" });
  }
});

export type DataSourceEmbeddingPruneRequest = z.infer<typeof dataSourceEmbeddingPruneRequestSchema>;
