import { z } from 'zod';
import { ma2PlaybackRequestSchema, ma2PlaybackActionSchema, ma2NetworkTargetSchema } from './ma2-bridge';
export const ma2AuditionRequestSchema=ma2PlaybackRequestSchema.extend({version:z.literal(1),generation:z.number().int().nonnegative()}).strict();
export const ma2AuditionControlSchema=z.discriminatedUnion('action',[
  z.object({version:z.literal(1),action:z.literal('status')}).strict(),
  z.object({version:z.literal(1),action:z.literal('stop')}).strict(),
  z.object({version:z.literal(1),action:z.literal('acknowledge-closed'),targetId:z.string().min(1).max(2048)}).strict()
]);
export const ma2AuditionStateSchema=z.object({version:z.literal(1),revision:z.number().int().nonnegative(),generation:z.number().int().nonnegative(),phase:z.enum(['idle','active','stopping','sent','failed']),targets:z.array(z.object({id:z.string(),network:ma2NetworkTargetSchema,action:ma2PlaybackActionSchema,state:z.enum(['pending','sent','unknown','failed']),error:z.string().nullable(),connectionChanged:z.boolean().optional()}).strict())}).strict();
export type Ma2AuditionRequest=z.infer<typeof ma2AuditionRequestSchema>;
export type Ma2AuditionState=z.infer<typeof ma2AuditionStateSchema>;
export type Ma2AuditionControl=z.infer<typeof ma2AuditionControlSchema>;
