import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { editProgramPlaylistCommand, playlistDropIndex, playlistItems, playlistOrderFromP1, programPlaylistId, programPlaylists } from './program-playlists';

describe('播放列表管理', () => {
  it('新建、移动歌曲、改名、排序、删除保留歌曲，并支持撤销', () => {
    let project = parseLinkProject({ ...createEmptyLinkProject('演出'), rundown: [{ id: 'song', title: '歌曲' }] });
    project = editProgramPlaylistCommand({ type: 'add', id: 'a', name: '暖场' }).execute(project);
    project = editProgramPlaylistCommand({ type: 'add', id: 'b', name: '演出' }).execute(project);
    project = editProgramPlaylistCommand({ type: 'assign', itemIds: ['song'], playlistId: 'a' }).execute(project);
    expect(playlistItems(project, 'a')).toHaveLength(1);
    project = editProgramPlaylistCommand({ type: 'assign', itemIds: ['song'], playlistId: 'b' }).execute(project);
    expect(playlistItems(project, 'a')).toHaveLength(0);
    project = editProgramPlaylistCommand({ type: 'rename', id: 'b', name: '正式演出' }).execute(project);
    project = editProgramPlaylistCommand({ type: 'move', id: 'b', index: 0 }).execute(project);
    expect(programPlaylists(project)[0]?.name).toBe('正式演出');
    const before = structuredClone(project);
    const remove = editProgramPlaylistCommand({ type: 'remove', id: 'b' });
    project = remove.execute(project);
    expect(project.rundown).toHaveLength(1);
    expect(playlistItems(project, 'unassigned')).toHaveLength(1);
    expect(remove.undo(before)).toEqual(before);
    expect(programPlaylistId(before, before.rundown[0]!)).toBe('b');
  });
  it('拒绝空名、重名和失效引用，不修改原工程', () => {
    const project = editProgramPlaylistCommand({ type: 'add', id: 'a', name: '暖场' }).execute(createEmptyLinkProject('演出'));
    const before = structuredClone(project);
    expect(() => editProgramPlaylistCommand({ type: 'rename', id: 'a', name: '  ' }).execute(project)).toThrow();
    expect(() => editProgramPlaylistCommand({ type: 'add', id: 'b', name: '暖场' }).execute(project)).toThrow();
    expect(() => editProgramPlaylistCommand({ type: 'assign', itemIds: ['missing'], playlistId: 'a' }).execute(project)).toThrow();
    expect(project).toEqual(before);
  });
  it('拖动播放列表：放到两张列表之间，放回原处不算修改', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(playlistDropIndex(ids, 'a', 3)).toBe(2);
    expect(playlistDropIndex(ids, 'a', 4)).toBe(3);
    expect(playlistDropIndex(ids, 'd', 0)).toBe(0);
    expect(playlistDropIndex(ids, 'c', 1)).toBe(1);
    expect(playlistDropIndex(ids, 'b', 1)).toBeNull();
    expect(playlistDropIndex(ids, 'b', 2)).toBeNull();
    expect(playlistDropIndex(ids, 'x', 0)).toBeNull();
    let project = createEmptyLinkProject('演出');
    for (const id of ids) project = editProgramPlaylistCommand({ type: 'add', id, name: id }).execute(project);
    const command = editProgramPlaylistCommand({ type: 'move', id: 'a', index: playlistDropIndex(ids, 'a', 3)! });
    expect(command.label).toBe('移动播放列表');
    expect(programPlaylists(command.execute(project)).map(list => list.id)).toEqual(['b', 'c', 'a', 'd']);
  });
  it('直接来自 P1 的播放列表按 P1 的顺序，不在联动台里移动', () => {
    const fromP1 = parseLinkProject({ ...createEmptyLinkProject('演出'), p1Sync: { format: 'hirender-p1-audio-project', sourceSha256: 'a'.repeat(64), importedAt: '2026-11-11T00:00:00.000Z', playlists: [{ id: 'x', name: '暖场', sourceIndex: 0 }, { id: 'y', name: '演出', sourceIndex: 1 }] } });
    expect(playlistOrderFromP1(fromP1)).toBe(true);
    expect(() => editProgramPlaylistCommand({ type: 'move', id: 'p1:y', index: 0 }).execute(fromP1)).toThrow('来自 P1');
    // Once the project keeps its own list (a list was added), the order is the project's.
    const own = editProgramPlaylistCommand({ type: 'add', id: 'own', name: '加场' }).execute(fromP1);
    expect(playlistOrderFromP1(own)).toBe(false);
    expect(programPlaylists(editProgramPlaylistCommand({ type: 'move', id: 'own', index: 0 }).execute(own)).map(list => list.id)).toEqual(['own', 'p1:x', 'p1:y']);
  });
});
