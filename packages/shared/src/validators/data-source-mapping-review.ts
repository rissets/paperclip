import { z } from "zod";

const aggregationSchema = z.enum(["sum", "avg", "count", "min", "max"]);

const metricCorrectionSchema = z.object({
  index: z.number().int().min(0).max(999),
  name: z.string().trim().min(1).max(120),
  column: z.string().trim().min(1).max(256),
  aggregation: aggregationSchema,
  description: z.string().trim().max(500).optional().default(""),
}).strict();

const dimensionCorrectionSchema = z.object({
  index: z.number().int().min(0).max(999),
  name: z.string().trim().min(1).max(120),
  column: z.string().trim().min(1).max(256),
  description: z.string().trim().max(500).optional().default(""),
}).strict();

/** Human corrections bind labels to inspected columns; arbitrary SQL and samples are never accepted. */
export const dataSourceMappingReviewRequestSchema = z.object({
  decision: z.enum(["approved", "corrected"]),
  note: z.string().trim().max(1000).optional(),
  metricCorrections: z.array(metricCorrectionSchema).max(50).optional().default([]),
  dimensionCorrections: z.array(dimensionCorrectionSchema).max(50).optional().default([]),
}).strict().superRefine((value, context) => {
  const metricIndexes = value.metricCorrections.map((item) => item.index);
  if (new Set(metricIndexes).size !== metricIndexes.length) {
    context.addIssue({ code: "custom", path: ["metricCorrections"], message: "Metric indexes must be unique" });
  }
  const dimensionIndexes = value.dimensionCorrections.map((item) => item.index);
  if (new Set(dimensionIndexes).size !== dimensionIndexes.length) {
    context.addIssue({ code: "custom", path: ["dimensionCorrections"], message: "Dimension indexes must be unique" });
  }
  if (value.decision === "corrected" && value.metricCorrections.length === 0 && value.dimensionCorrections.length === 0) {
    context.addIssue({ code: "custom", path: ["decision"], message: "At least one semantic mapping correction is required" });
  }
});

export type DataSourceMappingReviewRequest = z.infer<typeof dataSourceMappingReviewRequestSchema>;
