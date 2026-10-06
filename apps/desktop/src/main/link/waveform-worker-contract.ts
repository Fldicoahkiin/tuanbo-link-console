import { z } from 'zod';

export const waveformWorkerRequestSchema = z.object({ version: z.literal(1),
  executable: z.string().min(1).max(32767).refine(value => !value.includes('\0')),
  sourcePath: z.string().min(1).max(32767).refine(value => !value.includes('\0')),
  durationMs: z.number().finite().positive().max(86_400_000) }).strict();
export const waveformWorkerResultSchema = z.discriminatedUnion('ok', [
  z.object({ version: z.literal(1), ok: z.literal(true), peaks: z.array(z.number().finite().min(0).max(1)).min(1).max(500_000) }).strict(),
  z.object({ version: z.literal(1), ok: z.literal(false), error: z.string().min(1).max(8192) }).strict()
]);
