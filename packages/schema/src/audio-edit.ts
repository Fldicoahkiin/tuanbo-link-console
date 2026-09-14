import { z } from 'zod';

const milliseconds = z.number().int().min(0).max(86_400_000);
export const audioSegmentSchema = z.object({
  id: z.string().min(1), startMs: milliseconds, sourceOffsetMs: milliseconds,
  durationMs: z.number().int().positive().max(86_400_000)
}).strict();
export const audioBeatLevelSchema = z.enum(['sparse', 'standard', 'dense']);
export const audioBeatAnalysisSchema = z.object({
  sparse: z.array(milliseconds).max(100_000), standard: z.array(milliseconds).max(100_000), dense: z.array(milliseconds).max(100_000)
}).strict();
export const audioBeatMapSchema = z.object({
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  level: audioBeatLevelSchema,
  levels: audioBeatAnalysisSchema.optional(),
  pointsMs: z.array(milliseconds).max(100_000)
}).strict().superRefine((value, ctx) => {
  if (value.pointsMs.some((time, index) => index > 0 && time <= value.pointsMs[index - 1]!)) ctx.addIssue({ code: 'custom', message: '节拍点必须按时间递增且不能重复' });
});
export type AudioSegment = z.infer<typeof audioSegmentSchema>;
export type AudioBeatLevel = z.infer<typeof audioBeatLevelSchema>;
export type AudioBeatAnalysis = z.infer<typeof audioBeatAnalysisSchema>;
