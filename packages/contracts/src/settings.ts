import { z } from "zod";

export const paperSizeSchema = z.enum(["A4"]);
export const duplexModeSchema = z.enum(["SIMPLEX", "LONG_EDGE", "SHORT_EDGE"]);
export const orientationSchema = z.enum(["AUTO", "PORTRAIT", "LANDSCAPE"]);
export const scalingModeSchema = z.enum(["FIT", "ACTUAL_SIZE"]);
export const colorModeSchema = z.enum(["MONOCHROME"]);

/**
 * Free text only in the sense that a customer types it. The server re-parses
 * and re-emits a canonical form, so this pattern exists to bound the input,
 * not to define the accepted semantics.
 */
export const pageRangeTextSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^$|^\d{1,6}(?:-\d{1,6})?(?:\s*,\s*\d{1,6}(?:-\d{1,6})?)*$/);

export const fileSelectionRequestSchema = z
  .object({
    fileId: z.string().uuid(),
    pageRanges: pageRangeTextSchema.nullable().default(null)
  })
  .strict();

export const updatePrintSettingsBodySchema = z
  .object({
    fileOrder: z.array(z.string().uuid()).min(1).max(10),
    fileSelections: z.array(fileSelectionRequestSchema).min(1).max(10),
    copies: z.number().int().min(1).max(100),
    duplex: duplexModeSchema,
    paperSize: paperSizeSchema,
    orientation: orientationSchema,
    scaling: scalingModeSchema,
    collate: z.boolean()
  })
  .strict();

export const normalizedPageRangeSchema = z.tuple([
  z.number().int().positive(),
  z.number().int().positive()
]);

export const fileSelectionSnapshotSchema = z
  .object({
    fileId: z.string().uuid(),
    position: z.number().int().nonnegative(),
    pageCount: z.number().int().positive(),
    pageRanges: z.array(normalizedPageRangeSchema).min(1),
    pageRangeText: z.string().min(1).max(400),
    selectedPages: z.number().int().positive()
  })
  .strict();

export const printSettingsSnapshotSchema = z
  .object({
    revision: z.number().int().positive(),
    copies: z.number().int().positive(),
    duplex: duplexModeSchema,
    paperSize: paperSizeSchema,
    orientation: orientationSchema,
    scaling: scalingModeSchema,
    collate: z.boolean(),
    colorMode: colorModeSchema,
    files: z.array(fileSelectionSnapshotSchema).min(1),
    selectedPages: z.number().int().positive(),
    printedSides: z.number().int().positive(),
    physicalSheets: z.number().int().positive(),
    createdAt: z.string().datetime()
  })
  .strict();

export const updatePrintSettingsResponseSchema = z
  .object({
    settings: printSettingsSnapshotSchema,
    sessionState: z.enum(["FILES_UPLOADED", "CONFIGURING"]),
    sessionVersion: z.number().int().positive(),
    quoteInvalidated: z.boolean()
  })
  .strict();

export const getPrintSettingsResponseSchema = z
  .object({ settings: printSettingsSnapshotSchema.nullable() })
  .strict();

/**
 * What the kiosk may offer. It is derived from the device capability snapshot
 * and the deployment limits so the touchscreen never presents a control the
 * server would reject.
 */
export const printCapabilitiesResponseSchema = z
  .object({
    capabilityVersion: z.number().int().positive(),
    paperSizes: z.array(paperSizeSchema).min(1),
    duplexModes: z.array(duplexModeSchema).min(1),
    orientations: z.array(orientationSchema).min(1),
    scalingModes: z.array(scalingModeSchema).min(1),
    colorModes: z.array(colorModeSchema).min(1),
    maxCopies: z.number().int().positive(),
    maxSelectedPages: z.number().int().positive(),
    maxPrintedSides: z.number().int().positive()
  })
  .strict();

export type PaperSize = z.infer<typeof paperSizeSchema>;
export type DuplexMode = z.infer<typeof duplexModeSchema>;
export type Orientation = z.infer<typeof orientationSchema>;
export type ScalingMode = z.infer<typeof scalingModeSchema>;
export type ColorMode = z.infer<typeof colorModeSchema>;
export type UpdatePrintSettingsBody = z.infer<typeof updatePrintSettingsBodySchema>;
export type FileSelectionSnapshot = z.infer<typeof fileSelectionSnapshotSchema>;
export type PrintSettingsSnapshot = z.infer<typeof printSettingsSnapshotSchema>;
export type UpdatePrintSettingsResponse = z.infer<typeof updatePrintSettingsResponseSchema>;
export type GetPrintSettingsResponse = z.infer<typeof getPrintSettingsResponseSchema>;
export type PrintCapabilitiesResponse = z.infer<typeof printCapabilitiesResponseSchema>;
