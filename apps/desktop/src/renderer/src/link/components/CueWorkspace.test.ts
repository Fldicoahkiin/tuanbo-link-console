import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkCue, type LinkProject, type ProgramPlayerState } from '@tb/schema';
import { emptyInternalPlayerState, moveContentCommand, withContentTimeline } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { PlayerViewStore } from '../stores/player-view-store';
import { CueWorkspace } from './CueWorkspace';
import type { ProjectPlayer } from './ProjectPlayerControls';

// The editor drawn once on the server, as the window first draws it, from the player that useInternalPlayer
// hands LinkApp: what reaches the tracks and the line above them (review: the wiring had no test).
vi.hoisted(() => {
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); }, clear: () => saved.clear(), key: () => null, length: 0 } });
});
// The renderer's TSX compiles to React.createElement here; the window's size is read while the timeline first draws.
vi.stubGlobal('React', React);
vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720 });
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));
// A server render reads a store as it was created; the window reads it as it is now, with the project open.
vi.mock('../stores/document-store', async importOriginal => {
  const actual = await importOriginal<typeof import('../stores/document-store')>();
  const store = actual.useDocumentStore;
  type State = ReturnType<typeof store.getState>;
  return { ...actual, useDocumentStore: Object.assign(<T>(select: (state: State) => T): T => select(store.getState()), store) };
});
// The window subscribes to the player's clock; drawn once, it reads where the player is.
vi.mock('../usePlayerClock', () => ({ usePlayerClock: (view: PlayerViewStore) => view.readClock() }));
// Nothing is laid out on the server: the timeline as the window measures it at 1280 × 720, so parts are drawn.
vi.mock('./useTimelineViewportSize', () => ({ initialTimelineSize: () => ({ width: 1_000, height: 400 }),
  useTimelineViewportSize: () => ({ width: 1_000, height: 400, observed: { current: true } }) }));

afterEach(() => { useDocumentStore.getState().setProject(null, null); });

const at = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
const camera = (id: string, seconds: number): LinkCue => ({
  id, name: `机位 ${id}`, enabled: true, notes: '', timecode: at(seconds), durationMs: 2_000, layerId: 'cameras',
  actions: [{ id: `${id}-scene`, label: `切到 ${id}`, kind: 'obs.setProgramScene', sceneName: `机位 ${id}` }]
});
/** The third song: camera a at 2 s, camera b at 8 s; the window reopened it after b was moved to 12 s. */
function reopened(): LinkProject {
  const project = parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '第三首', enabled: true, notes: '',
    visualLayers: [{ id: 'cameras', name: '轨道 1', visible: true, locked: false }], cues: [camera('a', 2), camera('b', 8)] }] });
  return withContentTimeline(moveContentCommand('song', { kind: 'cue', id: 'b' }, 12_000, { track: 'cameras' })).execute(project);
}

/** The editor while 联动台播放 is at 12.5 s in the song (playing unless `status` says otherwise), `outdated` as
 * useInternalPlayer reports it. */
function editor(outdated: boolean | null, status: ProgramPlayerState['status'] = 'playing'): { html: string; parts: Map<string, string[]> } {
  const project = reopened();
  useDocumentStore.getState().setProject(project, 'C:/show/现场.tblink');
  const view = new PlayerViewStore();
  view.publish({ ...emptyInternalPlayerState, status, itemId: 'song', positionMs: 12_500, durationMs: 20_000 });
  const player: ProjectPlayer = { controller: null, state: view.readControl(), view, engine: '联动台播放', outdated };
  const html = renderToStaticMarkup(React.createElement(CueWorkspace, { player, playbackProject: project, sidebarHost: null, toolbarHost: null, syncHost: null,
    coordinator: null, notify: vi.fn(), documentActions: { canUndo: false, canRedo: false, disabled: true, onUndo: vi.fn(), onRedo: vi.fn(), onSave: vi.fn() } }));
  const parts = new Map([...html.matchAll(/<button[^>]* class="(timeline-(?:cue|clip)[^"]*)"[^>]*>.*?<span>([^<]+)<\/span>/g)]
    .map(([, classes, name]) => [name!, classes!.split(/\s+/).filter(Boolean)]));
  return { html, parts };
}

describe('编辑器按联动台播放接回的节目标时间线', () => {
  it('同一版：在播的机位 B 标正在播出，上方写播放中改画面的规则', () => {
    const { html, parts } = editor(false);
    expect(parts.get('机位 b')).toContain('is-active');
    expect(html).toContain('播放中改画面，停下重播才生效');
    expect(html).not.toContain('无法确认');
  });

  it('评审场景：界面重新加载后接回的节目是另一版：时间线上哪个都不标正在播出，上方写无法确认和原因', () => {
    const { html, parts } = editor(true);
    expect(parts.get('机位 b')).toBeDefined();
    expect([...parts.values()].flat()).not.toContain('is-active');
    expect([...parts.values()].flat()).not.toContain('is-pending');
    expect(html).toContain('无法确认 OBS 按哪一版时间线在播');
    expect(html).toContain('原因：界面重新加载过，联动台播放还在按重新加载前的工程播这首歌，和这里打开的不是同一版');
  });

  it('评审场景：后台已经发来“在播”、还没答复打开：先不标正在播出，上方写正在确认', () => {
    const { html, parts } = editor(null);
    expect(parts.get('机位 b')).toBeDefined();
    expect([...parts.values()].flat()).not.toContain('is-active');
    expect(html).toContain('无法确认 OBS 按哪一版时间线在播');
    expect(html).toContain('原因：正在确认联动台播放在播哪一版');
  });

  it('停止以后（播放器还记着这首歌）：编辑器用自己的播放头，不跟播放器的位置，也没有提示行', () => {
    for (const outdated of [false, true, null]) {
      const { html, parts } = editor(outdated, 'stopped');
      // The editor's own cursor is at 0 s, where nothing plays; at the player's 12.5 s camera b would.
      expect(parts.get('机位 b')).toBeDefined();
      expect([...parts.values()].flat()).not.toContain('is-active');
      expect(html).not.toContain('timeline-pending-notice');
    }
  });
});
