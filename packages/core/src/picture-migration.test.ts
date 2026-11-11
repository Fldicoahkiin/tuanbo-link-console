import { describe, expect, it } from 'vitest';
import { DEFAULT_REFERENCE_CANVAS_TRANSFORM, createEmptyLinkProject, parseLinkProject, type LinkCue, type LinkProject, type MtcFrameRate, type ReferenceMediaClip, type RundownItem } from '@tb/schema';
import { compileManagedMediaTimeline, type ManagedMediaEvent } from './managed-media-timeline';
import { impliedSceneEnds, isCameraCue } from './content-timeline';
import { frameNumberToTimecode, playbackFramesPerSecond, timecodeToFrameNumber } from './mtc-timecode';
import { findVisualObsShowAction, isTimelineSpanActive, resolveTimelineClipSpan, resolveTimelineCueSpan, TimelineStateIndex, type ResolvedTimelineClip, type ResolvedTimelineObsCue } from './timeline-state';
import { SceneOutputTimeline, type FrameRange, type ScenePicture } from './scene-output-timeline';
import { audioContainsMediaSource } from './audio-edit';
import type { RuntimeUpdate } from './cue-runtime';

/**
 * Migration check for R1 (design 01 §6): the one picture function gives, frame by frame,
 * what the two old implementations gave. `Legacy*` below are the old code, copied as it
 * was before R1. Deleted with the old code once the new one is proven.
 */

type SceneWork = { media: ManagedMediaEvent[]; cues: RuntimeUpdate['dueCues'] };
type LegacyIndex = {
  projectId: string; itemId: string; layers: ReadonlyMap<string, number>;
  scenes: { cue: LinkCue; start: number; end: number }[];
  media: { event: ManagedMediaEvent; end: number }[];
  byEnd: LegacyIndex['scenes'];
  ends: number[];
};
type StackEntry = { key: string; layer: number; start: number } & ({ cue: LinkCue } | { media: ManagedMediaEvent });
const isSound = (entry: StackEntry): boolean => 'media' in entry && entry.media.assetKind === 'audio';

class LegacySceneOutput {
  readonly index: LegacyIndex;
  private readonly fps: number;
  constructor(project: LinkProject, itemId: string) {
    const events = compileManagedMediaTimeline(project, itemId).events;
    this.fps = playbackFramesPerSecond(project.timebase.frameRate);
    const item = project.rundown.find(entry => entry.id === itemId)!;
    const layers = new Map(item.visualLayers.map((layer, order) => [layer.id, order]));
    const visible = new Set(item.visualLayers.filter(layer => layer.visible).map(layer => layer.id));
    const implied = impliedSceneEnds(project, item);
    const scenes = item.cues.filter(cue => cue.enabled && (!cue.layerId || visible.has(cue.layerId)) && isCameraCue(cue))
      .map(cue => ({ cue, start: timecodeToFrameNumber(cue.timecode, project.timebase.frameRate),
        end: implied.get(cue.id) ?? resolveTimelineCueSpan(cue, project.timebase.frameRate).endFrame }))
      .sort((a, b) => a.start - b.start);
    const stops = new Map(events.filter(event => event.phase === 'stop').map(event => [event.clipId, event.frameNumber]));
    const media = events.filter(event => event.phase === 'start').map(event => ({ event, end: stops.get(event.clipId) ?? -1 }));
    const order = (cue: LinkCue): number => cue.layerId ? layers.get(cue.layerId) ?? -1 : -1;
    this.index = { projectId: project.projectId, itemId, layers, scenes, media,
      byEnd: [...scenes].sort((a, b) => a.end - b.end || order(b.cue) - order(a.cue) || a.start - b.start),
      ends: scenes.map(scene => scene.end).sort((a, b) => a - b) };
  }
  at(frame: number): SceneWork { return legacyOutputAt(this.index, frame); }
  picture(frame: number): ScenePicture {
    const { stack, fallback } = legacyStackAt(this.index, frame);
    const camera = stack.find(entry => 'cue' in entry);
    return { camera: camera && 'cue' in camera ? camera.cue : stack.some(entry => !isSound(entry)) ? null : fallback?.cue ?? null,
      clipIds: stack.flatMap(entry => 'media' in entry ? [entry.media.clipId] : []) };
  }
  airtime(): Map<string, FrameRange[]> {
    const { media, scenes } = this.index;
    const result = new Map<string, FrameRange[]>([...media.map(entry => `media:${entry.event.clipId}`),
      ...scenes.map(entry => `cue:${entry.cue.id}`)].map(key => [key, []]));
    const boundaries = [...new Set([...media.flatMap(entry => [entry.event.frameNumber, entry.end]),
      ...scenes.flatMap(entry => [entry.start, entry.end])])].sort((a, b) => a - b);
    for (const [order, start] of boundaries.entries()) {
      const end = boundaries[order + 1];
      if (end === undefined) break;
      for (const entry of legacyStackAt(this.index, start).stack) {
        const ranges = result.get(entry.key)!;
        const last = ranges.at(-1);
        if (last?.end === start) last.end = end;
        else ranges.push({ start, end });
      }
    }
    return result;
  }
  preloadEntries(): ManagedMediaEvent[] {
    const boundaries = [...new Set([0, ...this.index.media.flatMap(entry => [entry.event.frameNumber, entry.end]),
      ...this.index.scenes.flatMap(entry => [entry.start, entry.end])])].filter(frame => frame >= 0).sort((a, b) => a - b);
    const entries: ManagedMediaEvent[] = []; let previous = new Set<string>();
    for (const frame of boundaries) {
      const visible = this.at(frame).media;
      for (const event of visible) if (event.assetKind !== 'image' && !previous.has(event.clipId)) entries.push({ ...event, frameNumber: frame,
        sourceOffsetMs: event.sourceOffsetMs + Math.round((frame - event.frameNumber) * 1000 / this.fps) });
      previous = new Set(visible.map(event => event.clipId));
    }
    return entries;
  }
}

