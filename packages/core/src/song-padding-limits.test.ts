import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, createLightingMusic, parseLinkProject, type AudioTrack, type LightingDocument, type LinkProject, type MtcFrameRate, type ReferenceAudio, type RundownItem } from '@tb/schema';
import {
  DAY_REFUSAL, LEAD_ROOM_REFUSAL, P1_PADDING_REFUSAL, PADDING_STEP_FRAMES, TAIL_ROOM_REFUSAL, paddingDragFrame, paddingStopText, songPaddingLimits, songPaddingRefusal, songsShiftedBetween
} from './song-padding';
import { shiftLightingDocument } from './lighting-shift';

/*
 * The editor's side of blank time before and after a song's music (0.5.9 E15): what a held blank handle does, how far
 * blank time can be taken away and what is in the way, and which songs the console sync treats as moved as a whole.
 */

const source = { assetId: 'music', relativePath: 'assets/reference-audio/music.wav', sha256: 'a'.repeat(64), durationMs: 20_000 };
/** A song of `songMs` whose 20 s of music start at `leadMs`. */
function audio(leadMs: number, songMs?: number): ReferenceAudio {
  const tracks: AudioTrack[] = [{ id: 'music-track', title: '歌曲音频', source, segments: [{ id: 'music', startMs: leadMs, sourceOffsetMs: 0, durationMs: 20_000 }] }];
  const end = leadMs + 20_000, durationMs = songMs ?? end;
  const file = { assetId: 'mix', relativePath: 'assets/reference-audio/mix.wav', sha256: 'b'.repeat(64), durationMs };
  return { ...file, timeline: { source: file, segments: [{ id: 'mix', startMs: 0, sourceOffsetMs: 0, durationMs }], tracks, ...(songMs === undefined ? {} : { durationMs: songMs }) } };
}
function lightingAt(pointMs: number, extra: Partial<LightingDocument> = {}): LightingDocument {
  return { ...createLightingDocument(), version: 2, tracks: [{ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {},
    clips: [{ id: 'clip', name: '编排', start: 0, duration: 40_000, timeLock: 'time', muted: false, events: [{ id: 'point', kind: 'ma2', at: pointMs, sequence: 1, executor: '1.101', cue: '1', action: 'goto', label: '开场' }] }] }], ...extra };
}
function project(item: Partial<RundownItem>, options: { frameRate?: MtcFrameRate; source?: 'internal' | 'p1'; mtcOffsetMs?: number } = {}): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('空白'), schemaVersion: 3, playbackSource: options.source ?? 'internal', timebase: { frameRate: options.frameRate ?? '25', mode: 'per-item-reset' },
    rundown: [{ id: 'song', title: '歌', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], referenceAudio: audio(2_000, 30_000),
      playback: { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: options.mtcOffsetMs ?? 3_600_000, shortcut: '' }, ...item }]
  });
}
const song = (value: LinkProject): RundownItem => value.rundown[0]!;

describe('拖空白手柄：按帧取整，步长优先落在毫秒是整数的帧数上', () => {
  it('25 帧每帧 40 ms，30 帧每 3 帧 100 ms，24 帧每 3 帧 125 ms，29.97 照整帧', () => {
    expect(PADDING_STEP_FRAMES).toEqual({ '25': 1, '30': 3, '24': 3, '29.97df': 1 });
    const lead = (frameRate: MtcFrameRate, movedMs: number): number => {
      const limits = songPaddingLimits(song(project({}, { frameRate })), frameRate)!;
      return paddingDragFrame({ side: 'lead', limits, frameRate }, movedMs).leadDeltaMs;
    };
    expect([55, 61, 1_013].map(ms => lead('25', ms))).toEqual([40, 80, 1_000]);
    expect([40, 55, 140, 1_013].map(ms => lead('30', ms))).toEqual([0, 100, 100, 1_000]);
    expect([60, 70, 1_013].map(ms => lead('24', ms))).toEqual([0, 125, 1_000]);
    // 29.97: whole frames, each about 33 ms.
    expect([20, 40].map(ms => lead('29.97df', ms))).toEqual([33, 33]);
    expect(lead('25', -55)).toBe(-40);
  });

  it('后空白的手柄只动歌曲的结尾：前空白不变，后空白落在整帧上', () => {
    const value = project({}, { frameRate: '30' });
    const limits = songPaddingLimits(song(value), '30')!;
    expect(limits.tail.blankMs).toBe(8_000);
    expect(paddingDragFrame({ side: 'tail', limits, frameRate: '30' }, 1_260)).toEqual({ leadDeltaMs: 0, tailMs: 9_300, blankMs: 9_300, stop: null });
  });
});

