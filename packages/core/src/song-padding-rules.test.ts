import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REFERENCE_CANVAS_TRANSFORM, createEmptyLinkProject, createLightingMusic, parseLinkProject,
  type AudioTrack, type AutomaticMusicCandidates, type LightingDocument, type LightingTrack, type LinkProject, type Ma2Catalog, type MtcFrameRate, type ReferenceAudio, type RundownItem
} from '@tb/schema';
import { blankFramesMs } from './audio-edit';
import { LightingTempoMap, lightingEventTime } from './lighting-edit';
import { musicMsToBeat } from './lighting-music';
import { ma2PendingChanges } from './ma2-pending-changes';
import { ma2SongPairs, reconcileMa2ReadState } from './ma2-pairing-state';
import { frameNumberToTimecode, timecodeToFrameNumber, timecodeToMilliseconds } from './mtc-timecode';
import { acceptMusicStructure } from './music-structure';
import { songBeats } from './song-beats';
import { LEAD_ROOM_REFUSAL, P1_PADDING_REFUSAL, TAIL_ROOM_REFUSAL, padSongCommand, padSongRender, songPaddingRoom } from './song-padding';

/**
 * Blank time before and after a song's music (0.5.9 E14, docs/design-059 05 §7): the rules the whole-song move keeps.
 * The song's MTC start and its console timeline stay; music, content and lighting move by the same whole frames; the
 * console gets one rewrite of the same timecode show; one undo puts everything back.
 */

const SONG_START_MS = 480_000;
const source = { assetId: 'music', relativePath: 'assets/reference-audio/music.wav', sha256: 'a'.repeat(64), durationMs: 20_000 };
const candidates: AutomaticMusicCandidates = { sourceSha256: source.sha256, durationMs: source.durationMs, bpm: 120, items: [
  ...Array.from({ length: 40 }, (_, i) => ({ id: `beat:${i}`, kind: 'beat' as const, name: '拍点', startMs: i * 500, endMs: null })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `down:${i}`, kind: 'downbeat' as const, name: '强拍', startMs: i * 2000, endMs: null }))
] };
const music = acceptMusicStructure({}, source, candidates, 'task');

let renders = 0;
/** What the main process renders: a WAV of the tracks, with the song's length when it lasts past the music. */
function mixed(tracks: AudioTrack[], songMs?: number): ReferenceAudio {
  const durationMs = songMs ?? Math.max(...tracks.flatMap(track => track.segments.map(segment => segment.startMs + segment.durationMs)));
  const file = { assetId: `mix-${++renders}`, relativePath: `assets/reference-audio/mix-${renders}.wav`, sha256: renders.toString(16).padStart(64, '0'), durationMs };
  return { ...file, timeline: { source: file, segments: [{ id: `mix-${renders}`, startMs: 0, sourceOffsetMs: 0, durationMs }], tracks, ...(songMs === undefined ? {} : { durationMs: songMs }) } };
}
const musicTrack = (startMs: number): AudioTrack => ({ id: 'music-track', title: '歌曲音频', source, segments: [{ id: 'music', startMs, sourceOffsetMs: 0, durationMs: 20_000 }] });

const ma2Track = (id: string, at: number): LightingTrack => ({ id, name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {},
  clips: [{ id: `${id}-clip`, name: '原编排', start: 0, duration: 40_000, timeLock: 'time', muted: false, events: [
    { id: `${id}-open`, kind: 'ma2', at, sequence: 1, executor: '1.101', cue: '1', action: 'goto', label: '开场' },
    { id: `${id}-chorus`, kind: 'ma2', at: at + 6_000, sequence: 1, executor: '1.101', cue: '2', action: 'goto', label: '副歌' }] }] });

/** Lighting with a time track bound to console Timecode 7, beat-locked clips under a tempo ramp, markers, a loop,
 * a music grid with a first beat and sections. */
