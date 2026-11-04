import { describe, expect, it } from 'vitest';
import { DEFAULT_REFERENCE_CANVAS_TRANSFORM, createEmptyLinkProject, parseLinkProject, type LinkCue, type LinkProject, type ReferenceMediaClip, type RundownItem, type VisualLayer } from '@tb/schema';
import {
  contentTrimBounds, impliedSceneEnds, moveContentCommand, normalizeContentTimeline, placeContentCommand,
  removeContentCommand, splitContentCommand, trimContentCommand, withContentTimeline
} from './content-timeline';
import { SceneOutputTimeline } from './scene-output-timeline';
import { frameNumberToTimecode } from './mtc-timecode';
import { setProjectFrameRateCommand, type LinkCommand } from './link-command';

const at = (frame: number) => frameNumberToTimecode(frame, '30');
const track = (id: string, extra: Partial<VisualLayer> = {}): VisualLayer => ({ id, name: id, visible: true, locked: false, ...extra });
const camera = (id: string, start: number, frames: number | undefined, layerId?: string): LinkCue => ({
  id, name: id, enabled: true, notes: '', timecode: at(start), ...(frames === undefined ? {} : { durationMs: Math.round(frames / 30 * 1000) }),
  ...(layerId ? { layerId } : {}), actions: [{ id: `${id}-scene`, label: id, kind: 'obs.setProgramScene', sceneName: `机位 ${id}` }]
});
const instant = (id: string, start: number, layerId?: string): LinkCue => ({
  id, name: id, enabled: true, notes: '', timecode: at(start), ...(layerId ? { layerId } : {}),
  actions: [{ id: `${id}-midi`, label: id, kind: 'midi.programChange', portProfileId: 'port', channel: 1, program: 1 }]
});
const clip = (id: string, assetId: string, start: number, frames: number, layerId?: string, sourceOffsetMs = 0): ReferenceMediaClip => ({
  id, assetId, label: id, startTimecode: at(start), sourceOffsetMs, durationMs: Math.round(frames / 30 * 1000),
  ...(layerId ? { layerId } : {}), canvasTransform: DEFAULT_REFERENCE_CANVAS_TRANSFORM
});

function project(item: Partial<RundownItem>, frameRate: LinkProject['timebase']['frameRate'] = '30'): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('时间线'), timebase: { frameRate, mode: 'per-item-reset' }, obsOutputMode: 'scenes', mediaAssets: [
    { id: 'video', name: '视频', kind: 'video', folderId: null, relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 20_000, width: 1080, height: 1920 },
    { id: 'image', name: '图片', kind: 'image', folderId: null, relativePath: 'assets/image.png', sha256: 'b'.repeat(64), byteLength: 1, width: 1080, height: 1920 },
    { id: 'sound', name: '音效', kind: 'audio', folderId: null, relativePath: 'assets/sound.wav', sha256: 'c'.repeat(64), byteLength: 1, durationMs: 3_000 }
  ], rundown: [{ id: 'song', title: '歌', enabled: true, notes: '', visualLayers: [], referenceMediaClips: [], cues: [], ...item }] });
}
const song = (value: LinkProject): RundownItem => value.rundown[0]!;
const tracks = (value: LinkProject): string[] => song(value).visualLayers.map(layer => layer.id);
const layerOf = (value: LinkProject, id: string): string | undefined => [...song(value).cues, ...song(value).referenceMediaClips].find(entry => entry.id === id)?.layerId;

/** What the output shows at every frame where anything starts or ends. */
function pictures(value: LinkProject): string[] {
  const timeline = new SceneOutputTimeline(value, 'song');
  const item = song(value);
  const frames = new Set<number>([0]);
  for (const entry of [...item.cues.map(cue => cue.timecode), ...item.referenceMediaClips.map(entry => entry.startTimecode)]) {
    const frame = entry.hours * 108_000 + entry.minutes * 1_800 + entry.seconds * 30 + entry.frames;
    for (const offset of [-1, 0, 1, 15, 29, 30, 60, 90, 150, 300]) if (frame + offset >= 0) frames.add(frame + offset);
  }
  return [...frames].sort((a, b) => a - b).map(frame => {
    const { camera: shown, clipIds } = timeline.picture(frame);
    return `${frame}:${shown?.id ?? '-'}:${clipIds.join('+')}`;
  });
}

