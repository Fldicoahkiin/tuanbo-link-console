import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkProject } from '@tb/schema';
import { playlistItems } from '@tb/core/link';
import { ProjectLibrary } from './ProjectLibrary';

// The home rundown drawn once on the server with one playlist shown (2026-11-11 field report: 上移 and 下移 moved a
// song by its place in the whole rundown, so it could land between songs of another playlist and look unchanged).
vi.stubGlobal('React', React);
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));

const project: LinkProject = parseLinkProject({
  ...createEmptyLinkProject('演出'),
  playlists: [{ id: 'a', name: '暖场' }, { id: 'b', name: '演出' }],
  rundown: [
    { id: 'a1', title: '暖场一', playlistId: 'a' }, { id: 'b1', title: '演出一', playlistId: 'b' },
    { id: 'a2', title: '暖场二', playlistId: 'a' }, { id: 'b2', title: '演出二', playlistId: 'b' }
  ]
});

function draw(selectedId: string, playlistId: string, search = '', locked = false, shown: LinkProject = project): string {
  const filteredItems = playlistItems(shown, playlistId).filter(item => item.title.includes(search));
  return renderToStaticMarkup(React.createElement(ProjectLibrary, {
    onImportSongs: () => undefined, onOpenCueEditor: () => undefined, onImportFiles: () => Promise.resolve(), onAddItem: () => undefined,
    playedItemIds: [], playlistHost: null, notify: () => undefined, locked, importBlocked: null, metadataLocked: locked, volumeLocked: false, project: shown, revision: 1, filteredItems,
    selectedItem: shown.rundown.find(item => item.id === selectedId) ?? null, selectedItemId: selectedId, selectedPlaylistId: playlistId, search,
    currentItemId: null, onSelectPlaylist: () => undefined, onSearch: () => undefined, onChooseItem: () => undefined,
    onChooseReference: () => undefined, onSelectCurrentItem: () => undefined
  }));
}
const button = (html: string, label: string): string => new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? '';

describe('首页上移、下移按看得见的歌曲走', () => {
  it('列表里的第一首不能再上移，最后一首不能再下移', () => {
    // 演出一 is second in the whole rundown but first in 演出.
    const first = draw('b1', 'b');
    expect(button(first, '上移')).toContain('disabled');
    expect(button(first, '下移')).not.toContain('disabled');
    // 暖场二 is not last in the whole rundown but last in 暖场.
    expect(button(draw('a2', 'a'), '下移')).toContain('disabled');
  });

  it('搜索时和播放时不能调整顺序，并说明原因', () => {
    const searching = draw('a1', 'all', '暖场');
    expect(button(searching, '下移')).toContain('disabled');
    expect(button(searching, '下移')).toContain('搜索结果里不能调整顺序');
    expect(searching).toContain('搜索结果里不能调整顺序，清空搜索后再拖动');
    expect(draw('a1', 'a', '', true)).toContain('正在播放或处理中，停下后才能调整顺序');
    expect(draw('a1', 'a')).toContain('按住拖动可以调整顺序');
  });
});

describe('每首歌自己的音量（2026-11-09）', () => {
  it('挂着歌时节目属性里的“歌曲音量”照样能改，其余播放属性停下后才能改；旁边写明 P1 跟随时由 P1 控制', () => {
    const html = draw('a1', 'all', '', true, { ...project, playbackSource: 'internal' });
    const volume = /<input[^>]*aria-label="歌曲音量"[^>]*>/.exec(html)?.[0] ?? '';
    expect(volume).not.toBe('');
    expect(volume).not.toContain('disabled');
    // The volume sits before the fieldset that locks the other playback settings while a song plays.
    expect(html.indexOf('aria-label="歌曲音量"')).toBeLessThan(html.indexOf('<fieldset disabled'));
    expect(html.indexOf('aria-label="开始（秒）"')).toBeGreaterThan(html.indexOf('<fieldset disabled'));
    expect(html).toContain('只用于联动台播放；P1 跟随时由 P1 控制音量');
  });
});
