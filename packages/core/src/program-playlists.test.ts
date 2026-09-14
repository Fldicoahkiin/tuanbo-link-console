import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { editProgramPlaylistCommand, playlistItems, programPlaylistId, programPlaylists } from './program-playlists';

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
});