function lighting(firstBeatMs: number): LightingDocument {
  const beatTrack: LightingTrack = { ...ma2Track('beats', 0), id: 'beats', clips: [{ id: 'beat-clip', name: '跟拍', start: 4, duration: 24, timeLock: 'beat', muted: false, events: [
    { id: 'beat-a', kind: 'ma2', at: 0, sequence: 2, executor: '1.102', cue: '1', action: 'goto', label: '甲' },
    { id: 'beat-b', kind: 'ma2', at: 9, sequence: 2, executor: '1.102', cue: '2', action: 'goto', label: '乙' },
    { id: 'beat-c', kind: 'ma2', at: 17.5, sequence: 2, executor: '1.102', cue: '3', action: 'goto', label: '丙' }] }] };
  const midiTrack: LightingTrack = { ...ma2Track('midi', 0), id: 'midi', kind: 'midi', clips: [{ id: 'midi-clip', name: '音符', start: 6, duration: 12, timeLock: 'beat', muted: false, events: [
    { id: 'note', kind: 'note', at: 2, note: 60, velocity: 100, duration: 6 }] }] };
  return {
    version: 2, outputMode: 'timecode', templates: [],
    tempos: [{ beat: 0, bpm: 120, numerator: 4, denominator: 4, transition: 'linear' }, { beat: 16, bpm: 150, numerator: 4, denominator: 4 }, { beat: 24, bpm: 100, numerator: 3, denominator: 4 }],
    music: { ...createLightingMusic(), firstBeatMs, sections: [{ id: 'verse', name: '主歌', startMs: 3_000, endMs: 9_000, color: '#65bfc8', notes: '' }] },
    markers: [{ id: 'drop', name: '爆发', startMs: 5_000, endMs: 8_000, kind: 'drop' }, { id: 'hit', name: '重击', startMs: 12_000, endMs: null }],
    loop: { enabled: true, startMs: 1_000, endMs: 4_000 },
    tracks: [ma2Track('track', 1_000), beatTrack, midiTrack],
    ma2Bindings: [{ id: 'binding', timecode: 7, name: '灯光 7', readAt: '2026-10-28T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [ma2Track('track', 1_000)], mappings: [], playback: 'editable', timeOriginMs: SONG_START_MS }]
  };
}

function catalog(target: number, ticks: number): Ma2Catalog {
  return { directory: { show: '1hao', generation: 'session-a', version: '3.3.4.3', entries: [{ target, name: `灯光 ${target}` }] }, readAt: '2026-10-28T00:00:00.000Z',
    entries: [{ target, name: `灯光 ${target}`, eventCount: 1, frameFormat: '30 FPS', offset: String(ticks), slot: 'TC Slot 1',
      events: [{ path: '30', time: '30', action: 'Goto', executor: '1.101', cue: '1', name: 'Cue' }], error: null, warnings: [] }] };
}

type Fixture = { frameRate?: MtcFrameRate; musicStartMs?: number; firstBeatMs?: number; playback?: { startMs: number; endMs: number }; mtcOffsetMs?: number; source?: 'p1' | 'internal' };
function project(options: Fixture = {}): LinkProject {
  const frameRate = options.frameRate ?? '25';
  const at = (ms: number) => frameNumberToTimecode(Math.round(ms / 1000 * (frameRate === '29.97df' ? 30_000 / 1_001 : Number(frameRate))), frameRate);
  const camera = { id: 'camera', name: '机位', enabled: true, notes: '', timecode: at(2_000), durationMs: 3_000, layerId: 'top', actions: [{ id: 'camera-scene', label: '机位', kind: 'obs.setProgramScene' as const, sceneName: '机位 1' }] };
  const shown = { id: 'shown', name: '显示来源', enabled: true, notes: '', timecode: at(6_000), durationMs: 2_000, layerId: 'bottom', actions: [{ id: 'shown-source', label: '显示', kind: 'obs.setSceneItemEnabled' as const, sceneName: '场景', sourceName: '扑克牌', enabled: true }] };
  const instant = { id: 'midi-cue', name: 'MIDI', enabled: true, notes: '', timecode: at(3_000), layerId: 'bottom', actions: [{ id: 'midi-pc', label: 'PC', kind: 'midi.programChange' as const, portProfileId: 'port', channel: 1, program: 1 }] };
  const clip = (id: string, assetId: string, ms: number, durationMs: number, layerId: string) => ({ id, assetId, label: id, startTimecode: at(ms), sourceOffsetMs: 0, durationMs, layerId, canvasTransform: DEFAULT_REFERENCE_CANVAS_TRANSFORM });
  const musicStartMs = options.musicStartMs ?? 0;
  const value = parseLinkProject({
    ...createEmptyLinkProject('前后空白'), schemaVersion: 3, playbackSource: options.source ?? 'internal', obsOutputMode: 'scenes', timebase: { frameRate, mode: 'per-item-reset' },
    mediaAssets: [
      { id: 'video', name: '视频', kind: 'video', folderId: null, relativePath: 'assets/video.mp4', sha256: 'd'.repeat(64), byteLength: 1, durationMs: 20_000, width: 1080, height: 1920 },
      { id: 'sound', name: '音效', kind: 'audio', folderId: null, relativePath: 'assets/sound.wav', sha256: 'e'.repeat(64), byteLength: 1, durationMs: 3_000 }
    ],
    rundown: [{ id: 'song', title: '歌', enabled: true, notes: '', music, referenceAudio: mixed([musicTrack(musicStartMs)]), lighting: lighting(options.firstBeatMs ?? 200),
      playback: { volume: 100, endAction: 'stop', startMs: options.playback?.startMs ?? 0, endMs: options.playback?.endMs ?? 0, mtcOffsetMs: options.mtcOffsetMs ?? SONG_START_MS, shortcut: '' },
      visualLayers: [{ id: 'top', name: '上', visible: true, locked: false }, { id: 'bottom', name: '下', visible: true, locked: false }, { id: 'sfx', name: '音效', visible: true, locked: false }],
      referenceMediaClips: [clip('video-clip', 'video', 1_000, 4_000, 'bottom'), clip('sound-clip', 'sound', 400, 1_000, 'sfx')],
      cues: [camera, shown, instant] }]
  });
  value.ma2ReadState = reconcileMa2ReadState(value, '192.0.2.10:30000', catalog(7, SONG_START_MS * 30 / 1000));
  return parseLinkProject(value);
}
const song = (value: LinkProject): RundownItem => value.rundown[0]!;

/** Pad the song as the editor will: render first (padSongRender), then the one command. */
function pad(value: LinkProject, leadDeltaMs: number, tailMs: number) {
  const item = song(value);
  const plan = padSongRender(item.referenceAudio!, leadDeltaMs, tailMs, value.timebase.frameRate);
  const command = padSongCommand('song', { baseAudioSha256: item.referenceAudio!.sha256, leadDeltaMs, tailMs, rendered: mixed(plan.tracks, plan.durationMs) });
  return { command, next: command.execute(value) };
}

/** Every time on the song's timeline, by what it is: absolute song ms. */
function times(item: RundownItem, frameRate: MtcFrameRate): Map<string, number> {
  const result = new Map<string, number>();
  for (const clip of item.referenceMediaClips) result.set(`clip:${clip.id}`, timecodeToMilliseconds(clip.startTimecode, frameRate));
  for (const cue of item.cues) result.set(`cue:${cue.id}`, timecodeToMilliseconds(cue.timecode, frameRate));
  const lightingDocument = item.lighting!;
  const map = new LightingTempoMap(lightingDocument.tempos);
  for (const track of lightingDocument.tracks) for (const clip of track.clips) for (const event of clip.events) {
    result.set(`event:${event.id}`, lightingEventTime(clip, event, map));
    if (event.kind === 'note') result.set(`release:${event.id}`, lightingEventTime(clip, { ...event, at: event.at + event.duration }, map));
  }
  for (const marker of lightingDocument.markers) { result.set(`marker:${marker.id}`, marker.startMs); if (marker.endMs !== null) result.set(`marker-end:${marker.id}`, marker.endMs); }
  for (const section of lightingDocument.music!.sections) { result.set(`section:${section.id}`, section.startMs); result.set(`section-end:${section.id}`, section.endMs); }
  result.set('first-beat', lightingDocument.music!.firstBeatMs);
  result.set('loop', lightingDocument.loop.startMs); result.set('loop-end', lightingDocument.loop.endMs);
  for (const track of audioTracksOf(item)) for (const segment of track.segments) result.set(`audio:${segment.id}`, segment.startMs);
  return result;
}
const audioTracksOf = (item: RundownItem): AudioTrack[] => item.referenceAudio!.timeline!.tracks!;

function expectMovedBy(before: Map<string, number>, after: Map<string, number>, deltaMs: number): void {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [key, ms] of before) expect(after.get(key), key).toBeCloseTo(ms + deltaMs, 6);
}

describe('规则 1：MTC 起始码和控台时间线的起点不变，配对不变', () => {
  it('加 2 秒前空白：mtcOffsetMs、timeOriginMs、控台基线和配对都和原来一样', () => {
    const before = project();
    expect(ma2SongPairs(before).pairs).toEqual({ 7: 'song' });
    const { next } = pad(before, 2_000, 0);
    expect(song(next).playback?.mtcOffsetMs).toBe(SONG_START_MS);
    expect(song(next).lighting?.ma2Bindings?.[0]?.timeOriginMs).toBe(SONG_START_MS);
    expect(song(next).lighting?.ma2Bindings).toEqual(song(before).lighting?.ma2Bindings);
    expect(ma2SongPairs(next).pairs).toEqual({ 7: 'song' });
  });
});

describe('规则 2：每样东西的绝对时间都正好加 delta', () => {
  it('机位、素材、音效、Cue、显示来源、音频片段、灯光事件、标记、段落、第一拍、循环区一起挪', () => {
    const before = project();
    const { next } = pad(before, 2_000, 0);
    expectMovedBy(times(song(before), '25'), times(song(next), '25'), 2_000);
    // Lengths stay.
    expect(song(next).referenceMediaClips.map(clip => clip.durationMs)).toEqual(song(before).referenceMediaClips.map(clip => clip.durationMs));
    expect(song(next).cues.map(cue => [cue.durationMs, cue.layerId])).toEqual(song(before).cues.map(cue => [cue.durationMs, cue.layerId]));
  });

  it('变速节拍图下的节拍锁定片段换成时间锁定，每个事件正好加 delta，并带上 beatAnchor', () => {
    const before = project();
    const { next } = pad(before, 1_480, 0);
    expectMovedBy(times(song(before), '25'), times(song(next), '25'), 1_480);
    const document = song(next).lighting!;
    const map = new LightingTempoMap(document.tempos);
    for (const id of ['beats', 'midi']) {
      const clip = document.tracks.find(track => track.id === id)!.clips[0]!;
      expect(clip.timeLock).toBe('time');
      for (const event of clip.events) expect(event.beatAnchor).toBeCloseTo(musicMsToBeat(document, lightingEventTime(clip, event, map)), 9);
    }
    // The tempo map itself is beats and stays; the grid moved with its first beat.
    expect(document.tempos).toEqual(song(before).lighting!.tempos);
  });

  it('delta 不是整帧时按帧取整，内容、音频和灯光挪的是同一个帧数', () => {
    const at25 = project();
    const { next } = pad(at25, 1_010, 0);
    expectMovedBy(times(song(at25), '25'), times(song(next), '25'), 1_000);
    const at30 = project({ frameRate: '30' });
    const moved = pad(at30, 50, 0).next;
    // 50 ms at 30 fps is 2 frames: the content moves 2 frames, audio and lighting the same 2 frames in whole ms.
    const frames = (value: LinkProject) => song(value).cues.map(cue => timecodeToFrameNumber(cue.timecode, '30'));
    expect(frames(moved)).toEqual(frames(at30).map(frame => frame + 2));
    expect(audioTracksOf(song(moved))[0]!.segments[0]!.startMs).toBe(blankFramesMs(2, '30'));
    expect(song(moved).lighting!.music!.firstBeatMs).toBe(200 + blankFramesMs(2, '30'));
  });
});

describe('规则 3：控台只重写一次原来那条时间码节目', () => {
  it('加空白后 ma2PendingChanges 这首歌只有一份改动，指向 Timecode 7，事件时间整体加 delta', () => {
    const before = project();
    expect(ma2PendingChanges(before)).toEqual([]);
    const { next } = pad(before, 2_000, 0);
    const pending = ma2PendingChanges(next);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ itemId: 'song', target: 7, error: null });
    const events = pending[0]!.changes.filter(change => change.before?.kind === 'event');
    expect(events.map(change => change.id).sort()).toEqual(['track-chorus', 'track-open']);
    for (const change of events) expect(Number(change.after!.properties.time)).toBeCloseTo(Number(change.before!.properties.time) + 2_000, 6);
    expect(pending[0]!.changes.every(change => change.before?.kind === 'event')).toBe(true);
  });
});