describe('放到时间线上', () => {
  it('轨道这段空着就放上去，被占了就在这条轨道正上方新建一条', () => {
    let value = project({ visualLayers: [track('upper'), track('lower')], cues: [camera('a', 0, 90, 'lower'), camera('top', 0, 30, 'upper')] });
    value = placeContentCommand('song', { cue: camera('b', 90, 30) }, { track: 'lower' }).execute(value);
    expect(layerOf(value, 'b')).toBe('lower');
    value = placeContentCommand('song', { cue: camera('c', 60, 60) }, { track: 'lower' }).execute(value);
    expect(tracks(value)).toEqual(['upper', 'track-c', 'lower']);
    expect(layerOf(value, 'c')).toBe('track-c');
  });

  it('加到最上面：顶层空着就放顶层，否则新建最上层；新轨道区在最下面', () => {
    let value = project({});
    value = placeContentCommand('song', { clip: clip('one', 'video', 0, 60) }, 'top').execute(value);
    expect(tracks(value)).toEqual(['track-one']);
    value = placeContentCommand('song', { clip: clip('two', 'image', 60, 60) }, 'top').execute(value);
    expect(layerOf(value, 'two')).toBe('track-one');
    value = placeContentCommand('song', { clip: clip('three', 'image', 30, 60) }, 'top').execute(value);
    value = placeContentCommand('song', { clip: clip('four', 'image', 0, 10) }, { newTrack: 'bottom' }).execute(value);
    expect(tracks(value)).toEqual(['track-three', 'track-one', 'track-four']);
  });

  it('新机位默认 5 秒；时间点 Cue 不占时间，可以和片段放在同一位置', () => {
    let value = project({ visualLayers: [track('only')], cues: [camera('a', 0, 300, 'only')] });
    value = placeContentCommand('song', { cue: camera('b', 300, undefined) }, { track: 'only' }).execute(value);
    expect(song(value).cues.find(cue => cue.id === 'b')?.durationMs).toBe(5_000);
    value = placeContentCommand('song', { cue: instant('midi', 30) }, { track: 'only' }).execute(value);
    expect(layerOf(value, 'midi')).toBe('only');
  });

  it('锁定的轨道不能放也不能移出', () => {
    const value = project({ visualLayers: [track('locked', { locked: true }), track('free')], cues: [camera('a', 0, 30, 'locked'), camera('b', 0, 30, 'free')] });
    expect(() => placeContentCommand('song', { cue: camera('c', 60, 30) }, { track: 'locked' }).execute(value)).toThrow('已锁定');
    expect(() => moveContentCommand('song', { kind: 'cue', id: 'a' }, 60, { track: 'free' }).execute(value)).toThrow('已锁定');
  });
});

