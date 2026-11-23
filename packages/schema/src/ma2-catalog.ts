import { z } from 'zod';
import { ma2NetworkTargetSchema, ma2SequenceAssignmentSchema, ma2TimecodePreviewSchema } from './ma2-bridge';
import { ma2CueValueEditsSchema, cueAttributeNamesSchema, lightingMa2CueCatalogSchema, lightingMa2BindingSchema, lightingTrackSchema } from './lighting';

export const ma2CatalogRequestSchema = z.object({ songPlayback: z.object({
  startMs: z.number().int().nonnegative().lt(86400000), durationMs: z.number().finite().positive().max(86400000)
}).strict().optional(), otherClockBindings: z.array(z.object({ target: z.number().int().min(1).max(99999), slot: z.string().max(64) }).strict()).max(10000).optional(), checkMtcFor: z.array(z.number().int().min(1).max(99999)).min(1).max(10000).optional(), details: z.enum(['attributes', 'source', 'empty-cues']).optional(), dataDirectory: z.string().max(4096), network: ma2NetworkTargetSchema.optional(), progressId: z.string().uuid().optional(), projectPath: z.string().max(4096).optional(), projectId: z.string().min(1).optional(), expectedSource: z.object({ show: z.string(), generation: z.string(), version: z.string() }).strict().optional(), targets: z.array(z.number().int().min(1).max(99999)).max(10000).optional() }).strict();
/** Resolve one pool reference in this verified Show without touching operator-owned executors. */
export const ma2PoolRouteRequestSchema = ma2CatalogRequestSchema.pick({ network: true, dataDirectory: true, projectId: true, expectedSource: true }).required({ projectId: true, expectedSource: true }).extend({ sequence: z.number().int().min(1).max(99999) });
export type Ma2PoolRouteRequest = z.infer<typeof ma2PoolRouteRequestSchema>;
export const ma2PoolRouteSchema = ma2SequenceAssignmentSchema.extend({ executorName: z.string().min(1).max(512) });
export type Ma2PoolRoute = z.infer<typeof ma2PoolRouteSchema>;
const firstTrackSource = z.object({ valueEdits: ma2CueValueEditsSchema.optional(), attributes: cueAttributeNamesSchema.optional(), includeTracking: z.boolean().optional(), sequence: z.number().int().min(1).max(99999), cue: z.string().regex(/^\d{1,4}(?:\.\d{1,3})?$/).refine(value => Number(value) > 0) }).strict();
export const ma2CueAttributesRequestSchema = ma2PoolRouteRequestSchema.omit({projectId: true}).extend({
  cue: firstTrackSource.shape.cue, includeTracking: z.boolean()
});
export const ma2WriteCueValuesRequestSchema = ma2CueAttributesRequestSchema.extend({ edits: ma2CueValueEditsSchema });
export type Ma2WriteCueValuesRequest = z.infer<typeof ma2WriteCueValuesRequestSchema>;
export type Ma2CueAttributesRequest = z.infer<typeof ma2CueAttributesRequestSchema>;
export const ma2FirstTrackRequestSchema = ma2PoolRouteRequestSchema.omit({ sequence: true }).extend({
  itemId: z.string().min(1), timecode: z.number().int().min(1).max(99999),
  executor: z.string().regex(/^[1-9]\d{0,3}\.[1-9]\d{0,2}$/),
  expectedSequence: z.number().int().min(1).max(99999).optional(),
  points: z.array(z.object({ id: z.string().min(1), sources: z.array(firstTrackSource).max(32) }).strict()).min(1).max(9999)
});
export type Ma2FirstTrackRequest = z.infer<typeof ma2FirstTrackRequestSchema>;
export const ma2FirstTrackReceiptSchema = z.object({
  executor: ma2FirstTrackRequestSchema.shape.executor,
  sequence: firstTrackSource.shape.sequence, cues: z.array(firstTrackSource.shape.cue).min(1),
  backupFile: z.string().regex(/^tblink_backup_[a-f0-9]{32}\.xml$/).nullable()
}).strict();
export type Ma2FirstTrackReceipt = z.infer<typeof ma2FirstTrackReceiptSchema>;
const selectorSettingsTarget = z.number().int().min(1).max(99999);
const selectorTrackConflict = z.object({ timecode: selectorSettingsTarget, track: z.number().int().positive(), executor: ma2FirstTrackRequestSchema.shape.executor }).strict();
export type Ma2SelectorTrackConflict = z.infer<typeof selectorTrackConflict>;
const songSettingsTargets = z.array(z.number().int().min(1).max(99999)).min(1).max(256);
export const ma2PlaybackPrepareSchema = ma2CatalogRequestSchema.pick({ expectedSource: true }).extend({ muteSelectorTrack: selectorTrackConflict.optional(), selectorTriggerTarget: selectorSettingsTarget.optional(), selectorCommandTarget: selectorSettingsTarget.optional(), selectorSettingsTarget: selectorSettingsTarget.optional(), songSettingsTargets: songSettingsTargets.optional(), songTriggerTargets: songSettingsTargets.optional(), network: ma2NetworkTargetSchema, progressId: z.string().uuid() });
export type Ma2PlaybackPrepare = z.infer<typeof ma2PlaybackPrepareSchema>;
export type Ma2CatalogRequest = z.infer<typeof ma2CatalogRequestSchema>;
const ma2ReadProgressBaseSchema = z.object({
  id: z.string().uuid(),
  phase: z.enum(['selection', 'connecting', 'library', 'timecodes', 'verification', 'previews', 'raw']),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  detail: z.string().max(128),
  show: z.string().max(4096).optional(),
  sequences: lightingMa2CueCatalogSchema.max(1).optional(),
  libraryError: z.object({ sequence: z.number().int().positive(), message: z.string() }).strict().optional()
}).strict().refine(value => value.completed <= value.total, '读取进度超过总数');
export const ma2ObjectDirectorySchema = z.object({
  show: z.string().min(1).max(4096), generation: z.string().min(1).max(128), version: z.string().min(1).max(128),
  entries: z.array(z.object({ target: z.number().int().min(1).max(99999), name: z.string().max(4096), internal: z.literal(true).optional() }).strict()).max(10000)
}).strict().refine(value => new Set(value.entries.map(entry => entry.target)).size === value.entries.length, '控台目录包含重复 Timecode');
export type Ma2ObjectDirectory = z.infer<typeof ma2ObjectDirectorySchema>;
export const ma2CatalogEntrySchema = z.object({
  sourceXml: z.string().max(32 * 1024 * 1024).optional(),
  preview: ma2TimecodePreviewSchema.optional(),
  conversionError: z.string().optional(),
  readAt: z.string().datetime().optional(),
  target: z.number().int().min(1).max(99999), name: z.string(), eventCount: z.number().int().nonnegative().nullable(),
  frameFormat: z.string().nullable(), offset: z.string().nullable(), slot: z.string().nullable(),
  // MA2 spells it `lenght`: 30 Hz ticks after the offset. Older saved catalogs have no length.
  length: z.string().nullable().optional(),
  events: z.array(z.object({ path: z.string(), time: z.string(), action: z.string(), executor: z.string(), cue: z.string().nullable(), name: z.string().nullable() }).strict()),
  error: z.string().nullable(), warnings: z.array(z.string())
}).strict();
export const ma2CatalogSchema = z.object({ selectorTrackConflict: selectorTrackConflict.optional(), afterRollSeconds: z.number().finite().nonnegative().optional(), songOffsets: z.array(z.object({ target: z.number().int().min(1).max(99999), offset: z.string().max(32) }).strict()).max(10000).optional(), selectorTriggerTarget: selectorSettingsTarget.optional(), selectorCommandTarget: selectorSettingsTarget.optional(), selectorSettingsTarget: selectorSettingsTarget.optional(), playbackClockNote: z.string().max(512).optional(), songSettingsTargets: songSettingsTargets.optional(), songTriggerTargets: songSettingsTargets.optional(), needsPlaybackPreparation: z.literal(true).optional(), playbackConflict: z.string().max(512).optional(), directory: ma2ObjectDirectorySchema, readAt: z.string().datetime(), entries: z.array(ma2CatalogEntrySchema),
  incomplete: z.string().optional(),
  sourceUnverified: z.boolean().optional(),
  metrics: z.object({ queueMs: z.number().nonnegative().optional(), elapsedMs: z.number().nonnegative(), requests: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), wireCommands: z.number().int().nonnegative().optional(), receivedBytes: z.number().int().nonnegative().optional(), sentBytes: z.number().int().nonnegative().optional(), phases: z.record(z.string(), z.number().nonnegative()) }).strict().optional()
}).strict();
export type Ma2Catalog = z.infer<typeof ma2CatalogSchema>;
/** Where each console Timecode show sits in time, as the console's own export says (values as written there). */
export const ma2RangeSourceSchema = z.union([ma2NetworkTargetSchema, z.object({ dataDirectory: z.string().min(1).max(4096) }).strict()]);
export type Ma2RangeSource = z.infer<typeof ma2RangeSourceSchema>;
const timecodeEventLocation = z.object({ track: z.number().int().positive(), event: z.number().int().positive(), frame: z.number().int().nonnegative() }).strict();
export const ma2TimecodeRangesSchema = z.object({
  songTrackExecutors: z.array(ma2FirstTrackRequestSchema.shape.executor).max(10000).optional(),
  selectorTrackConflict: selectorTrackConflict.optional(),
  afterRollSeconds: z.number().finite().nonnegative().optional(),
  otherTimedCues: z.array(z.object({ owner: selectorSettingsTarget, sequence: selectorSettingsTarget, cue: z.string().regex(/^\d{1,6}\.\d{3}$/), seconds: z.number().nonnegative() }).strict()).max(100000).optional(),
  selectorCommandTarget: selectorSettingsTarget.optional(), selectorSettingsTarget: selectorSettingsTarget.optional(), selectorReady: z.union([z.literal(false), z.number().int().min(1).max(99999)]).optional(), generation: z.string().min(1).max(128).optional(), show: z.string().min(1).max(4096), entries: z.array(z.object({
  target: z.number().int().min(1).max(99999), name: z.string().max(1024), offset: z.string().max(32), length: z.string().max(32), slot: z.string().max(64), frame: z.string().max(64), last: z.string().max(32), playbackSettingsChanged: z.literal(true).optional(), automaticCueTriggers: z.literal(true).optional(),
  missingCueTarget: timecodeEventLocation.optional(), missingExecutorTarget: timecodeEventLocation.optional(),
  routeMismatch: z.object({ track: z.number().int().positive(), executor: z.string().regex(/^[1-9]\d{0,4}\.[1-9]\d{0,4}$/).nullable(), assigned: z.number().int().min(1).max(99999).nullable(), referenced: z.number().int().min(1).max(99999), step: z.number().int().positive() }).strict().optional(), readySequences: z.array(z.number().int().min(1).max(99999)).max(10000).optional(), internal: z.literal(true).optional()
}).strict()).max(10000) }).strict();
export type Ma2TimecodeRanges = z.infer<typeof ma2TimecodeRangesSchema>;
export const ma2ReadProgressSchema = ma2ReadProgressBaseSchema.safeExtend({
  checkpoint: z.object({ directory: ma2ObjectDirectorySchema, readAt: z.string().datetime(), entry: ma2CatalogEntrySchema.optional() }).strict().optional()
});
export type Ma2ReadProgress = z.infer<typeof ma2ReadProgressSchema>;
export type Ma2ReadProgressUpdate = Omit<Ma2ReadProgress, 'id'>;
export const ma2PairingRecordSchema = z.object({
  itemId: z.string().min(1), status: z.enum(['suggested', 'confirmed', 'stale']),
  evidence: z.string(), reason: z.string().optional()
}).strict();
export type Ma2PairingRecord = z.infer<typeof ma2PairingRecordSchema>;
export const ma2ReadStateSchema = z.object({
  formatVersion: z.literal(2).optional(),
  pairings: z.record(z.string(), ma2PairingRecordSchema).optional(),
  detachedBindings: z.array(z.object({ itemId: z.string(), detachedAt: z.string().datetime(), binding: lightingMa2BindingSchema, tracks: z.array(lightingTrackSchema) }).strict()).optional(),
  source: z.string().min(1).max(4096), catalog: ma2CatalogSchema,
  pairs: z.record(z.string(), z.string()), failures: z.array(z.object({ target: z.number().int().positive(), message: z.string() }).strict()),
  selectedTarget: z.number().int().positive().nullable(), query: z.string(), filter: z.enum(['all', 'pending', 'native', 'error']), message: z.string()
}).strict();
export type Ma2ReadState = z.infer<typeof ma2ReadStateSchema>;