describe('规则 4：一步撤销完全恢复', () => {
  it('撤销拿回加空白之前的工程，逐字段相等', () => {
    const before = project();
    const snapshot: unknown = JSON.parse(JSON.stringify(before));
    const { command, next } = pad(before, 2_000, 1_200);
    expect(next).not.toEqual(before);
    const undone = command.undo(before);
    expect(undone).toBe(before);
    // 加空白没有改动原来的工程对象：撤销拿回来的和执行前逐字段一样。
    expect(JSON.parse(JSON.stringify(undone))).toEqual(snapshot);
  });
});

describe('规则 5：节拍不用重新识别就跟着音乐走', () => {
  it('rundownItem.music 原样不动，songBeats 的每一拍都晚了 delta', () => {
    const before = project();
    const { next } = pad(before, 2_000, 0);
    expect(song(next).music).toEqual(song(before).music);
    const beatTimes = (value: LinkProject) => { const beats = songBeats(song(value)); if (beats.state !== 'ready') throw new Error(beats.state); return beats.beats.map(beat => beat.atMs); };
    expect(beatTimes(next)).toEqual(beatTimes(before).map(ms => ms + 2_000));
  });
});

describe('规则 6：去前空白碰到最早的内容就停住', () => {
  it('音乐前已有 1 秒空白、音效从 0.4 秒开始：最多去 0.4 秒；多 1 帧就拒绝', () => {
    const before = project({ musicStartMs: 1_000, firstBeatMs: 600 });
    expect(songPaddingRoom(song(before), '25').maxLeadRemoveMs).toBe(400);
    expect(() => pad(before, -440, 0)).toThrow(LEAD_ROOM_REFUSAL);
    const { next } = pad(before, -400, 0);
    expectMovedBy(times(song(before), '25'), times(song(next), '25'), -400);
    expect(song(next).referenceMediaClips.find(clip => clip.id === 'sound-clip')!.startTimecode).toEqual(frameNumberToTimecode(0, '25'));
  });

  it('第一拍、灯光点、标记也算内容；去尾空白不能让歌比最晚的内容短', () => {
    expect(songPaddingRoom(song(project({ musicStartMs: 1_000, firstBeatMs: 100 })), '25').maxLeadRemoveMs).toBe(80);
    const padded = pad(project(), 0, 3_000).next;
    expect(songPaddingRoom(song(padded), '25').maxTailRemoveMs).toBe(3_000);
    // A marker 1 s past the music: only 2 s of the 3 s can go.
    const late = { ...padded, rundown: [{ ...song(padded), lighting: { ...song(padded).lighting!, markers: [...song(padded).lighting!.markers, { id: 'outro', name: '尾', startMs: 21_000, endMs: null }] } }] };
    expect(songPaddingRoom(song(late), '25').maxTailRemoveMs).toBe(2_000);
    expect(() => pad(late, 0, 960)).toThrow(TAIL_ROOM_REFUSAL);
    expect(songTail(pad(late, 0, 1_000).next)).toBe(1_000);
  });
});
const songTail = (value: LinkProject): number => song(value).referenceAudio!.durationMs - 20_000;