function legacyStackAt(index: LegacyIndex, frame: number): { stack: StackEntry[]; fallback: StackEntry & { cue: LinkCue } | undefined } {
  const layerOrder = (id?: string): number => id ? index.layers.get(id) ?? -1 : -1;
  // The old index answered by interval; a linear scan gives the same members.
  const candidates: StackEntry[] = [
    ...index.scenes.filter(scene => scene.start <= frame && scene.end > frame).map(({ cue, start }) => ({ key: `cue:${cue.id}`, layer: layerOrder(cue.layerId), start, cue })),
    ...index.media.filter(entry => entry.event.frameNumber <= frame && entry.end > frame).map(({ event: media }) => ({ key: `media:${media.clipId}`, layer: layerOrder(media.layerId), start: media.frameNumber, media }))
  ].sort((a, b) => a.layer - b.layer || b.start - a.start || a.key.localeCompare(b.key));
  const cameraIndex = candidates.findIndex(candidate => 'cue' in candidate);
  const stack = candidates.filter((candidate, order) => cameraIndex < 0 || order <= cameraIndex || isSound(candidate));
  const last = index.byEnd[index.ends.filter(end => end <= frame).length - 1];
  return { stack, fallback: last && { key: `cue:${last.cue.id}`, layer: layerOrder(last.cue.layerId), start: last.start, cue: last.cue } };
}

