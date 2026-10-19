import { z } from 'zod';
import { ma2ExecutorPageRequestSchema } from './ma2-executor-page';

const button = z.object({ id: z.number().int().min(0).max(2), name: z.string().max(128), active: z.boolean() }).strict();
const fader = z.object({ value: z.number().finite(), min: z.number().finite(), max: z.number().finite(), name: z.string().max(128), text: z.string().max(128) }).strict();
export const ma2LiveRequestSchema = ma2ExecutorPageRequestSchema.extend({ start: z.number().int().min(1).max(76).refine(value => (value - 1) % 15 === 0) }).strict();
export const ma2LiveConnectSchema = ma2LiveRequestSchema.extend({
  username: z.string().trim().min(1).max(256), password: z.string().max(256)
}).strict();
export const ma2LiveSnapshotSchema = z.object({
  page: z.number().int().min(1).max(9999), start: z.number().int().min(1).max(76), readAt: z.number().finite(),
  items: z.array(z.object({
    slot: z.number().int().min(1).max(90), width: z.number().int().min(1).max(5), name: z.string().max(512),
    objectType: z.string().max(128), objectNumber: z.string().max(128), running: z.boolean(), cue: z.string().max(1024),
    blocks: z.array(z.object({ slot: z.number().int().min(1).max(90), fader: fader.nullable(), buttons: z.array(button).max(3) }).strict()).max(5)
  }).strict()).max(15)
}).strict();
export const ma2LiveInputSchema = ma2LiveRequestSchema.extend({
  slot: z.number().int().min(1).max(90), deadlineAt: z.number().finite().positive(),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fader'), value: z.number().finite() }).strict(),
    z.object({ kind: z.literal('button'), id: z.number().int().min(0).max(2), pressed: z.boolean() }).strict()
  ])
}).strict().refine(value => value.slot >= value.start && value.slot < value.start + 15, '执行器不在当前推杆范围内');
export type Ma2LiveRequest = z.infer<typeof ma2LiveRequestSchema>;
export type Ma2LiveConnect = z.infer<typeof ma2LiveConnectSchema>;
export type Ma2LiveSnapshot = z.infer<typeof ma2LiveSnapshotSchema>;
export type Ma2LiveInput = z.infer<typeof ma2LiveInputSchema>;
