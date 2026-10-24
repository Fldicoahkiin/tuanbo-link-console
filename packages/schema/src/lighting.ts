import { ma2SongBindingSchema } from './ma2-song-binding';
import { z } from 'zod';
import { lightingMusicSchema, musicMarkerKinds } from './lighting-music';
import { musicStructureSchema } from './music-structure';

const id = z.string().min(1);
const time = z.number().finite().nonnegative();
const dataByte = z.number().int().min(0).max(127);
const eventBase = { id, at: time, effectGroupId: id.optional(), librarySource: z.object({ id, revision: z.number().int().positive() }).strict().optional(), beatAnchor: time.optional() };
export const lightingPreparationSchema = z.object({
  cue: z.string().regex(/^\d{1,4}(?:\.\d{1,3})?$/).refine(value => Number(value) > 0, '准备 Cue 编号必须大于 0'),
  leadMs: z.number().finite().min(100).max(10000)
}).strict();
export const lightingEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...eventBase, kind: z.literal('empty-cue'), label: z.string(), runMode: z.enum(['independent', 'follow']).optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('raw'), bytes: z.array(z.number().int().min(0).max(255)).min(1).max(65536).refine((bytes) => {
    const status = bytes[0] ?? 0;
    if (status === 0xf0) return bytes.length >= 3 && bytes.at(-1) === 0xf7 && bytes.slice(1, -1).every((byte) => byte < 128);
    // Notes use the note model so the scheduler can always release them.
    const type = status & 0xf0;
    return [0xa0, 0xb0, 0xc0, 0xd0, 0xe0].includes(type) && bytes.length === ([0xc0, 0xd0].includes(type) ? 2 : 3) && bytes.slice(1).every((byte) => byte < 128);
  }, '原始 MIDI 必须是完整的控制或 SysEx 消息；音符请使用音符事件'), label: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('note'), note: dataByte, velocity: dataByte.min(1), releaseVelocity: dataByte.optional(), duration: time.positive() }).strict(),
  z.object({ ...eventBase, kind: z.literal('cc'), controller: dataByte, value: dataByte }).strict(),
  z.object({ ...eventBase, kind: z.literal('program'), program: dataByte }).strict(),
  z.object({ ...eventBase, kind: z.literal('ma2'), runMode: z.enum(['independent', 'follow']).optional(), cue: z.string().regex(/^\d+(?:\.\d+)?$/).optional(), label: z.string(), action: z.enum(['go', 'goto', 'off']), executor: z.union([z.literal(''), z.string().regex(/^\d+\.\d+$/)]), sequence: z.number().int().positive().optional(), preparation: lightingPreparationSchema.optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('ma2-fader'), executor: z.string().regex(/^[1-9]\d*\.[1-9]\d*$/), fader: z.literal('Master'), level: z.number().finite().min(0).max(1), label: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('point'), value: z.number().finite().min(0).max(127), shape: z.enum(['hold', 'linear', 'smooth']), controlValues: z.tuple([z.number().finite().min(0).max(127), z.number().finite().min(0).max(127)]).optional() }).strict()
]).superRefine((event, ctx) => {
  if (event.kind === 'ma2' && event.preparation && (event.action !== 'goto' || Number(event.preparation.cue) === Number(event.cue))) ctx.addIssue({ code: 'custom', message: '埋步需要指定与正式 Cue 不同的准备 Cue' });
  if (event.kind === 'ma2' && !event.executor && event.action !== 'goto') ctx.addIssue({ code: 'custom', message: '序列池调用需要指定序列和 Cue；下一步或关闭需要执行器' });
  if (event.kind === 'ma2' && event.action === 'goto' && (event.cue === undefined || event.sequence === undefined)) ctx.addIssue({ code: 'custom', message: '调用指定 Cue 必须填写 Cue 编号和序列' });
});
export const lightingClipSchema = z.object({
  id, name: z.string().min(1), start: time, duration: time.positive(),
  timeLock: z.enum(['time', 'beat']), events: z.array(lightingEventSchema), muted: z.boolean()
}).strict().superRefine((clip, ctx) => {
  const ids = new Set<string>();
  for (const [index, event] of clip.events.entries()) {
    if (ids.has(event.id)) ctx.addIssue({ code: 'custom', message: '灯光事件 ID 重复', path: ['events', index] });
    ids.add(event.id);
    if ((event.kind === 'point' ? event.at > clip.duration : event.at >= clip.duration) || (event.kind === 'note' && event.at + event.duration > clip.duration + 1e-8)) {
      ctx.addIssue({ code: 'custom', message: '灯光事件超出片段范围', path: ['events', index] });
    }
  }
});
export const lightingTrackSchema = z.object({
  id, name: z.string().min(1), kind: z.enum(['ma2', 'midi', 'automation']), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  group: z.string(), muted: z.boolean(), solo: z.boolean(), locked: z.boolean(),
  channel: z.number().int().min(1).max(16), portProfileId: z.string(), controller: dataByte,
  noteNames: z.record(z.string().regex(/^(?:\d|[1-9]\d|1[01]\d|12[0-7])$/), z.string()),
  cueStamp: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('sequence') }).strict(),
    z.object({ mode: z.literal('marker') }).strict(),
    z.object({ mode: z.literal('fixed'), sequence: z.number().int().min(1).max(99999), cue: z.string().regex(/^\d{1,4}(?:\.\d{1,3})?$/, 'Cue 编号须为 1–9999，最多 3 位小数').refine((value) => Number(value) > 0, 'Cue 编号须大于 0'), executor: z.union([z.literal(''), z.string().regex(/^[1-9]\d*\.[1-9]\d*$/)]) }).strict()
  ]).optional(),
  clips: z.array(lightingClipSchema)
}).strict();
/** Library and timeline references both support unassigned Sequence Pool cues. */
export const lightingTemplateTrackSchema = lightingTrackSchema;
export const lightingTempoSchema = z.object({ beat: time, bpm: z.number().finite().min(10).max(999), numerator: z.number().int().min(1).max(32), denominator: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16)]), transition: z.enum(['hold', 'linear']).optional() }).strict();
export const lightingMa2EventMappingSchema = z.object({ eventId: id, trackId: id, clipId: id, path: z.string().min(1), sequence: z.number().int().positive().nullable(), cueIndex: z.number().int().nonnegative().nullable(), action: z.enum(['goto', 'go', 'off', 'master']).optional(), executor: z.string().regex(/^\d+\.\d+$/) }).strict().superRefine((mapping, ctx) => {
  const cueAction = (mapping.action ?? 'goto') === 'goto';
  if (cueAction ? mapping.sequence === null || mapping.cueIndex === null : mapping.sequence !== null || mapping.cueIndex !== null) ctx.addIssue({ code: 'custom', message: 'MA2 动作与 Cue 引用映射不一致' });
});
export const lightingMa2TrackMappingSchema = z.object({
  trackId: id, path: z.string().min(1), executor: z.string().regex(/^[1-9]\d*\.[1-9]\d*$/),
  subtracks: z.array(z.string().min(1))
}).strict();
export const lightingMa2CueCatalogSchema = z.array(z.object({
  sequence: z.number().int().min(1).max(99999), name: z.string().nullable(),
  cues: z.array(z.object({ index: z.number().int().nonnegative(), number: z.string().regex(/^\d{1,4}\.\d{3}$/, 'Cue 编号须为 1–9999，带 3 位小数').refine((value) => Number(value) > 0, 'Cue 编号须大于 0'), name: z.string().nullable() }).strict())
}).strict()).superRefine((catalog, ctx) => {
  if (new Set(catalog.map((entry) => entry.sequence)).size !== catalog.length) ctx.addIssue({ code: 'custom', message: 'MA2 Cue 列表的序列重复' });
  for (const entry of catalog) if (new Set(entry.cues.map((cue) => cue.index)).size !== entry.cues.length || new Set(entry.cues.map((cue) => Number(cue.number))).size !== entry.cues.length) ctx.addIssue({ code: 'custom', message: 'MA2 Cue 列表的编号或索引重复' });
});
export const lightingMa2BindingSchema = z.object({
  nativeEvents: z.array(z.object({ path: z.string(), reason: z.string() }).strict()).optional(),
  playback: z.enum(['native-timecode', 'editable']).optional(),
  timeOriginMs: z.number().int().min(0).max(86399999).optional(),
  id, timecode: z.number().int().min(1).max(99999), name: z.string(), readAt: z.string().datetime(),
  sourceXml: z.string().min(1).max(32 * 1024 * 1024),
  baselineTracks: z.array(lightingTrackSchema), mappings: z.array(lightingMa2EventMappingSchema),
  trackMappings: z.array(lightingMa2TrackMappingSchema).optional(),
  pendingTracks: z.array(z.object({ trackId: id, executor: z.string().regex(/^[1-9]\d{0,4}\.[1-9]\d{0,4}$/), executorName: z.string().min(1).max(512).regex(/^[^\u0000-\u001f]+$/), sequence: z.number().int().min(1).max(99999).optional() }).strict()).optional(),
  cueCatalog: lightingMa2CueCatalogSchema.optional()
}).strict();
export const lightingDocumentSchema = z.object({
  consoleSong: ma2SongBindingSchema.optional(),
  musicAnalysis: musicStructureSchema.optional(),
  ma2Library: z.object({ show: z.string(), readAt: z.string().datetime(), sequences: lightingMa2CueCatalogSchema }).strict().optional(),
  autoCueSource: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), durationMs: z.number().finite().positive() }).strict().optional(),
  fixtureCategories: z.array(z.object({ show: z.string().min(1), category: z.string().min(1).max(64), fixtureIds: z.array(z.number().int().positive()).max(10000) }).strict()).max(128).optional(),
  ma2Bindings: z.array(lightingMa2BindingSchema).optional(),
  laneIndex: z.number().int().min(0).optional(),
  version: z.union([z.literal(1), z.literal(2)]), music: lightingMusicSchema.optional(), tracks: z.array(lightingTrackSchema), tempos: z.array(lightingTempoSchema).min(1),
  markers: z.array(z.object({ id, name: z.string(), startMs: time, endMs: time.nullable(), kind: z.enum(musicMarkerKinds).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), notes: z.string().optional() }).strict()),
  loop: z.object({ enabled: z.boolean(), startMs: time, endMs: time.positive() }).strict(),
  outputMode: z.enum(['timecode', 'direct', 'network']),
  templates: z.array(z.object({ id, name: z.string().min(1), track: lightingTemplateTrackSchema,
    libraryRevision: z.number().int().positive().optional(), nativeSequence: z.boolean().optional(),
    categories: z.array(z.string().min(1).max(64)).max(16).optional(),
    sourceShow: z.string().min(1).max(4096).optional(),
    favorite: z.boolean().optional(),
    members: z.array(z.object({ name: z.string().min(1), sequence: z.number().int().min(1).max(99999), cue: z.string().regex(/^\d{1,4}(?:\.\d{1,3})?$/), executor: z.union([z.literal(''), z.string().regex(/^[1-9]\d*\.[1-9]\d*$/)]), delayMs: time }).strict()).min(2).max(32).optional()
  }).strict())
}).strict().superRefine((document, ctx) => {
  if (document.version === 1 && (document.musicAnalysis || document.music || document.markers.some(marker => marker.kind || marker.color || marker.notes) || document.tracks.some(track => track.clips.some(clip => clip.events.some(event => event.librarySource || event.beatAnchor !== undefined))))) ctx.addIssue({ code: 'custom', message: '新版音乐结构和素材引用必须使用灯光格式 2' });
  if (document.tempos[0]?.beat !== 0) ctx.addIssue({ code: 'custom', message: '节拍图必须从第 0 拍开始', path: ['tempos'] });
  document.tempos.forEach((tempo, index) => {
    if (index && tempo.beat <= (document.tempos[index - 1]?.beat ?? 0)) ctx.addIssue({ code: 'custom', message: '变速点必须按节拍递增', path: ['tempos', index] });
  });
  if (document.loop.endMs <= document.loop.startMs) ctx.addIssue({ code: 'custom', message: '循环终点必须大于起点', path: ['loop'] });
  const ids = new Set<string>();
  for (const value of [...document.tracks, ...document.tracks.flatMap((track) => track.clips), ...document.markers, ...document.templates, ...document.ma2Bindings ?? []]) {
    if (ids.has(value.id)) ctx.addIssue({ code: 'custom', message: '灯光对象 ID 重复' });
    ids.add(value.id);
  }
  const boundTracks = new Set<string>();
  for (const binding of document.ma2Bindings ?? []) {
    for (const trackId of [...binding.baselineTracks.map((track) => track.id), ...(binding.pendingTracks ?? []).map((track) => track.trackId)]) {
      if (boundTracks.has(trackId)) ctx.addIssue({ code: 'custom', message: 'MA2 轨道绑定重复' });
      boundTracks.add(trackId);
    }
    if (binding.trackMappings) {
      const trackIds = new Set(binding.trackMappings.map((entry) => entry.trackId));
      const trackPaths = new Set(binding.trackMappings.map((entry) => entry.path));
      if (trackIds.size !== binding.trackMappings.length || trackPaths.size !== trackIds.size || trackIds.size !== binding.baselineTracks.length || binding.baselineTracks.some((track) => !trackIds.has(track.id))) ctx.addIssue({ code: 'custom', message: 'MA2 基线轨道映射缺失或重复' });
    }
    const mapped = new Set<string>(); const paths = new Set<string>();
    for (const mapping of binding.mappings) {
      const clip = binding.baselineTracks.find((track) => track.id === mapping.trackId)?.clips.find((entry) => entry.id === mapping.clipId);
      if (!clip?.events.some((event) => event.id === mapping.eventId) || mapped.has(mapping.eventId) || paths.has(mapping.path)) ctx.addIssue({ code: 'custom', message: 'MA2 基线事件映射无效或重复' });
      mapped.add(mapping.eventId); paths.add(mapping.path);
    }
  }
  for (const marker of document.markers) if (marker.endMs !== null && marker.endMs <= marker.startMs) ctx.addIssue({ code: 'custom', message: '标记区域终点必须大于起点' });
});
export type LightingEvent = z.infer<typeof lightingEventSchema>;
export type LightingClip = z.infer<typeof lightingClipSchema>;
export type LightingTrack = z.infer<typeof lightingTrackSchema>;
export type LightingTempo = z.infer<typeof lightingTempoSchema>;
export type LightingDocument = z.infer<typeof lightingDocumentSchema>;
export function createLightingDocument(): LightingDocument {
  return { version: 1, tracks: [], tempos: [{ beat: 0, bpm: 128, numerator: 4, denominator: 4 }], markers: [], loop: { enabled: false, startMs: 0, endMs: 10000 }, outputMode: 'timecode', templates: [] };
}
