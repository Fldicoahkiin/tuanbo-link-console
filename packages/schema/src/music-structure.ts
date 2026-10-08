import { z } from 'zod';

const time = z.number().finite().nonnegative();
const bpm = z.number().finite().positive().nullable();
export const musicStructureSegmentSchema = z.object({
  id: z.string().min(1), name: z.string().trim().min(1).max(100), startMs: time, endMs: time,
  bpm, endBpm: bpm, reason: z.enum(['structure', 'tempo', 'both', 'whole']), edited: z.boolean()
}).strict();
/** Independent, source-bound annotations. Never used as the lighting tempo map. */
export const musicStructureSchema = z.object({
  version: z.literal(1), algorithm: z.literal('music-structure-1'), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  durationMs: time.positive(), taskId: z.string().min(1), state: z.enum(['ready', 'cleared']),
  bpm, beatsPerBar: z.number().int().min(2).max(12).nullable(),
  beats: z.array(z.object({ id: z.string().min(1), atMs: time, strong: z.boolean() }).strict()).max(100000),
  segments: z.array(musicStructureSegmentSchema).max(10000),
  removedBeatMs: z.array(time).max(100000),
  removedRanges: z.array(z.object({ startMs: time, endMs: time }).strict()).max(10000)
}).strict().superRefine((value, ctx) => {
  const invalid = value.beats.some((beat, i) => beat.atMs >= value.durationMs || i > 0 && beat.atMs <= value.beats[i - 1]!.atMs)
    || new Set(value.beats.map(beat => beat.id)).size !== value.beats.length
    || new Set(value.segments.map(segment => segment.id)).size !== value.segments.length
    || value.segments.some((segment, i) => segment.endMs <= segment.startMs || segment.endMs > value.durationMs || i > 0 && segment.startMs < value.segments[i - 1]!.endMs)
    || value.removedRanges.some(range => range.endMs <= range.startMs || range.endMs > value.durationMs);
  if (invalid) ctx.addIssue({ code: 'custom', message: '音乐识别位置重复、重叠或超出音源范围' });
});
export type MusicStructure = z.infer<typeof musicStructureSchema>;
export type MusicStructureSegment = z.infer<typeof musicStructureSegmentSchema>;
