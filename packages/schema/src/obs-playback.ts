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
const nativeObsNextFilesSchema = z.object({ snapshot: obsProgramSnapshotSchema, positionMs: z.number().finite().min(0).max(86_400_000) }).strict();
export const nativeObsPrepareSchema = z.object({ version: z.literal(1), sessionId: z.string().uuid(),
  generation: z.number().int().positive(), projectPath: z.string().min(1).max(4096), preciseSeeking: z.boolean(), snapshot: obsProgramSnapshotSchema,
  nextFiles: nativeObsNextFilesSchema.optional() }).strict();
export type NativeObsPrepare = z.infer<typeof nativeObsPrepareSchema>;
/** The next song's files and picture as the newest version has them, while a song's picture runs (0.5.9 S8b): what is
 * prepared ahead is let go and this is prepared instead. `generation` is the picture's own preparation, as for a stop;
 * the song's picture itself is not touched. `nextFiles: null`: nothing is prepared ahead any more. */
export const nativeObsNextSchema = z.object({ version: z.literal(1), sessionId: z.string().uuid(),
  generation: z.number().int().positive(), nextFiles: nativeObsNextFilesSchema.nullable() }).strict();
export type NativeObsNext = z.infer<typeof nativeObsNextSchema>;
export const nativeObsPreloadSchema = nativeObsPrepareSchema.extend({ positionMs: z.number().finite().min(0).max(86_400_000) });
export type NativeObsPreload = z.infer<typeof nativeObsPreloadSchema>;
/** Generation is the original preparation generation, not the latest audio
 * transport generation. An old UI cleanup cannot stop a replacement session. */
export const nativeObsStopSchema = z.object({ version: z.literal(1), sessionId: z.string().uuid(),
  generation: z.number().int().positive() }).strict();
export type NativeObsStop = z.infer<typeof nativeObsStopSchema>;
/** One part of the song's picture with something to report (0.5.9 design 01 §4.5), each on its own:
 * - `scope`: `channel` the whole picture path (the OBS connection), `item` only this part, `waiting` not a failure;
 * - `state`: `failed` OBS did not carry it out, `uncertain` sent and not known whether OBS carried it out,
 *   `not-aligned` on the picture but not in step with the music, `repairing` sent once more automatically,
 *   `limit` not sent again until the timeline moves on, `waiting` nothing wrong yet;
 * - `detail`: what the operator reads. */
export const obsPictureItemSchema = z.object({ id: z.string().min(1).max(2048), scope: z.enum(['channel', 'item', 'waiting']),
  state: z.enum(['failed', 'uncertain', 'not-aligned', 'repairing', 'limit', 'waiting']), detail: z.string().min(1) }).strict();
export type ObsPictureItem = z.infer<typeof obsPictureItemSchema>;
/** How often this song's picture recovered by itself, per recovery row and item (`output-recovery.ts`); `max` the
 * row's limit, absent for a limit in time. */
export const obsRecoveryCountSchema = z.object({ row: z.string().min(1), key: z.string(), count: z.number().int().nonnegative(),
  max: z.number().int().positive().optional(), exhausted: z.boolean() }).strict();
export type ObsRecoveryCount = z.infer<typeof obsRecoveryCountSchema>;
export const nativeObsStatusSchema = z.object({ version: z.literal(1), sessionId: z.string().uuid(),
  generation: z.number().int().positive(), itemId: z.string().min(1), revision: z.number().int().nonnegative(),
  state: z.enum(['preparing', 'ready', 'running', 'paused', 'stopped', 'failed']), reason: z.string().nullable(),
  notice: z.string().nullable().optional(),
  /** Latest live output fault; the channel keeps running. */
  fault: z.string().nullable().optional(),
  /** Every part of the picture with something to report, each on its own; a part that is right again leaves the list. */
  items: z.array(obsPictureItemSchema).max(256).optional(),
  recoveries: z.array(obsRecoveryCountSchema).max(256).optional(),
  nextCueId: z.string().nullable(), currentCueId: z.string().nullable(),
  pendingCount: z.number().int().nonnegative(), positionMs: z.number().finite().nonnegative()
}).strict();
export type NativeObsStatus = z.infer<typeof nativeObsStatusSchema>;
/** Sent while a missing OBS seek cache is being generated for one asset. */
export const obsMediaPreparationSchema = z.object({ assetName: z.string().min(1), index: z.number().int().nonnegative(),
  total: z.number().int().positive() }).strict().refine(value => value.index < value.total, '素材序号超出总数');
export type ObsMediaPreparation = z.infer<typeof obsMediaPreparationSchema>;
