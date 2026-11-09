import { describe, expect, it } from 'vitest';
import { DEFAULT_REFERENCE_CANVAS_TRANSFORM, createEmptyLinkProject, parseLinkProject, type LinkCue, type LinkProject, type ReferenceMediaClip, type RundownItem } from '@tb/schema';
import {
  moveContentCommand, moveVisualLayerCommand, placeContentCommand, removeContentCommand, replaceCueCommand,
  replaceReferenceMediaClipCommand, trimContentCommand, updateVisualLayerCommand, withContentTimeline, type LinkCommand
} from '@tb/core/link';
import { NO_PENDING_PICTURE_EDITS, pendingPictureEdits, type SongPicture } from './pending-picture-edits';
import { songPicture } from './picture-on-air';

const at = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
const camera = (id: string, seconds: number, durationMs: number, layerId?: string): LinkCue => ({
  id, name: `机位 ${id}`, enabled: true, notes: '', timecode: at(seconds), durationMs, ...(layerId ? { layerId } : {}),
  actions: [{ id: `${id}-scene`, label: `切到 ${id}`, kind: 'obs.setProgramScene', sceneName: `机位 ${id}` }]
});
const midi = (id: string, seconds: number, layerId?: string): LinkCue => ({
  id, name: id, enabled: true, notes: '', timecode: at(seconds), ...(layerId ? { layerId } : {}),
  actions: [{ id: `${id}-midi`, label: id, kind: 'midi.programChange', portProfileId: 'port', channel: 1, program: 1 }]
});
/** An older “显示来源” cue: no camera, it shows a source in the scene on program. */
const showSource = (id: string, seconds: number, layerId: string): LinkCue => ({
  id, name: id, enabled: true, notes: '', timecode: at(seconds), durationMs: 1_000, layerId,
  actions: [{ id: `${id}-show`, label: `显示 ${id}`, kind: 'obs.setSceneItemEnabled', sceneName: '机位 a', sourceName: '字幕', enabled: true }]
});
const clip = (id: string, seconds: number, durationMs: number, layerId?: string): ReferenceMediaClip => ({
  id, assetId: 'video', label: id, startTimecode: at(seconds), durationMs, ...(layerId ? { layerId } : {}), canvasTransform: DEFAULT_REFERENCE_CANVAS_TRANSFORM
});

const video = { id: 'video', name: '开场视频', kind: 'video', folderId: null, relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 20_000, width: 1080, height: 1920 } as const;
/** The project as it was when 联动台播放 started the song: cameras a and b over the opening clip. */
function onAir(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal', obsOutputMode: 'scenes', mediaAssets: [video], rundown: [{ id: 'song', title: '第三首', enabled: true, notes: '',
    visualLayers: [{ id: 'cameras', name: '轨道 1', visible: true, locked: false }, { id: 'clips', name: '轨道 2', visible: true, locked: false }],
    cues: [camera('a', 2, 3_000, 'cameras'), camera('b', 8, 2_000, 'cameras'), midi('smoke', 1, 'cameras')],
    referenceMediaClips: [clip('opening', 0, 12_000, 'clips')] }] });
}
/** Parts that never play: a switched-off camera and a clip on a hidden track; and a shown-source cue that does. */
function withUnplayed(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal', obsOutputMode: 'scenes', mediaAssets: [video], rundown: [{ id: 'song', title: '第三首', enabled: true, notes: '',
    visualLayers: [{ id: 'cameras', name: '轨道 1', visible: true, locked: false }, { id: 'sources', name: '轨道 2', visible: true, locked: false }, { id: 'hidden', name: '轨道 3', visible: false, locked: false }],
    cues: [camera('a', 2, 3_000, 'cameras'), { ...camera('off', 8, 2_000, 'cameras'), enabled: false }, showSource('caption', 4, 'sources')],
    referenceMediaClips: [clip('backstage', 0, 12_000, 'hidden')] }] });
}
/** Edits made while it plays, each under the timeline rules as the editor makes them. */
const edit = (project: LinkProject, ...commands: LinkCommand[]): LinkProject => commands.reduce((value, command) => withContentTimeline(command).execute(value), project);
const song = (project: LinkProject): RundownItem => project.rundown[0]!;
const picture = (project: LinkProject): SongPicture => songPicture(project, 'song')!;
const pending = (playing: LinkProject, current: LinkProject) => pendingPictureEdits(picture(playing), picture(current));
const cueOf = (project: LinkProject, id: string): LinkCue => song(project).cues.find(cue => cue.id === id)!;
const clipOf = (project: LinkProject, id: string): ReferenceMediaClip => song(project).referenceMediaClips.find(entry => entry.id === id)!;

