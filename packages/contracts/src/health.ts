import { z } from "zod";

export const productScopeSchema = z.object({
  service: z.literal("PRINT_ONLY"),
  outputMode: z.literal("MONOCHROME"),
  scanningEnabled: z.literal(false),
  photocopyEnabled: z.literal(false)
});

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "ready", "not_ready"]),
  service: z.string().min(1),
  timestamp: z.string().datetime(),
  productScope: productScopeSchema.optional(),
  checks: z.record(z.string(), z.enum(["ok", "failed"])).optional()
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ProductScope = z.infer<typeof productScopeSchema>;

export const PRODUCT_SCOPE = {
  service: "PRINT_ONLY",
  outputMode: "MONOCHROME",
  scanningEnabled: false,
  photocopyEnabled: false
} as const satisfies ProductScope;
