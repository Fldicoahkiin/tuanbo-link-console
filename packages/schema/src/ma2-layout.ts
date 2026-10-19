import { z } from 'zod';
import { ma2NetworkTargetSchema } from './ma2-bridge';
import { ma2LabelSchema } from './ma2-rename';
import { ma2EffectLibrarySchema } from './ma2-effect-library';

export const ma2LayoutSettingsSchema = z.object({ layout: z.number().int().min(1).max(9999), executorPage: z.number().int().min(1).max(9999).optional(), name: ma2LabelSchema, nextSequence: z.number().int().min(1).max(99999), columns: z.number().int().min(1).max(24) }).strict();
export const ma2LayoutSnapshotSchema = z.object({
  layout: z.number().int().min(1).max(9999), revision: z.string().regex(/^[a-f0-9]{64}$/).optional(), name: z.string().max(512), readAt: z.string().datetime(),
  items: z.array(z.object({ id: z.string(), x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(), height: z.number().finite().positive(),
    name: z.string().max(512), sequence: z.number().int().min(1).max(99999).optional(), cue: z.string().optional(), kind: z.enum(['sequence', 'cue', 'other']), reference: z.array(z.string().max(128)).max(16)
  }).strict()).max(10000), omittedFixtures: z.number().int().nonnegative()
}).strict();
const source = z.object({ show: z.string().min(1), generation: z.string().min(1), version: z.string().min(1) }).strict();
const base = z.object({ network: ma2NetworkTargetSchema, expectedSource: source });
export const ma2LayoutReadRequestSchema = base.extend({ layout: z.number().int().min(1).max(9999) }).strict();
export const ma2NewCueRequestSchema = base.extend({
  projectId: z.string().uuid(), requestId: z.string().uuid(), settings: ma2LayoutSettingsSchema, name: ma2LabelSchema,
  content: z.discriminatedUnion('kind', [z.object({ kind: z.literal('programmer'), use: z.enum(['Active', 'Look']) }).strict(), z.object({ kind: z.literal('combine'), cues: z.array(z.object({ sequence: z.number().int().min(1).max(99999), cue: z.string().regex(/^[1-9]\d{0,3}(?:\.\d{1,3})?$|^0\.\d{1,3}$/) }).strict()).min(1).max(32) }).strict()])
}).strict();
export const ma2NewCueResultSchema = z.object({ layout: ma2LayoutSnapshotSchema, sequence: z.number().int().positive(), cue: z.literal('1.000'), library: ma2EffectLibrarySchema, backupFile: z.string() }).strict();
export type Ma2LayoutSettings = z.infer<typeof ma2LayoutSettingsSchema>;
export type Ma2LayoutSnapshot = z.infer<typeof ma2LayoutSnapshotSchema>;
export type Ma2LayoutReadRequest = z.infer<typeof ma2LayoutReadRequestSchema>;
export type Ma2NewCueRequest = z.infer<typeof ma2NewCueRequestSchema>;
export type Ma2NewCueResult = z.infer<typeof ma2NewCueResultSchema>;

export const ma2LayoutDirectoryRequestSchema = base.strict();
export const ma2LayoutDirectorySchema = z.array(z.object({ layout: z.number().int().min(1).max(9999), name: z.string().max(512) }).strict()).max(9999);
export const ma2LayoutUpdateRequestSchema = base.extend({ layout: z.number().int().min(1).max(9999), revision: z.string().regex(/^[a-f0-9]{64}$/), name: ma2LabelSchema.optional(),
  positions: z.array(z.object({ id: z.string().regex(/^\d+$/), x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) }).strict()).max(10000)
}).strict();
export type Ma2LayoutDirectoryRequest = z.infer<typeof ma2LayoutDirectoryRequestSchema>;
export type Ma2LayoutDirectory = z.infer<typeof ma2LayoutDirectorySchema>;
export type Ma2LayoutUpdateRequest = z.infer<typeof ma2LayoutUpdateRequestSchema>;