function legacyOutputAt(index: LegacyIndex, frame: number): SceneWork {
  const { itemId } = index;
  const { stack: playing, fallback } = legacyStackAt(index, frame);
  const stack = playing.some(entry => !isSound(entry)) || !fallback ? playing
    : [...playing, fallback].sort((a, b) => a.layer - b.layer || b.start - a.start || a.key.localeCompare(b.key));
  const target = stack[0];
  const layers = stack.flatMap(candidate => 'media' in candidate
    ? [candidate.media.sceneName]
    : candidate.cue.actions.flatMap(action => action.kind === 'obs.setProgramScene' ? [action.sceneName] : []));
  if (layers.length > 1) {
    const sceneName = `团播联动台·叠加·${index.projectId}`;
    return {
      media: stack.flatMap(candidate => 'media' in candidate ? [{ ...candidate.media, deferSceneSwitch: true }] : []),
      cues: [{ scheduledFrame: frame, executionId: 'x', cue: {
        id: `timeline-composition:${itemId}`, name: '更新时间线叠加', enabled: true, notes: '',
        timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
        actions: [{ id: `timeline-composition:${itemId}:scene`, label: '按轨道顺序叠加', kind: 'obs.setProgramScene', sceneName, sceneLayers: layers }]
      } }]
    };
  }
  if (target && 'media' in target) return { media: [target.media], cues: [] };
  const cue = target && 'cue' in target ? target.cue : fallback?.cue;
  return { media: [], cues: cue ? [{ cue: { ...cue, actions: cue.actions.filter((action) => action.kind === 'obs.setProgramScene') }, scheduledFrame: frame, executionId: 'x' }] : [] };
}

/** The old TimelineStateIndex: spans compiled once, then read by milliseconds, with no cover rule. */
type OldClip = Omit<ResolvedTimelineClip, 'covered'>;
class LegacyTimelineIndex {
  private readonly clips: OldClip[];
  private readonly visualObsCues: ResolvedTimelineObsCue[];
  private readonly clipOrder: number[];
  constructor(project: LinkProject, private readonly item: RundownItem) {
    const frameRate = project.timebase.frameRate;
    const assetById = new Map(project.mediaAssets.map((asset) => [asset.id, asset]));
    const layerById = new Map(item.visualLayers.map((layer, layerIndex) => [layer.id, { layer, layerIndex }]));
    const clips = item.referenceMediaClips.map((clip): OldClip => {
      const asset = assetById.get(clip.assetId);
      if (!asset) throw new Error(`媒体素材不存在：${clip.assetId}`);
      const isVisualAsset = asset.kind === 'video' || asset.kind === 'image';
      if (isVisualAsset && item.visualLayers.length > 0 && !clip.layerId) {
        throw new Error(`视觉素材片段“${clip.label}”还没分配视觉图层`);
      }
      const layerEntry = clip.layerId ? layerById.get(clip.layerId) : undefined;
      if (clip.layerId && !layerEntry) throw new Error(`素材片段“${clip.label}”引用不存在的图层：${clip.layerId}`);
      const span = resolveTimelineClipSpan(clip, frameRate);
      const active = true;
      const layerVisible = layerEntry?.layer.visible ?? true;
      const visible = active && layerVisible;
      return {
        ...span,
        clip,
        asset,
        layer: layerEntry?.layer ?? null,
        layerIndex: layerEntry?.layerIndex ?? null,
        active,
        visible,
        visual: active && layerVisible && isVisualAsset,
        audible: active && layerVisible && (asset.kind === 'audio' || (asset.kind === 'video' && clip.embeddedAudioEnabled !== false && !audioContainsMediaSource(item.referenceAudio, asset.id)))
      };
    });
    const visualObsCues = item.cues.flatMap((cue): ResolvedTimelineObsCue[] => {
      const showAction = findVisualObsShowAction(cue);
      if (!showAction) return [];
      if (!cue.layerId) throw new Error(`OBS 显示 Cue“${cue.name}”还没分配视觉图层`);
      const layerEntry = layerById.get(cue.layerId);
      if (!layerEntry) throw new Error(`OBS 显示 Cue“${cue.name}”引用不存在的图层：${cue.layerId}`);
      const span = resolveTimelineCueSpan(cue, frameRate);
      const active = cue.enabled;
      return [{
        ...span,
        cue,
        showAction,
        layer: layerEntry.layer,
        layerIndex: layerEntry.layerIndex,
        active,
        visible: active && layerEntry.layer.visible
      }];
    });
    this.clips = clips;
    this.visualObsCues = visualObsCues;
    this.clipOrder = clips.map((_, index) => index).sort((left, right) =>
      (clips[left]!.layerIndex ?? Number.MAX_SAFE_INTEGER) - (clips[right]!.layerIndex ?? Number.MAX_SAFE_INTEGER));
  }
  at(playheadMs: number) {
    if (!Number.isFinite(playheadMs) || playheadMs < 0) throw new Error('播放头时间必须是非负有限毫秒数');
    const clips = this.clips.map(entry => {
      const active = isTimelineSpanActive(entry, playheadMs);
      return { ...entry, active, visible: active && entry.visible, visual: active && entry.visual, audible: active && entry.audible };
    });
    const visualObsCues = this.visualObsCues.map(entry => {
      const active = entry.active && isTimelineSpanActive(entry, playheadMs);
      return { ...entry, active, visible: active && entry.visible };
    });
    const layers = this.item.visualLayers.map((layer, layerIndex) => ({
      layer,
      layerIndex,
      activeVisualClips: clips.filter((entry) => entry.layer?.id === layer.id && entry.visual),
      activeObsCues: visualObsCues.filter((entry) => entry.layer.id === layer.id && entry.visible)
    }));
    const topFirstClips = this.clipOrder.map(index => clips[index]!);
    return {
      itemId: this.item.id,
      playheadMs,
      clips,
      visualObsCues,
      layers,
      activeClipIds: topFirstClips.filter((entry) => entry.visible).map((entry) => entry.clip.id),
      activeVisualClipIds: topFirstClips.filter((entry) => entry.visual).map((entry) => entry.clip.id),
      activeAudioClipIds: topFirstClips.filter((entry) => entry.audible).map((entry) => entry.clip.id),
      activeObsCueIds: visualObsCues.filter((entry) => entry.visible).map((entry) => entry.cue.id)
    };
  }
}

