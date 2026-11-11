import { z } from 'zod';
export const musicAnalysisControlSchema = z.object({ version: z.literal(1), taskId: z.string().uuid() }).strict();
export const musicAnalysisResultSchema = z.object({ version: z.literal(1), taskId: z.string().uuid(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), durationMs: z.number().finite().positive(), bpm: z.number().finite().min(10).max(999).nullable(),
  candidates: z.array(z.object({ id: z.string(), kind: z.enum(['hit', 'roll', 'silence']), startMs: z.number().finite().nonnegative(), endMs: z.number().finite().nonnegative().nullable(), strength: z.number().finite().min(0).max(1) }).strict()).max(100000)
}).strict();
export const musicAnalysisProgressSchema = z.object({ version: z.literal(1), taskId: z.string().uuid(), phase: z.enum(['checking', 'decoding', 'analyzing', 'complete', 'cancelled', 'failed']), progress: z.number().finite().min(0).max(1), message: z.string() }).strict();
export type MusicAnalysisResult = z.infer<typeof musicAnalysisResultSchema>;
export type MusicAnalysisProgress = z.infer<typeof musicAnalysisProgressSchema>;
