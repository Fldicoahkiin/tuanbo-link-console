import { z } from 'zod';
import { ma2LabelSchema } from './ma2-label';
const cueNumber = z.string().regex(/^\d{1,4}(?:\.\d{1,3})?$/, 'Cue 编号须为 1–9999，最多 3 位小数').refine(value => Number(value) > 0, 'Cue 编号须大于 0');
export const MA2_PLAIN_SEQUENCE_BYTES = 32 * 1024 * 1024;
export const MA2_MAX_SEQUENCE_BYTES = 256 * 1024 * 1024;
export const MA2_GZIP_PREFIX = 'gzip:';
/** gzip:<UTF-8 byte length>:<SHA-256 of those bytes>:<base64 gzip member>. */
export function packedMa2SequenceHeader(value: string): { bytes: number; sha256: string; offset: number } | null {
  if (!value.startsWith(MA2_GZIP_PREFIX)) return null;
  const match = /^gzip:([1-9]\d{0,8}):([a-f0-9]{64}):/.exec(value.slice(0, 81));
  if (!match) return null;
  const bytes = Number(match[1]), offset = match[0].length;
  // Gzip can expand incompressible input slightly. Bound the encoded payload by
  // the declared uncompressed size before allocating or decoding it.
  const encodedLimit = 4 * Math.ceil((bytes + Math.ceil(bytes / 100) + 64) / 3);
  if (bytes > MA2_MAX_SEQUENCE_BYTES || value.length <= offset || value.length - offset > encodedLimit || (value.length - offset) % 4 !== 0) return null;
  return { bytes, sha256: match[2]!, offset };
}
export const ma2SequenceSnapshotSchema = z.string().min(1).refine(value => value.startsWith(MA2_GZIP_PREFIX)
  ? packedMa2SequenceHeader(value) !== null
  : value.length <= MA2_PLAIN_SEQUENCE_BYTES, '歌曲序列的灯光数据格式或长度无效');
export const ma2SongBindingSchema = z.object({
  endpoint: z.string().min(1), show: z.string().min(1), layout: z.number().int().min(1).max(9999).nullable(), executor: z.string().regex(/^[1-9]\d{0,3}\.[1-9]\d{0,2}$/, '执行器位置须为“页.格”，例如 1000.101').refine(value => Number(value.split('.')[1]) <= 240, '执行器格位须在 1–240').optional(), sequence: z.number().int().min(1).max(99999),
  preservedSourceCues: z.array(cueNumber).max(99999).optional(),
  assignment: z.enum(['assigned', 'unassigned']).optional(),
  name: ma2LabelSchema, baselineXml: ma2SequenceSnapshotSchema,
  // atMs: the song-relative time the song's Timecode show fires this point, as last written.
  points: z.array(z.object({ id: z.string().min(1), cue: cueNumber, atMs: z.number().finite().nonnegative().optional(), enabled: z.boolean().optional() }).strict()).max(9999),
  // The program's own Timecode show for this song: offset in 30 FPS frames, revision of the show as last written.
  timecode: z.object({ number: z.number().int().min(1).max(99999), offset: z.number().int().min(0).max(2591999), slot: z.string().min(1).max(64), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional()
}).strict().refine(value => value.layout !== null || value.executor !== undefined, '歌曲序列必须保留控台页面位置');
export type Ma2SongBinding = z.infer<typeof ma2SongBindingSchema>;

/** Explicit destination reserved by the operator before the first Cue is synced. */
export const ma2TimelineDestinationSchema = z.object({
  name: ma2LabelSchema,
  timecode: z.number().int().min(1).max(99999),
  sequence: z.number().int().min(1).max(99999),
  executor: z.string().regex(/^[1-9]\d{0,3}\.[1-9]\d{0,2}$/).refine(value => Number(value.split('.')[1]) <= 240, '执行器格位须在 1–240')
}).strict();
export type Ma2TimelineDestination = z.infer<typeof ma2TimelineDestinationSchema>;