describe('播放中改的画面，停下重播才生效', () => {
  it('没改画面就没有要等的；改名字、备注、动作说明和锁轨道都不进 OBS，不算', () => {
    const playing = onAir();
    expect(pending(playing, playing)).toEqual(NO_PENDING_PICTURE_EDITS);
    const renamed = edit(playing,
      replaceCueCommand('song', { ...cueOf(playing, 'a'), name: '主机位', notes: '副歌', actions: cueOf(playing, 'a').actions.map(action => ({ ...action, label: '切主机位' })) }),
      replaceReferenceMediaClipCommand('song', { ...clipOf(playing, 'opening'), label: '开场 · 新' }),
      updateVisualLayerCommand('song', { id: 'clips', name: '素材', visible: true, locked: true }));
    expect(pending(playing, renamed)).toEqual(NO_PENDING_PICTURE_EDITS);
  });

  it('挪过的机位、修剪过和改过属性的素材标出来，没动的照旧', () => {
    const playing = onAir();
    const moved = edit(playing, moveContentCommand('song', { kind: 'cue', id: 'b' }, 9_000, { track: 'cameras' }));
    expect([...pending(playing, moved).changed]).toEqual(['cue:b']);
    const trimmed = edit(playing, trimContentCommand('song', { kind: 'clip', id: 'opening' }, 0, 10_000));
    expect([...pending(playing, trimmed).changed]).toEqual(['media:opening']);
    const placed = edit(playing, replaceReferenceMediaClipCommand('song', { ...clipOf(playing, 'opening'), canvasTransform: { ...DEFAULT_REFERENCE_CANVAS_TRANSFORM, x: 0.3 } }));
    expect([...pending(playing, placed).changed]).toEqual(['media:opening']);
    const muted = edit(playing, replaceReferenceMediaClipCommand('song', { ...clipOf(playing, 'opening'), embeddedAudioEnabled: false }));
    expect([...pending(playing, muted).changed]).toEqual(['media:opening']);
    const switchedOff = edit(playing, replaceCueCommand('song', { ...cueOf(playing, 'a'), enabled: false }));
    expect([...pending(playing, switchedOff).changed]).toEqual(['cue:a']);
  });

  it('新加的机位算；放到被占的地方另起一条轨道，别的轨道上的片段不受影响；新加的 MIDI Cue 不算画面', () => {
    const playing = onAir();
    const added = edit(playing,
      placeContentCommand('song', { cue: camera('c', 3, 2_000) }, { track: 'cameras' }),
      placeContentCommand('song', { cue: midi('flash', 6) }, { track: 'cameras' }));
    expect(song(added).visualLayers.map(layer => layer.id)).toEqual(['track-c', 'cameras', 'clips']);
    expect([...pending(playing, added).changed]).toEqual(['cue:c']);
  });

  it('删掉的片段不再画出来，只计数；删掉 MIDI Cue 不算', () => {
    const playing = onAir();
    const removed = edit(playing, removeContentCommand('song', [{ kind: 'cue', id: 'a' }, { kind: 'clip', id: 'opening' }, { kind: 'cue', id: 'smoke' }]));
    expect(pending(playing, removed)).toEqual({ changed: new Set(), removed: 2 });
  });

  it('删掉本来就不播出的部分（停用的机位、隐藏轨道上的素材）不计数，提示里说的“照常播出”才属实；删掉显示来源的 Cue 照常计数', () => {
    const playing = withUnplayed();
    const unplayed = edit(playing, removeContentCommand('song', [{ kind: 'cue', id: 'off' }, { kind: 'clip', id: 'backstage' }]));
    expect(pending(playing, unplayed)).toEqual(NO_PENDING_PICTURE_EDITS);
    const caption = edit(playing, removeContentCommand('song', [{ kind: 'cue', id: 'caption' }]));
    expect(pending(playing, caption)).toEqual({ changed: new Set(), removed: 1 });
  });

  it('挪动停用的机位、隐藏轨道上的素材不标；把它打开、把轨道显示出来，才标“停下重播才生效”', () => {
    const playing = withUnplayed();
    const moved = edit(playing, moveContentCommand('song', { kind: 'cue', id: 'off' }, 12_000, { track: 'cameras' }),
      moveContentCommand('song', { kind: 'clip', id: 'backstage' }, 1_000, { track: 'hidden' }));
    expect(song(moved).cues.find(cue => cue.id === 'off')?.timecode.seconds).toBe(12);
    expect(pending(playing, moved)).toEqual(NO_PENDING_PICTURE_EDITS);
    const switchedOn = edit(playing, replaceCueCommand('song', { ...cueOf(playing, 'off'), enabled: true }));
    expect([...pending(playing, switchedOn).changed]).toEqual(['cue:off']);
    const shown = edit(playing, updateVisualLayerCommand('song', { id: 'hidden', name: '轨道 3', visible: true, locked: false }));
    expect([...pending(playing, shown).changed]).toEqual(['media:backstage']);
    const caption = edit(playing, moveContentCommand('song', { kind: 'cue', id: 'caption' }, 6_000, { track: 'sources' }));
    expect([...pending(playing, caption).changed]).toEqual(['cue:caption']);
  });

  it('轨道显示、隐藏或换了上下位置，这条轨道上的画面都算修改', () => {
    const playing = onAir();
    const hidden = edit(playing, updateVisualLayerCommand('song', { id: 'clips', name: '轨道 2', visible: false, locked: false }));
    expect([...pending(playing, hidden).changed]).toEqual(['media:opening']);
    const reordered = edit(playing, moveVisualLayerCommand('song', 'clips', 0));
    expect([...pending(playing, reordered).changed].sort()).toEqual(['cue:a', 'cue:b', 'media:opening']);
  });

  it('机位改成只发 MIDI、MIDI Cue 加上切场景，都算修改', () => {
    const playing = onAir();
    const lost = edit(playing, replaceCueCommand('song', { ...cueOf(playing, 'a'), actions: midi('a', 2).actions }));
    expect([...pending(playing, lost).changed]).toEqual(['cue:a']);
    const gained = edit(playing, replaceCueCommand('song', { ...cueOf(playing, 'smoke'), actions: [...cueOf(playing, 'smoke').actions, ...camera('smoke', 1, 1_000).actions] }));
    expect([...pending(playing, gained).changed]).toEqual(['cue:smoke']);
  });

  it('同样的内容只是字段先后不同，不算修改', () => {
    const playing = onAir();
    const item = song(playing);
    const reversed = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;
    const rebuilt: RundownItem = { ...item, cues: item.cues.map(cue => reversed({ ...cue, actions: cue.actions.map(reversed), timecode: reversed(cue.timecode) })),
      referenceMediaClips: item.referenceMediaClips.map(entry => reversed({ ...entry, canvasTransform: reversed(entry.canvasTransform) })) };
    expect(pending(playing, { ...playing, rundown: [rebuilt] })).toEqual(NO_PENDING_PICTURE_EDITS);
  });

  it('正在播的版本里没有这首歌时，这首歌会播出的画面全都还没播', () => {
    expect([...pendingPictureEdits(undefined, picture(onAir())).changed].sort()).toEqual(['cue:a', 'cue:b', 'media:opening']);
  });
});
