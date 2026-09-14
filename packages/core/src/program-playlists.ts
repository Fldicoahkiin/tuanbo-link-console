import { parseLinkProject, type LinkProject, type RundownItem } from '@tb/schema';
import type { LinkCommand } from './link-command';

export function programPlaylists(project: LinkProject): { id: string; name: string }[] {
  return project.playlists ?? project.p1Sync?.playlists.map((list) => ({ id: `p1:${list.id}`, name: list.name })) ?? [];
}
export function programPlaylistId(project: LinkProject, item: RundownItem): string | null {
  const id = item.playlistId !== undefined ? item.playlistId : item.p1Media ? `p1:${item.p1Media.playlistId}` : null;
  return programPlaylists(project).some((list) => list.id === id) ? id : null;
}
export function playlistItems(project: LinkProject, playlistId: string): RundownItem[] {
  return project.rundown.filter((item) => playlistId === 'all' || (playlistId === 'unassigned' ? programPlaylistId(project, item) === null : programPlaylistId(project, item) === playlistId));
}
type PlaylistEdit = { type: 'add'; id: string; name: string } | { type: 'rename'; id: string; name: string } | { type: 'remove'; id: string } | { type: 'move'; id: string; index: number } | { type: 'assign'; itemIds: string[]; playlistId: string | null };
export function editProgramPlaylistCommand(edit: PlaylistEdit): LinkCommand {
  return {
    id: crypto.randomUUID(), label: '编辑播放列表',
    execute(project) {
      const next = structuredClone(project);
      next.playlists = structuredClone(programPlaylists(project));
      const lists = next.playlists;
      if (edit.type === 'assign') {
        if (edit.playlistId !== null && !lists.some((list) => list.id === edit.playlistId)) throw new Error('目标播放列表不存在');
        for (const id of edit.itemIds) { const item = next.rundown.find((value) => value.id === id); if (!item) throw new Error('节目不存在'); item.playlistId = edit.playlistId; }
      } else {
        const index = lists.findIndex((list) => list.id === edit.id);
        if (edit.type !== 'add' && index < 0) throw new Error('播放列表不存在');
        if (edit.type === 'add' || edit.type === 'rename') {
          const name = edit.name.trim();
          if (!name) throw new Error('列表名称不能为空');
          if (lists.some((list) => list.id !== (edit.type === 'rename' ? edit.id : '') && list.name === name)) throw new Error('列表名称已存在');
          if (edit.type === 'add') { if (index >= 0 || ['all', 'unassigned'].includes(edit.id)) throw new Error('播放列表标识重复'); lists.push({ id: edit.id, name }); }
          else lists[index]!.name = name;
        } else if (edit.type === 'remove') {
          for (const item of next.rundown) if (programPlaylistId(next, item) === edit.id) item.playlistId = null;
          lists.splice(index, 1);
        } else {
          if (!Number.isInteger(edit.index) || edit.index < 0 || edit.index >= lists.length) throw new Error('列表排序位置无效');
          lists.splice(edit.index, 0, lists.splice(index, 1)[0]!);
        }
      }
      next.updatedAt = new Date().toISOString();
      return parseLinkProject(next);
    },
    undo(before) { return parseLinkProject(before); }
  };
}
