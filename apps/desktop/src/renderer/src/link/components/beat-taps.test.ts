import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptMusicStructure, setSongMusicCommand, songBeats, songMusicSource } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type AutomaticMusicCandidates } from '@tb/schema';
import { beatTapsWaiting, beatTapText, simpleDetectionKey, tapBeat, writeBeatTaps } from './useMusicBeatSegments';
import { useDocumentStore } from '../stores/document-store';

/*
 * Ctrl+J, 剪映's 手动踩点 (K10): a beat tapped at the playhead goes into the song's beats (`rundownItem.music`) through
 * `setSongMusicCommand` only; while something plays or the runtime is busy the taps wait and are written as one step
 * when it stops (rule row 「一首歌的节拍」).
 */

vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));
afterEach(() => { useDocumentStore.getState().setProject(null, null); });

const SOURCE = { assetId: 'audio', relativePath: 'assets/reference-audio/song.wav', sha256: 'a'.repeat(64), durationMs: 8000 };
const candidates: AutomaticMusicCandidates = { sourceSha256: SOURCE.sha256, durationMs: SOURCE.durationMs, bpm: 120,
  items: Array.from({ length: 16 }, (_, i) => ({ id: `beat:${i}`, kind: 'beat' as const, name: '拍点', startMs: i * 500, endMs: null })) };
const KEY = simpleDetectionKey('C:/shows/踩点.tblink', 'song');
const song = () => useDocumentStore.getState().project!.rundown[0]!;
const beatTimes = (): number[] => { const beats = songBeats(song()); return beats.state === 'ready' ? beats.beats.map(beat => beat.atMs) : []; };

function open(withBeats: boolean): void {
  const project = parseLinkProject({ ...createEmptyLinkProject('踩点'), schemaVersion: 2, obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '歌', referenceAudio: SOURCE, lighting: createLightingDocument() }] });
  useDocumentStore.getState().setProject(project, 'C:/shows/踩点.tblink');
  if (!withBeats) return;
  const item = song(), source = songMusicSource(item)!;
  useDocumentStore.getState().execute(setSongMusicCommand('song', source, acceptMusicStructure(item, source, candidates, 'task'), { label: '识别节拍' }));
}

describe('手动踩点（Ctrl+J）', () => {
  it('停着时一按就写进这首歌，一步撤销；已经有拍点的地方不重复加', () => {
    open(true);
    expect(tapBeat(KEY, 'song', 1_250, false)).toEqual({ kind: 'written', added: 1, outside: 0, kept: false });
    expect(beatTimes()).toContain(1_250);
    const repeated = tapBeat(KEY, 'song', 1_260, false);
    expect([repeated, beatTapText(repeated)]).toEqual([{ kind: 'written', added: 0, outside: 0, kept: false }, '这里已经有拍点了。']);
    useDocumentStore.getState().undo();
    expect(beatTimes()).not.toContain(1_250);
  });

  it('播放中先记下，不写；停下以后一起写成一步，撤销一次全部去掉', () => {
    open(true);
    const before = beatTimes();
    const first = tapBeat(KEY, 'song', 1_250, true);
    expect([first, beatTapText(first)]).toEqual([{ kind: 'waiting', first: true }, '踩的拍点先记下了，停止播放后一起写进这首歌。']);
    expect(beatTapText(tapBeat(KEY, 'song', 2_250, true))).toBeNull();
    tapBeat(KEY, 'song', 3_250, true);
    expect([beatTimes(), beatTapsWaiting(KEY)]).toEqual([before, 3]);
    expect(writeBeatTaps(KEY, true)).toEqual({ kind: 'waiting', first: false });
    const written = writeBeatTaps(KEY, false);
    expect([written, beatTapText(written), beatTapsWaiting(KEY)]).toEqual([{ kind: 'written', added: 3, outside: 0, kept: true }, '写进了 3 个踩的拍点。', 0]);
    expect(beatTimes()).toEqual([...before, 1_250, 2_250, 3_250].sort((a, b) => a - b));
    useDocumentStore.getState().undo();
    expect(beatTimes()).toEqual(before);
    expect(writeBeatTaps(KEY, false)).toEqual({ kind: 'none' });
  });

  it('没有节拍的歌也能踩；记下以后音乐被改了，就不写并说明原因', () => {
    open(false);
    tapBeat(KEY, 'song', 700, false);
    expect(beatTimes()).toEqual([700]);
    tapBeat(KEY, 'song', 1_400, true);
    const project = useDocumentStore.getState().project!;
    useDocumentStore.getState().setProject({ ...project, rundown: [{ ...song(), referenceAudio: { ...SOURCE } }] }, 'C:/shows/踩点.tblink');
    expect(() => writeBeatTaps(KEY, false)).toThrow('音乐被改了');
    expect([beatTapsWaiting(KEY), beatTimes()]).toEqual([0, [700]]);
  });
});
