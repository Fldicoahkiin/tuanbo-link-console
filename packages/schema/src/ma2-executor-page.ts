import { z } from 'zod';
import { ma2LayoutDirectoryRequestSchema } from './ma2-layout';
import { ma2EffectLibrarySchema } from './ma2-effect-library';
import { ma2LabelSchema } from './ma2-label';

export const ma2ExecutorPageItemSchema = z.object({
  slot: z.number().int().min(1).max(240), width: z.number().int().min(1).max(15), name: z.string().max(512),
  sequence: z.number().int().min(1).max(99999).optional(), kind: z.enum(['sequence', 'other']),
  button: z.number().int().nonnegative().nullable(), reference: z.array(z.string().max(128)).max(16),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  buttons: z.array(z.number().int().nonnegative()).max(4).optional(),
  color: z.string().regex(/^#[a-fA-F0-9]{6}$/).optional(),
  priority: z.string().max(64).optional(),
  softLtp: z.boolean().optional(),
  fader: z.number().int().nonnegative().optional()
}).strict();

export const ma2ExecutorPageRequestSchema = ma2LayoutDirectoryRequestSchema.extend({ page: z.number().int().min(1).max(9999) }).strict();
export const ma2ExecutorPageDirectorySchema = z.object({
  show: z.string().min(1), generation: z.string().min(1), version: z.string().min(1),
  buttonPage: z.number().int().min(1).max(9999), faderPage: z.number().int().min(1).max(9999),
  pages: z.array(z.object({ page: z.number().int().min(1).max(9999), name: z.string().max(512) }).strict()).max(9999)
}).strict();
export const ma2ExecutorPageSchema = z.object({
  page: z.number().int().min(1).max(9999), name: z.string().max(512), readAt: z.string().datetime(),
  source: ma2LayoutDirectoryRequestSchema.shape.expectedSource.optional(),
  sequences: ma2EffectLibrarySchema.shape.sequences.default([]),
  items: z.array(ma2ExecutorPageItemSchema).max(240)
}).strict();
export const ma2ExecutorUpdateRequestSchema = ma2LayoutDirectoryRequestSchema.extend({
  page: z.number().int().min(1).max(9999),
  slot: z.number().int().min(1).max(240),
  expectedItem: ma2ExecutorPageItemSchema,
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('move'), page: z.number().int().min(1).max(9999), slot: z.number().int().min(1).max(240) }).strict(),
    z.object({ kind: z.literal('rename'), name: ma2LabelSchema }).strict(),
    z.object({ kind: z.literal('delete') }).strict()
  ])
}).strict().refine(request => request.slot === request.expectedItem.slot, '执行器来源格子不一致');
export const ma2ExecutorUpdateResultSchema = z.object({
  pages: z.array(ma2ExecutorPageSchema).min(1).max(2),
  backupFile: z.string().min(1).max(4096)
}).strict();
export const ma2ExecutorInputSchema = ma2LayoutDirectoryRequestSchema.extend({
  page: z.number().int().min(1).max(9999), slot: z.number().int().min(1).max(240),
  expectedItem: ma2ExecutorPageItemSchema, button: z.number().int().min(0).max(2),
  pressed: z.boolean(), sessionId: z.string().uuid(), deadlineAt: z.number().int().positive()
}).strict().refine(request => request.slot === request.expectedItem.slot, '执行器来源格子不一致');
export type Ma2ExecutorPageRequest = z.infer<typeof ma2ExecutorPageRequestSchema>;
export type Ma2ExecutorPageDirectory = z.infer<typeof ma2ExecutorPageDirectorySchema>;
export type Ma2ExecutorPage = z.infer<typeof ma2ExecutorPageSchema>;
export type Ma2ExecutorUpdateRequest = z.infer<typeof ma2ExecutorUpdateRequestSchema>;
export type Ma2ExecutorUpdateResult = z.infer<typeof ma2ExecutorUpdateResultSchema>;
export type Ma2ExecutorInput = z.infer<typeof ma2ExecutorInputSchema>;