// ---- Projects: the hand-made cases the old tests used, and seeded random ones ----

const ASSETS = [
  { id: 'video', name: '视频', kind: 'video', folderId: null, relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 600_000, width: 1080, height: 1920 },
  { id: 'video2', name: '视频二', kind: 'video', folderId: null, relativePath: 'assets/video2.mov', sha256: 'd'.repeat(64), byteLength: 1, durationMs: 600_000, width: 1080, height: 1920 },
  { id: 'image', name: '图片', kind: 'image', folderId: null, relativePath: 'assets/image.png', sha256: 'b'.repeat(64), byteLength: 1, width: 1080, height: 1920 },
  { id: 'sound', name: '音效', kind: 'audio', folderId: null, relativePath: 'assets/sound.wav', sha256: 'c'.repeat(64), byteLength: 1, durationMs: 600_000 }
] as const;

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296; };
}

/** Tracks filled left to right with clips, cameras (some without a length) and shown sources, some touching, some apart. */
function randomProject(seed: number, frameRate: MtcFrameRate = '30', parts = 40): LinkProject {
  const random = seeded(seed), pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const fps = playbackFramesPerSecond(frameRate), ms = (frames: number): number => Math.round(frames / fps * 1000);
  const at = (frame: number) => frameNumberToTimecode(frame, frameRate);
  const layerCount = 1 + Math.floor(random() * 4);
  const visualLayers = Array.from({ length: layerCount }, (_, index) => ({ id: `L${index}`, name: `轨道${index}`, visible: random() > 0.12, locked: false }));
  const clips: ReferenceMediaClip[] = [], cues: LinkCue[] = [];
  const cursor = visualLayers.map(() => Math.floor(random() * 60));
  for (let part = 0; part < parts; part++) {
    const layer = Math.floor(random() * layerCount), layerId = visualLayers[layer]!.id;
    const start = cursor[layer]!, frames = 5 + Math.floor(random() * 150);
    const kind = pick(['video', 'video', 'image', 'sound', 'camera', 'camera', 'open-camera', 'show'] as const);
    const id = `${kind}-${part}`;
    if (kind === 'camera' || kind === 'open-camera') {
      cues.push({ id, name: id, enabled: random() > 0.1, notes: '', timecode: at(start), layerId, ...(kind === 'camera' ? { durationMs: ms(frames) } : {}),
        actions: [{ id: `${id}-scene`, label: id, kind: 'obs.setProgramScene', sceneName: `机位 ${part % 5}` },
          ...(random() > 0.7 ? [{ id: `${id}-midi`, label: id, kind: 'midi.noteOn' as const, portProfileId: 'p', channel: 1, note: 60, velocity: 100 }] : [])] });
    } else if (kind === 'show') {
      cues.push({ id, name: id, enabled: random() > 0.1, notes: '', timecode: at(start), layerId, durationMs: ms(frames),
        actions: [{ id: `${id}-show`, label: id, kind: 'obs.setSceneItemEnabled', sceneName: `场景 ${part % 3}`, sourceName: `来源 ${part}`, enabled: true }] });
    } else {
      // A split clip: the same video carrying on from where the one before stopped.
      const previous = clips.at(-1);
      const carry = kind === 'video' && previous?.assetId === 'video' && previous.layerId === layerId && random() > 0.5;
      const offset = carry ? (previous.sourceOffsetMs ?? 0) + previous.durationMs : Math.floor(random() * 10_000);
      clips.push({ id, assetId: kind === 'video' && random() > 0.7 ? 'video2' : kind, label: id, startTimecode: at(start), sourceOffsetMs: offset,
        durationMs: ms(frames), layerId, canvasTransform: DEFAULT_REFERENCE_CANVAS_TRANSFORM, ...(kind === 'video' && random() > 0.8 ? { embeddedAudioEnabled: false } : {}) });
    }
    // An open camera runs to the next picture, so leave room after it for one.
    cursor[layer] = start + (kind === 'open-camera' ? 1 : frames) + (random() > 0.4 ? 0 : Math.floor(random() * 90));
  }
  return parseLinkProject({ ...createEmptyLinkProject('迁移'), projectId: `p${seed}`, timebase: { frameRate, mode: 'per-item-reset' }, obsOutputMode: 'scenes', mediaAssets: [...ASSETS],
    rundown: [{ id: 'song', title: '歌', enabled: true, notes: '', visualLayers, referenceMediaClips: clips, cues,
      referenceAudio: { assetId: 'song-audio', relativePath: 'assets/song.wav', sha256: 'e'.repeat(64), durationMs: ms(Math.max(...cursor) + 120) } }] });
}

