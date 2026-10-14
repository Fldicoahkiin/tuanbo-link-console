import { z } from 'zod';
import { lightingDocumentSchema, lightingMa2BindingSchema } from './lighting';
import { ma2NetworkTargetSchema } from './ma2-bridge';
import { ma2ObjectDirectorySchema } from './ma2-catalog';

export const ma2AutoBindPlanSchema = z.object({
  bindingId: z.string().min(1),
  newBinding: lightingMa2BindingSchema.optional(),
  assignments: z.array(z.object({ sequence: z.number().int().min(1).max(99999), executor: z.string().regex(/^[1-9]\d*\.[1-9]\d*$/), executorName: z.string().min(1).max(512), pool: z.boolean() }).strict())
}).strict();
export const ma2AutoBindRequestSchema = z.object({
  dataDirectory: z.string().max(4096), network: ma2NetworkTargetSchema.optional(),
  projectId: z.string().min(1).max(256), itemId: z.string().min(1).max(256),
  document: lightingDocumentSchema,
  expectedSource: z.object({ show: ma2ObjectDirectorySchema.shape.show, generation: ma2ObjectDirectorySchema.shape.generation, version: ma2ObjectDirectorySchema.shape.version }).strict()
}).strict();
export const ma2AutoBindResultSchema = z.object({ plan: ma2AutoBindPlanSchema, directory: ma2ObjectDirectorySchema }).strict();
export type Ma2AutoBindPlan = z.infer<typeof ma2AutoBindPlanSchema>;
export type Ma2AutoBindRequest = z.infer<typeof ma2AutoBindRequestSchema>;
export type Ma2AutoBindResult = z.infer<typeof ma2AutoBindResultSchema>;

export const ma2SequenceAssignmentSchema = z.object({ sequence: z.number().int().min(1).max(99999), executor: z.string().regex(/^[1-9]\d*\.[1-9]\d*$/) }).strict();
