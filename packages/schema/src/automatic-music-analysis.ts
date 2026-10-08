import { z } from 'zod';

const seconds = z.number().finite().nonnegative();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const positions = z.array(seconds).max(1_000_000).superRefine((points, context) => {
  if (points.some((point, index) => index > 0 && point <= points[index - 1]!)) context.addIssue({ code: 'custom', message: '音乐拍点必须严格递增' });
});
const section = z.object({ start: seconds, end: seconds, label: z.string().min(1).max(100) }).strict().refine(value => value.end > value.start, '音乐段落终点必须晚于起点');
const musicEvent = z.object({ kind: z.enum(['hit', 'roll', 'build', 'drop', 'stop', 'ending', 'last']), start: seconds, end: seconds.nullable() }).strict().superRefine((event, context) => {
  if (event.end !== null && event.end <= event.start || ['roll', 'build', 'ending'].includes(event.kind) && event.end === null) context.addIssue({ code: 'custom', message: '音乐区间事件缺少有效终点' });
});
export const automaticMusicLabelsSchema = z.object({ beats: positions, downbeats: positions, sections: z.array(section).max(100_000), events: z.array(musicEvent).max(100_000) }).strict().superRefine((labels, context) => {
  if (labels.sections.some((value, index) => index > 0 && value.start < labels.sections[index - 1]!.end)) context.addIssue({ code: 'custom', message: '音乐段落不能重叠或倒序' });
});

/** Exact Python worker output. Research diagnostics cannot masquerade as approved markers. */
export const automaticMusicRunSchema = z.object({
  version: z.literal(1), run_id: z.string().uuid(), engine_fingerprint: sha256, device: z.enum(['cpu', 'cuda']),
  audio: z.object({ source_sha256: sha256, pcm_sha256: sha256, sample_rate: z.literal(48000), sample_count: z.number().int().positive().safe(), channels: z.literal(2) }).strict(),
  timings: z.object({ total_seconds: seconds, decode_seconds: seconds, engine_seconds: z.record(z.string().min(1).max(100), seconds), cached: z.boolean() }).strict(),
  diagnostics: z.object({ 'beat-this-final0': automaticMusicLabelsSchema, 'beat-this-final1': automaticMusicLabelsSchema, 'beat-this-final2': automaticMusicLabelsSchema, 'all-in-one': automaticMusicLabelsSchema, 'silence-guard': automaticMusicLabelsSchema }).partial().strict(),
  publication: z.literal('not-validated'), enabled_capabilities: z.array(z.never()).length(0)
}).strict().superRefine((run, context) => {
  const duration = run.audio.sample_count / run.audio.sample_rate;
  for (const labels of Object.values(run.diagnostics)) {
    if (!labels) continue;
    if ([...labels.beats, ...labels.downbeats, ...labels.sections.flatMap(value => [value.start, value.end]), ...labels.events.flatMap(value => [value.start, value.end ?? value.start])].some(value => value > duration)) context.addIssue({ code: 'custom', message: '识别结果超出实际音频范围' });
  }
  const keys = Object.keys(run.diagnostics);
  const silence = keys.length === 1 && keys[0] === 'silence-guard';
  const full = ['beat-this-final0', 'beat-this-final1', 'beat-this-final2', 'all-in-one'].every(key => keys.includes(key)) && !keys.includes('silence-guard');
  if (!silence && !full) context.addIssue({ code: 'custom', message: '自动音乐分析缺少完整模型阶段' });
});

const envelope = z.object({ version: z.literal(1), taskId: z.string().uuid() });
export const automaticMusicWorkerEventSchema = z.discriminatedUnion('type', [
  envelope.extend({ type: z.literal('progress'), stage: z.enum(['verify-assets', 'decode-48000-stereo', 'beat-this-final0', 'beat-this-final1', 'beat-this-final2', 'all-in-one-harmonix-all', 'cached-research-only', 'completed-research-only']) }).strict(),
  envelope.extend({ type: z.literal('result'), result: automaticMusicRunSchema }).strict(),
  envelope.extend({ type: z.literal('cancelled') }).strict(),
  envelope.extend({ type: z.literal('error'), message: z.string().min(1).max(16_384) }).strict()
]);
export type AutomaticMusicRun = z.infer<typeof automaticMusicRunSchema>;
export type AutomaticMusicWorkerEvent = z.infer<typeof automaticMusicWorkerEventSchema>;

export const automaticMusicCandidatesSchema = z.object({
  sourceSha256: sha256, durationMs: seconds, bpm: z.number().finite().positive().nullable(),
  items: z.array(z.object({ id: z.string().min(1), kind: z.enum(['beat', 'downbeat', 'section']), name: z.string().min(1),
    startMs: seconds, endMs: seconds.nullable() }).strict()).max(100_000)
}).strict().superRefine((value, context) => {
  if (new Set(value.items.map(item => item.id)).size !== value.items.length) context.addIssue({ code: 'custom', message: '分析候选编号重复' });
  for (const item of value.items) if (item.startMs > value.durationMs || item.endMs !== null && (item.endMs <= item.startMs || item.endMs > value.durationMs) || (item.kind === 'section') !== (item.endMs !== null)) context.addIssue({ code: 'custom', message: '分析候选范围无效' });
});
export type AutomaticMusicCandidates = z.infer<typeof automaticMusicCandidatesSchema>;

export const automaticMusicJobSchema = z.object({
  version: z.literal(1), taskId: z.string().uuid(), projectPath: z.string().min(1).max(32768), sourceSha256: sha256, revision: z.number().int().nonnegative(),
  state: z.enum(['queued', 'checking', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'completed', 'failed']),
  device: z.enum(['cpu', 'cuda']), message: z.string().max(16_384),
  stage: z.string().max(100).nullable(),
  candidates: automaticMusicCandidatesSchema.optional(),
  summary: z.object({ runId: z.string().uuid(), durationMs: seconds, elapsedSeconds: seconds, cached: z.boolean(),
    publication: z.literal('not-validated'), visibleResults: z.number().int().nonnegative() }).strict().nullable()
}).strict();
export type AutomaticMusicJob = z.infer<typeof automaticMusicJobSchema>;
export const automaticMusicStatusSchema = z.object({
  version: z.literal(1), available: z.boolean(), device: z.enum(['cpu', 'cuda']),
  devices: z.array(z.enum(['cpu', 'cuda'])).min(1).max(2),
  reason: z.string().max(16_384), publication: z.literal('not-validated'), jobs: z.array(automaticMusicJobSchema).max(200)
}).strict().refine(value => value.devices.includes(value.device) && new Set(value.devices).size === value.devices.length, '默认设备必须属于已安装设备，且设备不能重复');
export type AutomaticMusicStatus = z.infer<typeof automaticMusicStatusSchema>;
export const automaticMusicControlSchema = z.object({ version: z.literal(1), taskId: z.string().uuid(), action: z.enum(['cancel', 'resume']) }).strict();