const stripIds = <T>(value: T): T => JSON.parse(JSON.stringify(value, (key, entry: unknown) => key === 'executionId' ? undefined : entry)) as T;

function compareProject(project: LinkProject): { frames: number; fixed: number } {
  const item = project.rundown[0]!;
  const fresh = new SceneOutputTimeline(project, 'song'), legacy = new LegacySceneOutput(project, 'song');
  const index = new TimelineStateIndex(project, item), legacyIndex = new LegacyTimelineIndex(project, item);
  const fps = playbackFramesPerSecond(project.timebase.frameRate);
  const last = Math.max(0, ...legacy.index.media.map(entry => entry.end), ...legacy.index.scenes.map(entry => entry.end)) + 30;
  let fixed = 0;
  expect(fresh.airtime()).toEqual(legacy.airtime());
  expect(stripIds(fresh.preloadEntries())).toEqual(stripIds(legacy.preloadEntries()));
  for (let frame = 0; frame <= last; frame++) {
    expect(stripIds(fresh.at(frame)), `第 ${frame} 帧的画面输出`).toEqual(stripIds(legacy.at(frame)));
    const picture = legacy.picture(frame);
    expect(fresh.picture(frame), `第 ${frame} 帧的离线预览`).toEqual(picture);
    for (const ms of [frame / fps * 1000, (frame + 0.5) / fps * 1000]) {
      const before = legacyIndex.at(ms), after = index.at(ms);
      // The one intended change: a clip under a camera is no longer "on air" in the editor.
      const seen = new Set(picture.clipIds);
      const coveredNow = (id: string): boolean => before.activeVisualClipIds.includes(id) && !seen.has(id);
      if (before.activeVisualClipIds.some(coveredNow)) fixed++;
      expect(after.activeVisualClipIds, `${ms} ms 舞台上的画面`).toEqual(before.activeVisualClipIds.filter(id => !coveredNow(id)));
      expect(after.activeClipIds).toEqual(before.activeClipIds.filter(id => !coveredNow(id)));
      expect(after.activeAudioClipIds).toEqual(before.activeAudioClipIds);
      expect(after.activeObsCueIds, `${ms} ms 显示来源`).toEqual(before.activeObsCueIds);
    }
  }
  return { frames: last + 1, fixed };
}