describe('移动、修剪、切割、删除', () => {
  it('拖到别的轨道被占的位置，在那条轨道上方新建；原轨道空了就去掉', () => {
    let value = project({ visualLayers: [track('upper'), track('lower')], cues: [camera('a', 0, 60, 'upper'), camera('b', 0, 90, 'lower')] });
    value = moveContentCommand('song', { kind: 'cue', id: 'a' }, 1_000, { track: 'lower' }).execute(value);
    expect(tracks(value)).toEqual(['track-a', 'lower']);
    expect(song(value).cues.find(cue => cue.id === 'a')?.timecode).toEqual(at(30));
    value = moveContentCommand('song', { kind: 'cue', id: 'a' }, 4_000, { track: 'lower' }).execute(value);
    expect(tracks(value)).toEqual(['lower']);
  });

  it('修剪停在同轨邻居和素材两端', () => {
    const value = project({ visualLayers: [track('only')], referenceMediaClips: [clip('left', 'image', 0, 30, 'only'), clip('film', 'video', 60, 60, 'only', 1_000), clip('right', 'image', 150, 30, 'only')] });
    const ref = { kind: 'clip', id: 'film' } as const;
    expect(contentTrimBounds(value, 'song', ref)).toEqual({ minStartMs: 1_000, maxEndMs: 5_000 });
    const trimmed = trimContentCommand('song', ref, 0, 10_000).execute(value);
    expect(song(trimmed).referenceMediaClips.find(entry => entry.id === 'film')).toMatchObject({ startTimecode: at(30), sourceOffsetMs: 0, durationMs: 4_000 });
    const sourceEnd = project({ visualLayers: [track('only')], referenceMediaClips: [clip('film', 'video', 0, 15, 'only', 19_500)] });
    expect(contentTrimBounds(sourceEnd, 'song', ref).maxEndMs).toBe(500);
    expect(song(trimContentCommand('song', ref, 0, 900).execute(sourceEnd)).referenceMediaClips[0]).toMatchObject({ durationMs: 500, sourceOffsetMs: 19_500 });
    const cameras = project({ visualLayers: [track('only')], cues: [camera('a', 0, 30, 'only'), camera('b', 60, 30, 'only')] });
    expect(song(trimContentCommand('song', { kind: 'cue', id: 'a' }, 0, 9_000).execute(cameras)).cues[0]?.durationMs).toBe(2_000);
  });

  it('切割素材按帧分开且两段合起来正好是原来用的素材', () => {
    let value = project({ visualLayers: [track('only')], referenceMediaClips: [{ ...clip('clip', 'video', 30, 135, 'only', 500), durationMs: 4_500 }] });
    value = splitContentCommand('song', { kind: 'clip', id: 'clip' }, 3_000, 'clip-right').execute(value);
    expect(song(value).referenceMediaClips).toMatchObject([
      { id: 'clip', sourceOffsetMs: 500, durationMs: 2_000 },
      { id: 'clip-right', startTimecode: at(90), sourceOffsetMs: 2_500, durationMs: 2_500, layerId: 'only' }
    ]);
    const frame = splitContentCommand('song', { kind: 'clip', id: 'clip-right' }, 3_034, 'frame-right').execute(value);
    expect(song(frame).referenceMediaClips).toMatchObject([{ id: 'clip', durationMs: 2_000 }, { id: 'clip-right', durationMs: 33 }, { id: 'frame-right', sourceOffsetMs: 2_533, durationMs: 2_467 }]);
    expect(() => splitContentCommand('song', { kind: 'clip', id: 'clip' }, 1_000, 'bad').execute(value)).toThrow('中间');
  });

  it('29.97df 切割后总长不变、不越过源文件', () => {
    const base = setProjectFrameRateCommand('29.97df').execute(project({ visualLayers: [track('only')] }));
    const value = placeContentCommand('song', { clip: { ...clip('clip', 'video', 0, 30), durationMs: 1_001 } }, { track: 'only' }).execute(base);
    const split = splitContentCommand('song', { kind: 'clip', id: 'clip' }, 15 * 1_001 / 30, 'right').execute(value);
    expect(song(split).referenceMediaClips).toMatchObject([{ id: 'clip', sourceOffsetMs: 0, durationMs: 501 }, { id: 'right', sourceOffsetMs: 501, durationMs: 500 }]);
  });

  it('机位也能切割，后半段动作换新 ID', () => {
    const value = splitContentCommand('song', { kind: 'cue', id: 'a' }, 1_000, 'a-right', () => 'new-action')
      .execute(project({ visualLayers: [track('only')], cues: [camera('a', 0, 90, 'only')] }));
    expect(song(value).cues).toMatchObject([
      { id: 'a', durationMs: 1_000, actions: [{ id: 'a-scene' }] },
      { id: 'a-right', timecode: at(30), durationMs: 2_000, layerId: 'only', actions: [{ id: 'new-action', sceneName: '机位 a' }] }
    ]);
  });

  it('删除后空轨道去掉，其他轨道不动', () => {
    const value = removeContentCommand('song', [{ kind: 'cue', id: 'a' }, { kind: 'clip', id: 'still' }])
      .execute(project({ visualLayers: [track('one'), track('two'), track('three')], cues: [camera('a', 0, 30, 'one'), instant('midi', 0, 'three')], referenceMediaClips: [clip('still', 'image', 0, 30, 'two')] }));
    expect(tracks(value)).toEqual(['three']);
  });
});

