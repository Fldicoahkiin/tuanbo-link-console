import { z } from 'zod';
import { ma2LabelSchema } from './ma2-label';
const cueNumber = z.string().regex(/^\d{1,4}(?:\.\d{1,3})?$/).refine(value => Number(value) > 0);
export const ma2SongBindingSchema = z.object({
  endpoint: z.string().min(1), show: z.string().min(1), layout: z.number().int().min(1).max(9999).nullable(), executor: z.string().regex(/^[1-9]\d{0,3}\.[1-9]\d{0,2}$/).refine(value => Number(value.split('.')[1]) <= 240).optional(), sequence: z.number().int().min(1).max(99999),
  assignment: z.enum(['assigned', 'unassigned']).optional(),
  name: ma2LabelSchema, baselineXml: z.string().min(1).max(32 * 1024 * 1024),
  // atMs: the song-relative time the song's Timecode show fires this point, as last written.
  points: z.array(z.object({ id: z.string().min(1), cue: cueNumber, atMs: z.number().finite().nonnegative().optional() }).strict()).max(9999),
  // The program's own Timecode show for this song: offset in 30 FPS frames, revision of the show as last written.
  timecode: z.object({ number: z.number().int().min(1).max(99999), offset: z.number().int().min(0).max(2591999), slot: z.string().min(1).max(64), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional()
}).strict().refine(value => value.layout !== null || value.executor !== undefined, '歌曲序列必须保留控台页面位置');
export type Ma2SongBinding = z.infer<typeof ma2SongBindingSchema>;
