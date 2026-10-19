import { z } from 'zod';
import { ma2LayoutDirectoryRequestSchema } from './ma2-layout';
import { ma2EffectLibrarySchema } from './ma2-effect-library';

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
  items: z.array(z.object({
    slot: z.number().int().min(1).max(240), width: z.number().int().min(1).max(15), name: z.string().max(512),
    sequence: z.number().int().min(1).max(99999).optional(), kind: z.enum(['sequence', 'other']),
    button: z.number().int().nonnegative().nullable(), reference: z.array(z.string().max(128)).max(16)
  }).strict()).max(240)
}).strict();
export type Ma2ExecutorPageRequest = z.infer<typeof ma2ExecutorPageRequestSchema>;
export type Ma2ExecutorPageDirectory = z.infer<typeof ma2ExecutorPageDirectorySchema>;
export type Ma2ExecutorPage = z.infer<typeof ma2ExecutorPageSchema>;
