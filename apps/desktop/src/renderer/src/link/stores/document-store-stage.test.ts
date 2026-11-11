import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeRundownItemCommand, setItemPlaybackCommand, setItemVolumeCommand, updateRundownItemCommand, type ShowState } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type RundownItem } from '@tb/schema';
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

  it('P1 跟随说不出在放哪首：每首都算在台上（照 showGate）', () => {
    show(onStage(null));
    expect(() => useDocumentStore.getState().execute(setItemPlaybackCommand('b', { ...playback, endMs: 30_000 }))).toThrow(AUDIO_WAIT);
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
