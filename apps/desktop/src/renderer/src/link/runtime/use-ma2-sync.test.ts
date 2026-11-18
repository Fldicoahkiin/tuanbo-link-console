import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useMa2SyncStore, type SongSync } from '../stores/ma2-sync-store';
import { noticeText } from '../notice-text';
import { useMa2ModeStore } from '../stores/ma2-mode-store';
import { prepareMa2RealtimeSession } from './ma2-realtime-session';
import { tickMa2SongSync } from './ma2-song-sync';
import { announceMa2Sync, subscribeMa2Sync } from './use-ma2-sync';
vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
vi.mock('./ma2-realtime-session', () => ({ prepareMa2RealtimeSession: vi.fn() }));
vi.mock('./ma2-song-sync', () => ({ tickMa2SongSync: vi.fn(), markPendingMa2Songs: vi.fn() }));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { recordLog: () => Promise.resolve() } }));

// 修复前：一首歌同步停下时，红字写成“HAPPY：同步失败……”，歌名没有放进「」。歌名里有 5 个以上连续的大写字母，整句被当成
// 技术报错，前面多了“操作未能完成：”。
it('一首歌同步停下时，红字用「」写出歌名，按写好的样子显示', () => {
  const project = createEmptyLinkProject('同步提示');
  project.rundown = [{ id: 'song', title: 'HAPPY', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [] }];
  useDocumentStore.getState().setProject(project, 'test.tblink');
  const previous = useMa2SyncStore.getState();
  const message = '同步没成功：控台上的时间线没有读回来。改动还留在联动台，下次改动或点“刷新同步”时再试';
  const song: SongSync = { sessionId: 'session', itemId: 'song', documentId: useDocumentStore.getState().documentId, name: 'HAPPY',
    settings: { layout: 1, name: '联动台', nextSequence: 1, columns: 8 }, state: 'blocked', message, announcedFailure: '控台上的时间线没有读回来' };
  const shown: { text: string; tone: 'info' | 'error' }[] = [];
  // What LinkApp's notify puts on screen for a notice that is not written in main.
  const notify = (text: string, tone: 'info' | 'error' = 'info'): void => { shown.push({ text: noticeText(text, tone, false), tone }); };
  announceMa2Sync(notify, { ...previous, songs: { song } }, previous);
  expect(shown).toEqual([{ text: `「HAPPY」：${message}`, tone: 'error' }]);
  // Said once: the song was blocked already the next time the store changes.
  announceMa2Sync(notify, { ...previous, songs: { song } }, { ...previous, songs: { song } });
  expect(shown).toHaveLength(1);
  // 2026-11-10 现场：每次编辑重试又停下都弹一条红字，叠到“连续 15 次同步失败”。同样的原因再停下不再弹。
  announceMa2Sync(notify, { ...previous, songs: { song } }, { ...previous, songs: { song: { ...song, state: 'syncing' } } });
  expect(shown).toHaveLength(1);
  announceMa2Sync(notify, { ...previous, songs: { song: { ...song, announcedFailure: '别的原因' } } }, { ...previous, songs: { song: { ...song, state: 'syncing' } } });
  expect(shown).toHaveLength(2);
});

it('同一轮的改动直接同步，控台未答复时的新改动在答复后接着发，无需推进轮询时钟', async () => {
  const project = createEmptyLinkProject('即时编辑');
  project.rundown = [{ id: 'song', title: '一', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [] }];
  useDocumentStore.getState().setProject(project, 'test.tblink');
  useMa2ModeStore.setState({ method: 'network' });
  vi.mocked(prepareMa2RealtimeSession).mockResolvedValue(true);
  const replies: Array<() => void> = [];
  const titles: string[] = [];
  vi.mocked(tickMa2SongSync).mockImplementation(() => {
    titles.push(useDocumentStore.getState().project!.rundown[0]!.title);
    return new Promise<void>(resolve => { replies.push(resolve); });
  });
  vi.useFakeTimers();
  const stop = subscribeMa2Sync(vi.fn());
  try {
    const edit = (title: string) => useDocumentStore.getState().execute({ id: crypto.randomUUID(), label: '改歌名', undo: before => before,
      execute: current => ({ ...current, rundown: current.rundown.map(song => ({ ...song, title })) }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(titles).toEqual(['一']);
    replies.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    edit('二'); edit('三');
    await vi.advanceTimersByTimeAsync(0);
    expect(titles).toEqual(['一', '三']);
    edit('四');
    await vi.advanceTimersByTimeAsync(0);
    expect(titles).toEqual(['一', '三']);
    replies.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(titles).toEqual(['一', '三', '四']);
  } finally { stop(); replies.shift()?.(); vi.useRealTimers(); }
});