describe('R1 迁移：唯一的画面函数和两套旧算法逐帧相等', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])('随机工程 %i（30 帧）', (seed) => {
    compareProject(randomProject(seed));
  });
  it('手写的几种：机位盖住视频、视频在机位上方、机位下的音效、无时长机位', () => {
    const base = () => parseLinkProject({ ...createEmptyLinkProject('插入机位'), obsOutputMode: 'scenes', mediaAssets: [...ASSETS], rundown: [{
      id: 'song', title: '舞蹈', visualLayers: [{ id: 'camera-layer', name: '机位', visible: true, locked: false }, { id: 'media', name: '视频', visible: true, locked: false }],
      referenceMediaClips: [{ id: 'clip', assetId: 'video', label: '舞蹈', layerId: 'media', startTimecode: { hours: 0, minutes: 0, seconds: 6, frames: 0 }, durationMs: 24000, sourceOffsetMs: 2000 }],
      cues: [{ id: 'camera', name: '临时机位', layerId: 'camera-layer', timecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 }, durationMs: 5000, actions: [{ id: 'scene', kind: 'obs.setProgramScene', label: '切机位', sceneName: '拉腿机位' }] }]
    }] });
    compareProject(base());
    const above = base(); above.rundown[0]!.visualLayers.reverse(); compareProject(above);
    const sound = base(); sound.rundown[0]!.referenceMediaClips[0]!.assetId = 'sound'; compareProject(sound);
    const open = base(); delete open.rundown[0]!.cues[0]!.durationMs; compareProject(open);
  });
  it.each([['25', 101],['29.97df', 102], ['24', 103], ['29.97df', 104]] as const)('%s 帧率的随机工程', (frameRate, seed) => {
    compareProject(randomProject(seed, frameRate));
  });
  it('有意的修正真的出现过：被机位盖住的素材在编辑器里不再算在播', () => {
    let fixed = 0;
    for (const seed of [2, 4, 5]) fixed += compareProject(randomProject(seed)).fixed;
    expect(fixed).toBeGreaterThan(0);
  });
  it('大工程（600 段）上新旧开销对比', () => {
    const project = randomProject(500, '30', 600), item = project.rundown[0]!;
    const fresh = new TimelineStateIndex(project, item), legacy = new LegacySceneOutput(project, 'song'), legacyIndex = new LegacyTimelineIndex(project, item);
    const frames = Math.max(...legacy.index.media.map(entry => entry.end));
    const time = (run: () => void): number => { const start = performance.now(); run(); return performance.now() - start; };
    for (let frame = 0; frame < 300; frame++) { legacyIndex.at(frame / 30 * 1000); fresh.at(frame / 30 * 1000); }
    const oldTotal = time(() => { for (let frame = 0; frame < frames; frame += 3) legacyIndex.at(frame / 30 * 1000); });
    const newTotal = time(() => { for (let frame = 0; frame < frames; frame += 3) fresh.at(frame / 30 * 1000); });
    // Worst case: every query in a new stretch, so nothing is reused.
    const starts = fresh.boundariesMs();
    const oldWorst = time(() => { for (let round = 0; round < 5; round++) for (const ms of starts) legacyIndex.at(ms); });
    const newWorst = time(() => { for (let round = 0; round < 5; round++) for (const ms of starts) fresh.at(ms); });
    // Measured on Linux, Node 25: every third frame 300 ms → 25 ms; a new stretch every query 105 ms → 100 ms.
    expect(newTotal).toBeLessThan(oldTotal);
    expect(newWorst).toBeLessThan(oldWorst * 1.5 + 20);
  });
});
