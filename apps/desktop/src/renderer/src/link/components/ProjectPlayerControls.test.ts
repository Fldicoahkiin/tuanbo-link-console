import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { PlayerViewStore } from '../stores/player-view-store';
import { songVolumeView } from '../view-models/song-volume';
import { ProjectPlayerTransport } from './ProjectPlayerControls';

// The player-bar slider is the song's own saved volume (2026-11-09, docs/SONG_VOLUME.md).
vi.stubGlobal('React', React);
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));

const project = parseLinkProject({ ...createEmptyLinkProject('每首歌的音量'), playbackSource: 'internal',
  rundown: ['甲', '乙'].map((id, index) => ({ id, title: id, referenceAudio: { assetId: id, relativePath: `${id}.wav`, sha256: 'a'.repeat(64), durationMs: 10_000 },
    ...(index === 0 ? { playback: { volume: 80, startMs: 0, endMs: 0, mtcOffsetMs: 0, shortcut: '' } } : {}) })) });

describe('播放条的音量是这首歌自己的音量', () => {
  it('挂着歌时是挂着的那首保存的音量和这一遍的 MIDI 临时音量，不看选中的歌', () => {
    expect(songVolumeView(project, { status: 'paused', itemId: '甲', volumeOverride: 30 }, '乙')).toMatchObject({ item: { id: '甲' }, playing: '甲', saved: 80, override: 30 });
    expect(songVolumeView(project, { status: 'preparing', itemId: '甲' }, '乙')).toMatchObject({ item: { id: '甲' }, override: null });
  });

  it('没挂歌时是选中的那首（没设过就是 100%），都没有就不能用', () => {
    expect(songVolumeView(project, { status: 'stopped', itemId: '甲', volumeOverride: 30 }, '乙')).toMatchObject({ item: { id: '乙' }, playing: null, saved: 100, override: null });
    expect(songVolumeView(project, { status: 'stopped', itemId: null }, null).item).toBeNull();
  });

  it('滑块说明它保存进工程；没有歌时不能用', () => {
    const view = new PlayerViewStore();
    const html = renderToStaticMarkup(React.createElement(ProjectPlayerTransport, { controller: null, view, engine: '', outdated: false,
      state: view.readControl(), selectedItem: null, notify: () => undefined }));
    const slider = /<label class="home-volume"[\s\S]*?<\/label>/.exec(html)?.[0] ?? '';
    expect(slider).toContain('title="这首歌的音量，松手后保存进工程"');
    expect(slider).toContain('disabled');
    expect(slider).not.toContain('临时音量');
  });
});
