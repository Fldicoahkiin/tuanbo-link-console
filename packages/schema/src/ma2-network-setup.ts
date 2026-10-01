import { z } from 'zod';

export const ma2NetworkAdapterSchema = z.object({
  id: z.string().uuid(), index: z.number().int().positive(), name: z.string(), description: z.string(),
  connected: z.boolean(), physical: z.boolean(), wired: z.boolean(),
  addresses: z.array(z.object({ address: z.ipv4(), prefix: z.number().int().min(0).max(32) }).strict())
}).strict();
export const ma2NetworkSetupRequestSchema = z.object({
  host: z.ipv4(), adapterId: z.string().uuid().optional(), address: z.ipv4().optional(), prefix: z.number().int().min(8).max(30).default(24)
}).strict();
export const ma2NetworkSetupPlanSchema = z.object({
  id: z.string().uuid(), adapter: ma2NetworkAdapterSchema, host: z.ipv4(), address: z.ipv4(), prefix: z.number().int().min(8).max(30),
  needsChange: z.boolean(), message: z.string()
}).strict();
export const ma2NetworkSetupStateSchema = z.object({
  adapters: z.array(ma2NetworkAdapterSchema),
  additions: z.array(z.object({ id: z.string().uuid(), adapterId: z.string().uuid(), adapterName: z.string(), address: z.ipv4(), prefix: z.number().int().min(8).max(30) }).strict())
}).strict();
export type Ma2NetworkAdapter = z.infer<typeof ma2NetworkAdapterSchema>;
export type Ma2NetworkSetupRequest = z.infer<typeof ma2NetworkSetupRequestSchema>;
export type Ma2NetworkSetupPlan = z.infer<typeof ma2NetworkSetupPlanSchema>;
export type Ma2NetworkSetupState = z.infer<typeof ma2NetworkSetupStateSchema>;
