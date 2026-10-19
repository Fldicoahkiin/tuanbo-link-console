import { z } from 'zod';
import { ma2SongBindingSchema } from './ma2-song-binding';
import { ma2NetworkTargetSchema } from './ma2-bridge';
import { ma2LayoutSettingsSchema, ma2LayoutSnapshotSchema } from './ma2-layout';
import { ma2EffectLibrarySchema } from './ma2-effect-library';
import { ma2LabelSchema } from './ma2-rename';

const source = z.object({ show: z.string().min(1), generation: z.string().min(1), version: z.string().min(1) }).strict();
const cueNumber = z.string().regex(/^\d{1,4}(?:\.\d{1,3})?$/).refine(value => Number(value) > 0);
export const ma2SongPointSchema = z.object({ id: z.string().min(1), name: z.string().max(512).regex(/^[^\u0000-\u001f"\\]*$/), atMs: z.number().finite().nonnegative(),
  cues: z.array(z.object({ sequence: z.number().int().min(1).max(99999), cue: cueNumber, delayMs: z.number().finite().nonnegative() }).strict()).max(32)
}).strict();
export const ma2SongSyncRequestSchema = z.object({ network: ma2NetworkTargetSchema, expectedSource: source, projectId: z.string().uuid(), itemId: z.string().min(1), requestId: z.string().uuid(),
  settings: ma2LayoutSettingsSchema, name: ma2LabelSchema, points: z.array(ma2SongPointSchema).min(1).max(9999), binding: ma2SongBindingSchema.optional(),
  confirmedDeletions: z.array(cueNumber).max(9999).optional()
}).strict().superRefine((value, ctx) => { if (new Set(value.points.map(point => point.id)).size !== value.points.length) ctx.addIssue({ code: 'custom', message: '歌曲 Cue 身份重复' }); });
export const ma2SongSyncResultSchema = z.object({ binding: ma2SongBindingSchema, library: ma2EffectLibrarySchema, layout: ma2LayoutSnapshotSchema.nullable(),
  removed: z.array(z.string()), backupFile: z.string(), changed: z.boolean()
}).strict();
export type Ma2SongPoint = z.infer<typeof ma2SongPointSchema>;
export type Ma2SongSyncRequest = z.infer<typeof ma2SongSyncRequestSchema>;
export type Ma2SongSyncResult = z.infer<typeof ma2SongSyncResultSchema>;