describe('旧工程打开时补齐规则，播出不变', () => {
  it('没有长度的机位补到它实际播出到的位置：下一个机位或画面开始，没有就到歌曲结束', () => {
    const value = project({
      visualLayers: [track('cut'), track('media'), track('hidden', { visible: false })],
      referenceAudio: { assetId: 'song', relativePath: 'assets/song.wav', sha256: 'd'.repeat(64), durationMs: 20_000 },
      cues: [camera('one', 0, undefined, 'cut'), camera('two', 300, undefined, 'cut'), camera('three', 450, undefined, 'cut')],
      referenceMediaClips: [clip('film', 'video', 150, 60, 'media'), clip('ignored', 'video', 60, 30, 'hidden'), clip('sfx', 'sound', 30, 30, 'media')]
    });
    expect(impliedSceneEnds(value, song(value))).toEqual(new Map([['one', 150], ['two', 450], ['three', 600]]));
    const normalized = normalizeContentTimeline(value);
    expect(song(normalized).cues.map(cue => cue.durationMs)).toEqual([5_000, 5_000, 5_000]);
    expect(pictures(value)).toEqual(expect.arrayContaining(['30:one:sfx', '180:-:film', '210:one:', '360:two:', '750:three:']));
    expect(pictures(normalized)).toEqual(pictures(value));
  });

  it('没分轨道的片段和 Cue：素材先放，压在素材上的机位放到它上面', () => {
    const value = project({ cues: [camera('cut', 30, 60), instant('midi', 0)], referenceMediaClips: [clip('film', 'video', 0, 60), clip('later', 'image', 90, 30)] });
    const normalized = normalizeContentTimeline(value);
    expect(tracks(normalized)).toEqual(['track-cut', 'track-film']);
    expect(['film', 'later', 'cut', 'midi'].map(id => layerOf(normalized, id))).toEqual(['track-film', 'track-film', 'track-cut', 'track-film']);
  });

  it('同一轨道重叠的部分：后开始的抬到它压住的部分上面，画面和原来一样', () => {
    const value = project({
      visualLayers: [track('top'), track('mixed', { locked: true }), track('empty')],
      cues: [camera('a', 0, 100, 'mixed'), camera('c', 120, 80, 'mixed'), camera('d', 130, 20, 'mixed'), camera('cover', 400, 30, 'top')],
      referenceMediaClips: [clip('b', 'video', 50, 100, 'mixed'), clip('sfx', 'sound', 10, 30, 'mixed')]
    });
    const normalized = normalizeContentTimeline(value);
    expect(tracks(normalized)).toEqual(['top', 'track-d', 'track-c', 'track-sfx', 'mixed']);
    expect(['a', 'sfx', 'b', 'c', 'd'].map(id => layerOf(normalized, id))).toEqual(['mixed', 'track-sfx', 'track-sfx', 'track-c', 'track-d']);
    expect(song(normalized).visualLayers.filter(layer => layer.id.startsWith('track-')).every(layer => layer.locked)).toBe(true);
    expect(pictures(value)).toEqual(expect.arrayContaining(['60:a:b', '130:d:', '160:c:', '430:cover:']));
    expect(pictures(normalized)).toEqual(pictures(value));
  });

  it('没什么要改时原样返回，补过的再补一次不变', () => {
    const tidy = project({ visualLayers: [track('one')], cues: [camera('a', 0, 30, 'one')] });
    expect(normalizeContentTimeline(tidy)).toBe(tidy);
    const once = normalizeContentTimeline(project({ visualLayers: [track('one'), track('none')], cues: [camera('a', 0, 60, 'one'), camera('b', 10, 30, 'one')] }));
    expect(tracks(once)).toEqual(['track-b', 'one']);
    expect(normalizeContentTimeline(once)).toBe(once);
  });

  it('每次修改后整理一次；灯光修改不碰内容时间线', () => {
    const untidy = project({ visualLayers: [track('one'), track('none')], cues: [camera('a', 0, 30, 'one')] });
    const edit: LinkCommand = { id: 'edit', label: '改名', execute: value => ({ ...value, name: '新名字' }), undo: before => before };
    expect(tracks(withContentTimeline(edit).execute(untidy))).toEqual(['one']);
    expect(tracks(withContentTimeline({ ...edit, scope: 'lighting' }).execute(untidy))).toEqual(['one', 'none']);
  });
});

describe('没有画面时保持的机位', () => {
  it('嵌套的两个机位都结束后，保持最后下画面的那个', () => {
    const value = project({ visualLayers: [track('upper'), track('lower')], cues: [camera('outer', 0, 100, 'lower'), camera('inner', 10, 10, 'upper')] });
    const timeline = new SceneOutputTimeline(value, 'song');
    expect(timeline.picture(15).camera?.id).toBe('inner');
    expect(timeline.picture(50).camera?.id).toBe('outer');
    expect(timeline.picture(150).camera?.id).toBe('outer');
  });
});
