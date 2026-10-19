import { z } from 'zod';
import { ma2NetworkTargetSchema, ma2TimecodePreviewSchema } from './ma2-bridge';
import { lightingMa2CueCatalogSchema, lightingMa2BindingSchema, lightingTrackSchema } from './lighting';

export const ma2CatalogRequestSchema = z.object({ details: z.literal('attributes').optional(), dataDirectory: z.string().max(4096), network: ma2NetworkTargetSchema.optional(), progressId: z.string().uuid().optional(), projectPath: z.string().max(4096).optional(), projectId: z.string().min(1).optional(), expectedSource: z.object({ show: z.string(), generation: z.string(), version: z.string() }).strict().optional(), targets: z.array(z.number().int().min(1).max(99999)).max(10000).optional() }).strict();
export type Ma2CatalogRequest = z.infer<typeof ma2CatalogRequestSchema>;
const ma2ReadProgressBaseSchema = z.object({
  id: z.string().uuid(),
  phase: z.enum(['connecting', 'library', 'timecodes', 'verification', 'previews', 'raw']),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  detail: z.string().max(128),
  show: z.string().max(4096).optional(),
  sequences: lightingMa2CueCatalogSchema.max(1).optional(),
  libraryError: z.object({ sequence: z.number().int().positive(), message: z.string() }).strict().optional()
}).strict().refine(value => value.completed <= value.total, '读取进度超过总数');
export const ma2ObjectDirectorySchema = z.object({
  show: z.string().min(1).max(4096), generation: z.string().min(1).max(128), version: z.string().min(1).max(128),
  entries: z.array(z.object({ target: z.number().int().min(1).max(99999), name: z.string().max(4096) }).strict()).max(10000)
}).strict().refine(value => new Set(value.entries.map(entry => entry.target)).size === value.entries.length, '控台目录包含重复 Timecode');
export type Ma2ObjectDirectory = z.infer<typeof ma2ObjectDirectorySchema>;
export const ma2CatalogEntrySchema = z.object({
  sourceXml: z.string().max(32 * 1024 * 1024).optional(),
  preview: ma2TimecodePreviewSchema.optional(),
  conversionError: z.string().optional(),
  readAt: z.string().datetime().optional(),
  target: z.number().int().min(1).max(99999), name: z.string(), eventCount: z.number().int().nonnegative().nullable(),
  frameFormat: z.string().nullable(), offset: z.string().nullable(), slot: z.string().nullable(),
  events: z.array(z.object({ path: z.string(), time: z.string(), action: z.string(), executor: z.string(), cue: z.string().nullable(), name: z.string().nullable() }).strict()),
  error: z.string().nullable(), warnings: z.array(z.string())
}).strict();
export const ma2CatalogSchema = z.object({ directory: ma2ObjectDirectorySchema, readAt: z.string().datetime(), entries: z.array(ma2CatalogEntrySchema),
  incomplete: z.string().optional(),
  sourceUnverified: z.boolean().optional(),
  metrics: z.object({ queueMs: z.number().nonnegative().optional(), elapsedMs: z.number().nonnegative(), requests: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), wireCommands: z.number().int().nonnegative().optional(), receivedBytes: z.number().int().nonnegative().optional(), sentBytes: z.number().int().nonnegative().optional(), phases: z.record(z.string(), z.number().nonnegative()) }).strict().optional()
}).strict();
export type Ma2Catalog = z.infer<typeof ma2CatalogSchema>;
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
