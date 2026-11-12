import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { P1_PADDING_REFUSAL, PADDING_AUDIO_CHANGED, editReferenceAudioCommand, songPaddingLimits, type LinkCommand } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type AudioTrack, type ReferenceAudio, type RundownItem } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { PADDING_RENDERING, blankPieces, padSongSteps, songPaddingState, type PaddingSteps } from './song-padding-flow';
import { SongPaddingHandles } from './SongPaddingHandles';
import { TimelineScroll } from './timeline-scroll';
import type { SongPadding } from './useSongPadding';

// The renderer's TSX compiles to React.createElement here.
vi.stubGlobal('React', React);

/*
 * Blank time in the editor (0.5.9 E15): letting go of a blank handle or a field renders the audio first, then writes
 * the one command with the same numbers; a failure writes nothing; an audio changed meanwhile is refused; P1 follow
 * and a song without audio have no handles.
 */

const source = { assetId: 'music', relativePath: 'assets/reference-audio/music.wav', sha256: 'a'.repeat(64), durationMs: 20_000 };
let renders = 0;
/** The main process's mix of `tracks`, `songMs` long when it lasts past the music. */
function mixed(tracks: AudioTrack[], songMs?: number): ReferenceAudio {
  const durationMs = songMs ?? Math.max(...tracks.flatMap(track => track.segments.map(segment => segment.startMs + segment.durationMs)));
  const file = { assetId: `mix-${++renders}`, relativePath: `assets/reference-audio/mix-${renders}.wav`, sha256: renders.toString(16).padStart(64, '0'), durationMs };
  return { ...file, timeline: { source: file, segments: [{ id: file.assetId, startMs: 0, sourceOffsetMs: 0, durationMs }], tracks, ...(songMs === undefined ? {} : { durationMs: songMs }) } };
}
const track = (startMs: number): AudioTrack => ({ id: 'music-track', title: '歌曲音频', source, segments: [{ id: 'music', startMs, sourceOffsetMs: 0, durationMs: 20_000 }] });
function project(playbackSource: 'internal' | 'p1' = 'internal') {
  return parseLinkProject({ ...createEmptyLinkProject('空白'), schemaVersion: 3, playbackSource, timebase: { frameRate: '25', mode: 'per-item-reset' },
    rundown: [{ id: 'song', title: '歌', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], referenceAudio: mixed([track(0)]),
      playback: { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: 3_600_000, shortcut: '' } }] });
}
const song = (): RundownItem => useDocumentStore.getState().project!.rundown[0]!;
type RenderRequest = Parameters<PaddingSteps['render']>[0];
function steps(render: (request: RenderRequest) => Promise<unknown>): PaddingSteps & { execute: ReturnType<typeof vi.fn<(command: LinkCommand) => void>> } {
  return { project: () => useDocumentStore.getState().project, projectPath: 'C:/show/空白.tblink', blocked: () => null, render,
    execute: vi.fn((command: LinkCommand) => useDocumentStore.getState().execute(command)) };
}
const answer = (request: RenderRequest): Promise<ReferenceAudio> => Promise.resolve(mixed(request.tracks!, request.durationMs));

beforeEach(() => { useDocumentStore.getState().setProject(project(), 'C:/show/空白.tblink'); });

describe('松手：先生成音频，再用同一组数字写一条命令', () => {
  it('加 2 秒前空白、1 秒后空白：渲染的是挪过的音轨和歌曲总长，写进去一步撤销', async () => {
    const run = steps(answer);
    const render = vi.fn(answer);
    run.render = render;
    await expect(padSongSteps({ itemId: 'song', leadDeltaMs: 2_000, tailMs: 1_000 }, run)).resolves.toBe('padded');
    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0]![0]).toMatchObject({ projectPath: 'C:/show/空白.tblink', durationMs: 23_000, tracks: [{ segments: [{ startMs: 2_000, durationMs: 20_000 }] }] });
    expect(run.execute).toHaveBeenCalledOnce();
    expect(song().referenceAudio).toMatchObject({ durationMs: 23_000, timeline: { durationMs: 23_000 } });
    useDocumentStore.getState().undo();
    expect(song().referenceAudio?.durationMs).toBe(20_000);
  });

  it('生成音频失败：照原样抛出给页面显示和记日志，什么都不写，也不再试', async () => {
    const before = useDocumentStore.getState().project;
    const run = steps(() => Promise.reject(new Error('磁盘已满，音频没有生成')));
    await expect(padSongSteps({ itemId: 'song', leadDeltaMs: 1_000, tailMs: 0 }, run)).rejects.toThrow('磁盘已满，音频没有生成');
    expect(run.execute).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().project).toBe(before);
  });

  it('生成音频期间这首歌的音频被改了：命令拒绝，不写', async () => {
    let finish: (value: ReferenceAudio) => void = () => { throw new Error('render not started'); };
    let asked: RenderRequest | null = null;
    const run = steps(request => { asked = request; return new Promise<ReferenceAudio>(resolve => { finish = resolve; }); });
    const padding = padSongSteps({ itemId: 'song', leadDeltaMs: 1_000, tailMs: 0 }, run);
    await vi.waitFor(() => expect(asked).not.toBeNull());
    // Meanwhile the operator trims the audio (another render, another file).
    useDocumentStore.getState().execute(editReferenceAudioCommand('song', mixed([{ ...track(0), segments: [{ id: 'music', startMs: 0, sourceOffsetMs: 0, durationMs: 18_000 }] }]), '编辑音频片段'));
    const trimmed = useDocumentStore.getState().project;
    finish(mixed(asked!.tracks!, asked!.durationMs));
    await expect(padding).rejects.toThrow(PADDING_AUDIO_CHANGED);
    expect(useDocumentStore.getState().project).toBe(trimmed);
  });

  it('命令会拒绝的就不生成音频：前面没有空白可去', async () => {
    const run = steps(answer);
    const render = vi.fn(answer);
    run.render = render;
    await expect(padSongSteps({ itemId: 'song', leadDeltaMs: -40, tailMs: 0 }, run)).rejects.toThrow('音乐前面已经没有空白了');
    expect(render).not.toHaveBeenCalled();
  });

  it('页面在等（演出、先同步控台）时不生成音频', async () => {
    const run = steps(answer);
    const render = vi.fn(answer);
    run.render = render;
    run.blocked = () => '先同步这首歌再加空白';
    await expect(padSongSteps({ itemId: 'song', leadDeltaMs: 1_000, tailMs: 0 }, run)).rejects.toThrow('先同步这首歌再加空白');
    expect(render).not.toHaveBeenCalled();
  });
});

