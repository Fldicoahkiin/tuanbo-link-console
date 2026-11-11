import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renameProjectCommand, setItemVolumeCommand, SongVolumeGesture } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type LinkProject } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { songVolumeSync } from './song-volume-sync';

function project(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('每首歌的音量'), playbackSource: 'internal', rundown: ['甲', '乙'].map((id, index) => ({ id, title: id,
    referenceAudio: { assetId: id, relativePath: `${id}.wav`, sha256: 'a'.repeat(64), durationMs: 10_000 },
    ...(index === 0 ? { playback: { volume: 80, startMs: 0, endMs: 0, mtcOffsetMs: 480_000, shortcut: '' } } : {}) })) });
}

beforeEach(() => { useDocumentStore.getState().setProject(project(), null); });

/** The window's project as the store has it, and every saved volume the program is sent. */
function follow() {
  const send = vi.fn<(itemId: string, volume: number) => void>();
  const sync = songVolumeSync(useDocumentStore.getState().project!, send);
  const unsubscribe = useDocumentStore.subscribe(state => sync(state.project));
  return { send, unsubscribe };
}

describe('保存的音量送到正在播的节目（版本流之前的音量专用替代）', () => {
  it('松手保存、撤销、重做都立刻送到节目；别的修改不送', () => {
    const { send, unsubscribe } = follow(), store = useDocumentStore.getState();
    store.execute(renameProjectCommand('改名'));
    expect(send).not.toHaveBeenCalled();
    store.execute(setItemVolumeCommand('甲', 35, 'drag-1'));
    expect(send).toHaveBeenLastCalledWith('甲', 35);
    useDocumentStore.getState().undo();
    expect(send).toHaveBeenLastCalledWith('甲', 80);
    useDocumentStore.getState().redo();
    expect(send).toHaveBeenLastCalledWith('甲', 35);
    // A song without playback settings plays at 100%: its first volume is sent too.
    store.execute(setItemVolumeCommand('乙', 60, 'field'));
    expect(send).toHaveBeenLastCalledWith('乙', 60);
    expect(send).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it('一次拖动在工程里只留一次修改、一步撤销；键盘同一次聚焦里连按也是一步', () => {
    const { send, unsubscribe } = follow(), gesture = new SongVolumeGesture();
    const commit = (step: ReturnType<SongVolumeGesture['release']>): void => {
      if (step.kind === 'commit') useDocumentStore.getState().execute(setItemVolumeCommand(step.itemId, step.volume, step.gestureId));
    };
    const before = useDocumentStore.getState().past.length;
    gesture.press('甲');
    for (const volume of [70, 60, 50]) commit(gesture.input('甲', volume));
    // Nothing was saved, so nothing could override what the drag plays.
    expect(send).not.toHaveBeenCalled();
    commit(gesture.release());
    expect(useDocumentStore.getState().past.length).toBe(before + 1);
    expect(send).toHaveBeenCalledTimes(1);
    gesture.focus();
    commit(gesture.input('甲', 51)); commit(gesture.input('甲', 52));
    expect(useDocumentStore.getState().past.length).toBe(before + 2);
    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().project?.rundown[0]?.playback?.volume).toBe(50);
    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().project?.rundown[0]?.playback?.volume).toBe(80);
    expect(send).toHaveBeenLastCalledWith('甲', 80);
    unsubscribe();
  });
});
