import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { padSongCommand, padSongRender, removeRundownItemCommand, setItemPlaybackCommand, setItemVolumeCommand, setLightingCommand, updateRundownItemCommand, type ShowState } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type LightingDocument, type ReferenceAudio, type RundownItem } from '@tb/schema';
import { historyWait, useDocumentStore } from './document-store';
import { useShowStateStore } from './show-state-store';

// 0.5.9 S8a：在台上的歌照开始的那一版播。改它的音频本身、删掉或停用它，仓库不提交，按 showGate 的话说要等；
// 撤销、重做碰到也一样，按钮事先就灰掉并写明原因。
const SHA = 'a'.repeat(64);
const playback = { volume: 80, startMs: 0, endMs: 0, mtcOffsetMs: 3_600_000, shortcut: '', endAction: 'stop' as const };
function song(id: string) {
  return { id, title: id, referenceAudio: { assetId: `audio-${id}`, relativePath: `assets/reference-audio/${id}.wav`, sha256: SHA, durationMs: 60_000 }, playback };
}
const AUDIO_WAIT = '演出还没停止，这首歌还在台上，停下它以后再换音频、修剪音频、加空白或改 MTC 起始码。';
const REMOVE_WAIT = '演出还没停止，这首歌还在台上，停下它以后再删除或停用这首歌。';
const onStage = (itemId: string | null): ShowState => ({ phase: 'running', source: itemId ? 'internal' : 'p1', itemId, program: null });
const show = (state: ShowState) => useShowStateStore.setState({ show: state });
const item = (id: string): RundownItem => useDocumentStore.getState().project!.rundown.find(entry => entry.id === id)!;
/** Two seconds of blank time after the song's music, rendered as the main process would. */
function padTail(id: string) {
  const audio = item(id).referenceAudio!, plan = padSongRender(audio, 0, 2_000, '30');
  const file = { assetId: `padded-${id}`, relativePath: `assets/reference-audio/padded-${id}.wav`, sha256: 'b'.repeat(64), durationMs: plan.durationMs! };
  const rendered: ReferenceAudio = { ...file, timeline: { source: file, segments: [{ id: `padded-${id}`, startMs: 0, sourceOffsetMs: 0, durationMs: file.durationMs }], tracks: plan.tracks, durationMs: plan.durationMs! } };
  return padSongCommand(id, { baseAudioSha256: audio.sha256, leadDeltaMs: 0, tailMs: 2_000, rendered });
}
/** A lighting document whose console timeline starts at `timeOriginMs`: a song without its own MTC start plays from there. */
const origin = (timeOriginMs: number): LightingDocument => ({ ...createLightingDocument(), ma2Bindings: [{ id: 'binding', timecode: 7, name: '灯光 7',
  readAt: '2026-11-11T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [], mappings: [], playback: 'editable', timeOriginMs }] });

beforeEach(() => {
  useDocumentStore.getState().setProject(parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal', rundown: [song('a'), song('b')] }), null);
  show({ phase: 'idle', program: null });
});
afterEach(() => show({ phase: 'idle', program: null }));

describe('在台上的歌：音频本身、删除、停用等它停下', () => {
  it('修剪、改 MTC 起始码不提交，写明要等（是等待，不是红字）；改音量、改名照常', () => {
    const store = useDocumentStore.getState();
    show(onStage('a'));
    const before = useDocumentStore.getState().project;
    expect(() => store.execute(setItemPlaybackCommand('a', { ...playback, startMs: 1000 }))).toThrow(AUDIO_WAIT);
    expect(() => store.execute(setItemPlaybackCommand('a', { ...playback, mtcOffsetMs: 3_610_000 }))).toThrow(AUDIO_WAIT);
    expect(useDocumentStore.getState().project).toBe(before);
    expect(useDocumentStore.getState().error).toBe(AUDIO_WAIT);
    store.execute(setItemVolumeCommand('a', 40, 'g'));
    store.execute(updateRundownItemCommand('a', { title: '改名', enabled: true, notes: '' }));
    expect(item('a')).toMatchObject({ title: '改名', playback: { volume: 40, startMs: 0 } });
    // Another song is not on stage.
    store.execute(setItemPlaybackCommand('b', { ...playback, startMs: 1000 }));
    expect(item('b').playback?.startMs).toBe(1000);
  });

  it('删掉、停用在台上的歌不提交；别的歌照常', () => {
    const store = useDocumentStore.getState();
    show(onStage('a'));
    expect(() => store.execute(removeRundownItemCommand('a'))).toThrow(REMOVE_WAIT);
    expect(() => store.execute(updateRundownItemCommand('a', { title: 'a', enabled: false, notes: '' }))).toThrow(REMOVE_WAIT);
    expect(useDocumentStore.getState().project?.rundown.map(entry => [entry.id, entry.enabled])).toEqual([['a', true], ['b', true]]);
    store.execute(removeRundownItemCommand('b'));
    expect(useDocumentStore.getState().project?.rundown.map(entry => entry.id)).toEqual(['a']);
  });

  it('加、减空白（padSongCommand）改的是台上那首就等；改别的歌照常', () => {
    const store = useDocumentStore.getState();
    show(onStage('a'));
    expect(() => store.execute(padTail('a'))).toThrow(AUDIO_WAIT);
    expect(item('a').referenceAudio?.durationMs).toBe(60_000);
    store.execute(padTail('b'));
    expect(item('b').referenceAudio?.durationMs).toBe(62_000);
  });

  it('只有联动台播放照开始那一版播：P1 跟随（说不出在放哪首）改 MTC 起始码、灯光时间线起点照常提交；联动台播放时照旧要等', () => {
    useDocumentStore.getState().setProject(parseLinkProject({ ...createEmptyLinkProject('现场'), schemaVersion: 2, playbackSource: 'internal',
      rundown: [song('a'), { id: 'c', title: 'c', lighting: origin(0) }] }), null);
    const store = useDocumentStore.getState();
    show({ phase: 'held', source: 'p1', itemId: null, reason: 'p1-waiting', program: null });
    store.execute(setItemPlaybackCommand('a', { ...playback, mtcOffsetMs: 3_610_000 }));
    store.execute(setLightingCommand('c', origin(5_000)));
    expect(item('a').playback?.mtcOffsetMs).toBe(3_610_000);
    expect(item('c').lighting?.ma2Bindings?.[0]?.timeOriginMs).toBe(5_000);
    expect(historyWait(useDocumentStore.getState(), 'undo', { phase: 'held', source: 'p1', itemId: null, reason: 'p1-waiting', program: null })).toBeNull();
    show(onStage('a'));
    expect(() => store.execute(setItemPlaybackCommand('a', { ...playback, mtcOffsetMs: 3_620_000 }))).toThrow(AUDIO_WAIT);
    show({ phase: 'running', source: 'internal', itemId: 'c', program: null });
    expect(() => store.execute(setLightingCommand('c', origin(9_000)))).toThrow(AUDIO_WAIT);
  });

  it('撤销、重做碰到在台上的歌：按钮事先就说要等；按了也不动，写明要等', () => {
    const store = useDocumentStore.getState();
    store.execute(setItemPlaybackCommand('a', { ...playback, startMs: 1000 }));
    store.execute(updateRundownItemCommand('b', { title: '别的', enabled: true, notes: '' }));
    show(onStage('a'));
    // The last step touches only another song: it undoes.
    expect(historyWait(useDocumentStore.getState(), 'undo', onStage('a'))).toBeNull();
    store.undo();
    expect(item('b').title).toBe('b');
    expect(historyWait(useDocumentStore.getState(), 'undo', onStage('a'))).toBe(AUDIO_WAIT);
    const past = useDocumentStore.getState().past.length;
    store.undo();
    expect(useDocumentStore.getState().past).toHaveLength(past);
    expect(item('a').playback?.startMs).toBe(1000);
    expect(useDocumentStore.getState().error).toBe(AUDIO_WAIT);
    // Stopped: it undoes; redo of it waits once the song is on stage again.
    show({ phase: 'idle', program: null });
    store.undo();
    expect(item('a').playback?.startMs).toBe(0);
    show(onStage('a'));
    expect(historyWait(useDocumentStore.getState(), 'redo', onStage('a'))).toBe(AUDIO_WAIT);
    store.redo();
    expect(item('a').playback?.startMs).toBe(0);
    expect(historyWait(useDocumentStore.getState(), 'redo', { phase: 'idle', program: null })).toBeNull();
  });
});