describe('去空白碰到内容就停住，并说出挡住的是什么', () => {
  it('前空白：灯光点、第一拍、标记、段落、机位或素材，取最近的那一样', () => {
    const at = (lighting: LightingDocument) => songPaddingLimits(song(project({ lighting })), '25')!.lead;
    expect(at(lightingAt(1_200))).toMatchObject({ blankMs: 2_000, maxRemoveMs: 1_200, stop: 'point' });
    expect(at(lightingAt(1_200, { music: { ...createLightingMusic(), firstBeatMs: 400 } }))).toMatchObject({ maxRemoveMs: 400, stop: 'first-beat' });
    expect(at(lightingAt(1_200, { markers: [{ id: 'm', name: '标记', startMs: 800, endMs: null }] }))).toMatchObject({ maxRemoveMs: 800, stop: 'marker' });
    // Nothing before the music: the music itself stops it.
    expect(at(lightingAt(5_000))).toMatchObject({ maxRemoveMs: 2_000, stop: 'music' });
  });

  it('拖过了停在限度上，手柄的提示和数字框的拒绝都写挡住的东西', () => {
    const limits = songPaddingLimits(song(project({ lighting: lightingAt(1_200) })), '25')!;
    expect(paddingDragFrame({ side: 'lead', limits, frameRate: '25' }, -5_000)).toEqual({ leadDeltaMs: -1_200, tailMs: 8_000, blankMs: 800, stop: 'point' });
    expect(paddingStopText('lead', 'point')).toBe(`${LEAD_ROOM_REFUSAL}：挡住的是最早的灯光点`);
    expect(paddingStopText('lead', 'first-beat')).toBe(`${LEAD_ROOM_REFUSAL}：挡住的是音乐的第一拍`);
    expect(paddingStopText('tail', 'content')).toBe(`${TAIL_ROOM_REFUSAL}：挡住的是最晚的机位或素材`);
    expect(songPaddingRefusal(project({ lighting: lightingAt(1_200) }), 'song', -1_240, 8_000)).toBe(paddingStopText('lead', 'point'));
    expect(songPaddingRefusal(project({ lighting: lightingAt(1_200) }), 'song', -1_200, 8_000)).toBeNull();
  });

  it('后空白：歌不能比最晚的灯光点短', () => {
    const value = project({ lighting: lightingAt(27_000) });
    expect(songPaddingLimits(song(value), '25')!.tail).toMatchObject({ blankMs: 8_000, maxRemoveMs: 3_000, stop: 'point' });
    expect(songPaddingRefusal(value, 'song', 0, 4_960)).toBe(paddingStopText('tail', 'point'));
    expect(songPaddingRefusal(value, 'song', 0, 5_000)).toBeNull();
  });
});

describe('命令之前先挡住的', () => {
  it('P1 跟随、没有音频、歌曲时间码超出 24 小时', () => {
    expect(songPaddingRefusal(project({}, { source: 'p1' }), 'song', 1_000, 8_000)).toBe(P1_PADDING_REFUSAL);
    const silent = project({});
    delete silent.rundown[0]!.referenceAudio;
    expect(songPaddingRefusal(silent, 'song', 1_000, 0)).toBe('这首歌还没有音频，不能加空白');
    // 23:59:00:00 plus a 30 s song: 30 s more fit, 31 s do not.
    const late = project({}, { mtcOffsetMs: 86_340_000 });
    expect(songPaddingRefusal(late, 'song', 29_000, 8_000)).toBeNull();
    expect(songPaddingRefusal(late, 'song', 31_000, 8_000)).toBe(DAY_REFUSAL);
    const limits = songPaddingLimits(song(late), '25')!;
    expect(paddingDragFrame({ side: 'lead', limits, frameRate: '25' }, 40_000)).toMatchObject({ stop: 'day' });
    expect(paddingStopText('lead', 'day')).toBe('歌曲时间码超出 24 小时');
  });
});

describe('控台同步要知道哪些歌整首挪过（冲突 5）', () => {
  it('前空白变了、灯光跟着挪的歌算；只加后空白、或没有灯光的不算', () => {
    const before = project({ lighting: lightingAt(5_000) });
    const moved = structuredClone(before);
    moved.rundown[0] = { ...song(before), referenceAudio: audio(3_000, 31_000), lighting: shiftLightingDocument(song(before).lighting!, 1_000) };
    expect(songsShiftedBetween(before, moved)).toEqual(['song']);
    // Undone: moved back, as a whole too.
    expect(songsShiftedBetween(moved, before)).toEqual(['song']);
    const tail = structuredClone(before);
    tail.rundown[0] = { ...song(before), referenceAudio: audio(2_000, 33_000) };
    expect(songsShiftedBetween(before, tail)).toEqual([]);
    const unlit = project({});
    const unlitMoved = structuredClone(unlit);
    unlitMoved.rundown[0] = { ...song(unlit), referenceAudio: audio(3_000, 31_000) };
    expect(songsShiftedBetween(unlit, unlitMoved)).toEqual([]);
  });
});
