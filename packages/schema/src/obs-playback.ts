import { z } from 'zod';
import { mtcFrameRateSchema, outputCanvasSchema, rundownItemSchema, linkMediaAssetSchema } from './link-project';

export const obsProgramSnapshotSchema = z.object({
  version: z.literal(1), projectId: z.string().min(1), revision: z.number().int().nonnegative(),
  frameRate: mtcFrameRateSchema, outputCanvas: outputCanvasSchema, internalVideoAudio: z.boolean(),
  item: rundownItemSchema.pick({ id: true, title: true, enabled: true, notes: true, referenceAudio: true,
    visualLayers: true, referenceMediaClips: true, cues: true }).strict(),
  assets: z.array(linkMediaAssetSchema)
}).strict();
export type ObsProgramSnapshot = z.infer<typeof obsProgramSnapshotSchema>;
export const nativeObsPrepareSchema = z.object({ version: z.literal(1), sessionId: z.string().uuid(),
  generation: z.number().int().positive(), projectPath: z.string().min(1).max(4096), preciseSeeking: z.boolean(), snapshot: obsProgramSnapshotSchema,
  nextFiles: z.object({ snapshot: obsProgramSnapshotSchema, positionMs: z.number().finite().min(0).max(86_400_000) }).strict().optional() }).strict();
export type NativeObsPrepare = z.infer<typeof nativeObsPrepareSchema>;
export const nativeObsPreloadSchema = nativeObsPrepareSchema.extend({ positionMs: z.number().finite().min(0).max(86_400_000) });
export type NativeObsPreload = z.infer<typeof nativeObsPreloadSchema>;
/** Generation is the original preparation generation, not the latest audio
 * transport generation. An old UI cleanup cannot stop a replacement session. */
export const nativeObsStopSchema = z.object({ version: z.literal(1), sessionId: z.string().uuid(),
  generation: z.number().int().positive() }).strict();
export type NativeObsStop = z.infer<typeof nativeObsStopSchema>;
export const nativeObsStatusSchema = z.object({ version: z.literal(1), sessionId: z.string().uuid(),
  generation: z.number().int().positive(), itemId: z.string().min(1), revision: z.number().int().nonnegative(),
  state: z.enum(['preparing', 'ready', 'running', 'paused', 'stopped', 'failed']), reason: z.string().nullable(),
  notice: z.string().nullable().optional(),
  nextCueId: z.string().nullable(), currentCueId: z.string().nullable(),
  pendingCount: z.number().int().nonnegative(), positionMs: z.number().finite().nonnegative()
}).strict();
export type NativeObsStatus = z.infer<typeof nativeObsStatusSchema>;
