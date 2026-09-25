import { z } from 'zod';
import { ma2NetworkTargetSchema } from './ma2-bridge';
import { lightingMa2CueCatalogSchema } from './lighting';

export const ma2CatalogRequestSchema = z.object({ dataDirectory: z.string().max(4096), network: ma2NetworkTargetSchema.optional(), progressId: z.string().uuid().optional() }).strict();
export type Ma2CatalogRequest = z.infer<typeof ma2CatalogRequestSchema>;
export const ma2ReadProgressSchema = z.object({
  id: z.string().uuid(),
  phase: z.enum(['connecting', 'library', 'timecodes', 'verification', 'previews', 'raw']),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  detail: z.string().max(128),
  show: z.string().max(4096).optional(),
  sequences: lightingMa2CueCatalogSchema.max(1).optional()
}).strict().refine(value => value.completed <= value.total, '读取进度超过总数');
export type Ma2ReadProgress = z.infer<typeof ma2ReadProgressSchema>;
export type Ma2ReadProgressUpdate = Omit<Ma2ReadProgress, 'id'>;
export const ma2ObjectDirectorySchema = z.object({
  show: z.string().min(1).max(4096), generation: z.string().min(1).max(128), version: z.string().min(1).max(128),
  entries: z.array(z.object({ target: z.number().int().min(1).max(99999), name: z.string().max(4096) }).strict()).max(10000)
}).strict().refine(value => new Set(value.entries.map(entry => entry.target)).size === value.entries.length, '控台目录包含重复 Timecode');
export type Ma2ObjectDirectory = z.infer<typeof ma2ObjectDirectorySchema>;
export const ma2CatalogEntrySchema = z.object({
  target: z.number().int().min(1).max(99999), name: z.string(), eventCount: z.number().int().nonnegative().nullable(),
  frameFormat: z.string().nullable(), offset: z.string().nullable(), slot: z.string().nullable(),
  events: z.array(z.object({ path: z.string(), time: z.string(), action: z.string(), executor: z.string(), cue: z.string().nullable(), name: z.string().nullable() }).strict()),
  error: z.string().nullable(), warnings: z.array(z.string())
}).strict();
export const ma2CatalogSchema = z.object({ directory: ma2ObjectDirectorySchema, readAt: z.string().datetime(), entries: z.array(ma2CatalogEntrySchema) }).strict();
export type Ma2Catalog = z.infer<typeof ma2CatalogSchema>;
