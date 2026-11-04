import { z } from 'zod';
import { ma2SongBindingSchema } from './ma2-song-binding';
import { ma2ConsoleChangesSchema, ma2NetworkTargetSchema, ma2WriteModeSchema } from './ma2-bridge';
import { ma2LayoutSettingsSchema, ma2LayoutSnapshotSchema } from './ma2-layout';
import { ma2EffectLibrarySchema } from './ma2-effect-library';
import { ma2LabelSchema } from './ma2-rename';

const source = z.object({ show: z.string().min(1), generation: z.string().min(1), version: z.string().min(1) }).strict();
const cueNumber = z.string().regex(/^\d{1,4}(?:\.\d{1,3})?$/, 'Cue 编号须为 1–9999，最多 3 位小数').refine(value => Number(value) > 0, 'Cue 编号须大于 0');
export const ma2SongPointSchema = z.object({ id: z.string().min(1), name: z.string().max(512).regex(/^[^\u0000-\u001f"\\]*$/), atMs: z.number().finite().nonnegative(),
  cues: z.array(z.object({ sequence: z.number().int().min(1).max(99999), cue: cueNumber, delayMs: z.number().finite().nonnegative() }).strict()).max(32)
}).strict();
export const ma2SongSyncRequestSchema = z.object({ network: ma2NetworkTargetSchema, expectedSource: source, projectId: z.string().uuid(), itemId: z.string().min(1), requestId: z.string().uuid(),
  settings: ma2LayoutSettingsSchema, name: ma2LabelSchema, points: z.array(ma2SongPointSchema).max(9999), binding: ma2SongBindingSchema.optional(),
  progressId: z.string().uuid().optional(),
  /** Explicit operator request: rewrite names the app once wrote in Chinese as their pinyin. */
  rewriteLegacyNames: z.boolean().optional(),
  /** The song's MTC start; with it the sync also writes the song's own Timecode show. */
  timecodeStartMs: z.number().int().min(0).max(86399999).optional(),
  /** The song's length: the show runs, and reads as taken, for the whole song rather than up to its last point. */
  timecodeLengthMs: z.number().int().positive().max(86400000).optional(),
  /** What the operator chose; without it the sync merges and reads console edits back. */
  writeMode: ma2WriteModeSchema.optional(),
  consoleChanges: ma2ConsoleChangesSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (!value.points.length && !value.binding) ctx.addIssue({ code: 'custom', message: '新歌要先添加 Cue；已关联的歌确认后可以清空' });
  if (new Set(value.points.map(point => point.id)).size !== value.points.length) ctx.addIssue({ code: 'custom', message: '歌曲 Cue 身份重复' });
});
/**
 * Edits made on the console since the last confirmed sync that the sync took over (2026-10-26, both
 * ways): a point's time moved in the song's Timecode show, a point whose Cue or trigger was deleted,
 * a trigger added for a Cue of the song's Sequence. The software applies each to a point it has not
 * changed itself meanwhile.
 */
export const ma2SongConsoleEditsSchema = z.object({
  moved: z.array(z.object({ id: z.string().min(1), atMs: z.number().finite().nonnegative() }).strict()),
  removed: z.array(z.string().min(1)),
  added: z.array(z.object({ id: z.string().min(1), name: z.string().max(512), atMs: z.number().finite().nonnegative(), cue: cueNumber }).strict())
}).strict();
export const ma2SongSyncResultSchema = z.object({ binding: ma2SongBindingSchema, library: ma2EffectLibrarySchema, layout: ma2LayoutSnapshotSchema.nullable(),
  backupFile: z.string(), changed: z.boolean(),
  remoteRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  consoleEdits: ma2SongConsoleEditsSchema.optional()
}).strict();
export type Ma2SongPoint = z.infer<typeof ma2SongPointSchema>;
export type Ma2SongSyncRequest = z.infer<typeof ma2SongSyncRequestSchema>;
export type Ma2SongSyncResult = z.infer<typeof ma2SongSyncResultSchema>;
export type Ma2SongConsoleEdits = z.infer<typeof ma2SongConsoleEditsSchema>;
export const ma2SongCheckRequestSchema = z.object({
  network: ma2NetworkTargetSchema, expectedSource: source, sequence: z.number().int().min(1).max(99999),
  executor: z.string().regex(/^[1-9]\d{0,3}\.[1-9]\d{0,2}$/).optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  /** The song's own Timecode show as last written: an edit made there on the console is a change too. */
  timecode: z.object({ number: z.number().int().min(1).max(99999), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional()
}).strict();
export type Ma2SongCheckRequest = z.infer<typeof ma2SongCheckRequestSchema>;