describe('手柄和数字框什么时候能用', () => {
  const base = { hasAudio: true, internal: true, stageWait: null, renderWait: null, syncWait: null, busy: false };
  it('P1 跟随没有手柄、写明原因；没有音频的歌没有手柄', () => {
    expect(songPaddingState({ ...base, internal: false })).toEqual({ handles: false, blocked: P1_PADDING_REFUSAL, waiting: false });
    expect(songPaddingState({ ...base, hasAudio: false })).toMatchObject({ handles: false });
    expect(songPaddingState(base)).toEqual({ handles: true, blocked: null, waiting: false });
  });
  it('这首歌在台上用仓库的话按等待显示；演出在走时等；控台要先同步；正在生成音频时等这一次', () => {
    const onStage = '演出还没停止，这首歌还在台上，停下它以后再换音频、修剪音频、加空白或改 MTC 起始码。';
    expect(songPaddingState({ ...base, stageWait: onStage, renderWait: '演出还没停止，停止以后再生成音频。' })).toEqual({ handles: true, blocked: onStage, waiting: true });
    expect(songPaddingState({ ...base, renderWait: '演出还没停止，停止以后再生成音频。' })).toMatchObject({ blocked: '演出还没停止，停止以后再生成音频。', waiting: true });
    expect(songPaddingState({ ...base, syncWait: '先同步这首歌再加空白' })).toEqual({ handles: true, blocked: '先同步这首歌再加空白', waiting: false });
    expect(songPaddingState({ ...base, busy: true })).toEqual({ handles: true, blocked: PADDING_RENDERING, waiting: true });
  });

  it('画在音频轨上：P1 跟随的工程一个手柄都没有，联动台播放的工程两端各一个', () => {
    const drawn = (playbackSource: 'internal' | 'p1'): string => {
      useDocumentStore.getState().setProject(project(playbackSource), 'C:/show/空白.tblink');
      const item = song();
      const padding: SongPadding = { ...songPaddingState({ ...base, internal: playbackSource === 'internal' }), item, limits: songPaddingLimits(item, '25'), frameRate: '25', status: null, error: null,
        pad: () => Promise.resolve(), refusal: () => null, explain: () => undefined };
      const viewport = { viewportRef: { current: null }, scroll: new TimelineScroll(0), scrollLeftTo: () => undefined, maxScrollLeft: () => 0 };
      return renderToStaticMarkup(React.createElement(SongPaddingHandles, { padding, pixelsPerSecond: 100, contentWidth: 4_000, viewport, top: 28, height: 76 }));
    };
    expect(drawn('p1')).toBe('');
    const html = drawn('internal');
    expect(html.match(/class="ui-icon-button song-padding-handle"/g)).toHaveLength(2);
    expect(html).toContain('title="拖动加空白"');
  });
});

it('播放范围外的空白标灰', () => {
  const item = { referenceAudio: mixed([track(2_000)], 25_000), playback: { volume: 100, endAction: 'stop' as const, startMs: 1_000, endMs: 23_000, mtcOffsetMs: 0, shortcut: '' } };
  expect(blankPieces(item)).toEqual([
    { side: 'lead', startMs: 0, endMs: 1_000, unplayed: true }, { side: 'lead', startMs: 1_000, endMs: 2_000, unplayed: false },
    { side: 'tail', startMs: 22_000, endMs: 23_000, unplayed: false }, { side: 'tail', startMs: 23_000, endMs: 25_000, unplayed: true }
  ]);
  expect(blankPieces({ referenceAudio: mixed([track(0)]) })).toEqual([]);
});
