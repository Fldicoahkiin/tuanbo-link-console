import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkProject } from '@tb/schema';
import { editProgramPlaylistCommand, playlistItems } from './program-playlists';
import { moveVisibleProgramsCommand, neighbourGap, reorderedVisibleIds } from './program-order';

function project(): LinkProject {
  // a1 a2 a3 are in 暖场, b1 b2 in 演出, interleaved in the whole rundown.
  return parseLinkProject({
    ...createEmptyLinkProject('演出'),
    playlists: [{ id: 'a', name: '暖场' }, { id: 'b', name: '演出' }],
    rundown: [
      { id: 'a1', title: 'a1', playlistId: 'a' }, { id: 'b1', title: 'b1', playlistId: 'b' },
      { id: 'a2', title: 'a2', playlistId: 'a' }, { id: 'b2', title: 'b2', playlistId: 'b' },
      { id: 'a3', title: 'a3', playlistId: 'a' }
    ]
  });
}
const order = (value: LinkProject): string[] => value.rundown.map(item => item.id);

describe('首页拖动调整节目顺序', () => {
  it('只在当前列表里看得见的歌之间换位置，别的列表的歌留在原处', () => {
    const before = project();
    const visible = playlistItems(before, 'a').map(item => item.id);
    const command = moveVisibleProgramsCommand(visible, ['a3'], 0);
    const after = command.execute(before);
    expect(order(after)).toEqual(['a3', 'b1', 'a1', 'b2', 'a2']);
    expect(playlistItems(after, 'a').map(item => item.id)).toEqual(['a3', 'a1', 'a2']);
    expect(command.undo(before)).toEqual(before);
  });

  it('上移、下移按看得见的相邻歌曲走，不会落到别的列表的歌中间而看不出变化', () => {
    const before = project();
    const visible = playlistItems(before, 'a').map(item => item.id);
    // The old 上移 moved a2 from rundown index 2 to 1, which only swapped it with b1: 暖场 looked the same.
    const up = neighbourGap(visible, 'a2', -1)!;
    expect(playlistItems(moveVisibleProgramsCommand(visible, ['a2'], up).execute(before), 'a').map(item => item.id)).toEqual(['a2', 'a1', 'a3']);
    const down = neighbourGap(visible, 'a2', 1)!;
    expect(playlistItems(moveVisibleProgramsCommand(visible, ['a2'], down).execute(before), 'a').map(item => item.id)).toEqual(['a1', 'a3', 'a2']);
    expect(neighbourGap(visible, 'a1', -1)).toBeNull();
    expect(neighbourGap(visible, 'a3', 1)).toBeNull();
  });

  it('选中的几首一起移动，保持原来的先后', () => {
    expect(reorderedVisibleIds(['1', '2', '3', '4', '5'], ['4', '2'], 5)).toEqual(['1', '3', '5', '2', '4']);
    expect(reorderedVisibleIds(['1', '2', '3', '4', '5'], ['5', '1'], 3)).toEqual(['2', '3', '1', '5', '4']);
    const all = project();
    const after = moveVisibleProgramsCommand(order(all), ['a1', 'a3'], 2).execute(all);
    expect(order(after)).toEqual(['b1', 'a1', 'a3', 'a2', 'b2']);
    expect(moveVisibleProgramsCommand(order(all), ['a1', 'a3'], 2).label).toBe('移动 2 个节目');
  });

  it('放回原处不算一次修改；节目单变了就不动', () => {
    expect(reorderedVisibleIds(['1', '2', '3'], ['2'], 1)).toBeNull();
    expect(reorderedVisibleIds(['1', '2', '3'], ['2'], 2)).toBeNull();
    expect(reorderedVisibleIds(['1', '2', '3'], ['x'], 0)).toBeNull();
    expect(reorderedVisibleIds(['1', '2', '3'], ['2'], 4)).toBeNull();
    const before = project(), copy = structuredClone(before);
    expect(() => moveVisibleProgramsCommand(['a1', 'a2'], ['a1'], 1).execute(before)).toThrow('没有变化');
    expect(() => moveVisibleProgramsCommand(['a1', 'gone'], ['a1'], 2).execute(before)).toThrow('节目单已经变了');
    expect(before).toEqual(copy);
  });

  it('移动播放列表不改歌曲顺序', () => {
    const before = project();
    const moved = editProgramPlaylistCommand({ type: 'move', id: 'b', index: 0 }).execute(before);
    expect(order(moved)).toEqual(order(before));
  });
});