describe('规则 7：P1 跟随的工程不能加空白', () => {
  it('音频由 P1 播放，命令拒绝并说明原因', () => {
    expect(() => pad(project({ source: 'p1' }), 2_000, 0)).toThrow(P1_PADDING_REFUSAL);
  });
});

describe('规则 8：播放范围 0 保持 0，非 0 跟着音乐挪', () => {
  it('从头播到尾的歌，前后空白都播出来', () => {
    const { next } = pad(project(), 2_000, 1_000);
    expect(song(next).playback).toMatchObject({ startMs: 0, endMs: 0 });
  });
  it('播放起点和终点设在音乐中间的歌，起终点跟着音乐挪', () => {
    const { next } = pad(project({ playback: { startMs: 3_000, endMs: 15_000 } }), 2_000, 0);
    expect(song(next).playback).toMatchObject({ startMs: 5_000, endMs: 17_000 });
    const back = pad(project({ musicStartMs: 1_000, firstBeatMs: 600, playback: { startMs: 3_000, endMs: 15_000 } }), -400, 0).next;
    expect(song(back).playback).toMatchObject({ startMs: 2_600, endMs: 14_600 });
  });
});

describe('命令自己先挡住的情况', () => {
  it('歌曲时间码超出 24 小时，说“歌曲时间码超出 24 小时”', () => {
    expect(() => pad(project({ mtcOffsetMs: 86_380_000 }), 0, 5_000)).toThrow('歌曲时间码超出 24 小时');
  });
  it('渲染期间音频被改了、或交来的音频不是按这次的空白渲染的，都不写', () => {
    const value = project();
    const item = song(value);
    const plan = padSongRender(item.referenceAudio!, 2_000, 0, '25');
    expect(() => padSongCommand('song', { baseAudioSha256: 'f'.repeat(64), leadDeltaMs: 2_000, tailMs: 0, rendered: mixed(plan.tracks) }).execute(value)).toThrow('音频生成期间这首歌的音频改了');
    expect(() => padSongCommand('song', { baseAudioSha256: item.referenceAudio!.sha256, leadDeltaMs: 1_000, tailMs: 0, rendered: mixed(plan.tracks) }).execute(value)).toThrow('生成的音频和这次的空白对不上');
    expect(() => padSongCommand('song', { baseAudioSha256: item.referenceAudio!.sha256, leadDeltaMs: 2_000, tailMs: 0, rendered: mixed(plan.tracks, 25_000) }).execute(value)).toThrow('生成的音频和这次的空白对不上');
  });
  it('只有尾空白才存总长：没有尾空白的歌不因此要新格式', () => {
    expect(padSongRender(song(project()).referenceAudio!, 2_000, 0, '25').durationMs).toBeUndefined();
    expect(padSongRender(song(project()).referenceAudio!, 0, 1_000, '25').durationMs).toBe(21_000);
    expect(song(pad(project(), 0, 1_000).next).referenceAudio!.timeline!.durationMs).toBe(21_000);
  });
});
