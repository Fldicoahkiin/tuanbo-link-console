import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkCue, type LinkProject } from '@tb/schema';
import { moveContentCommand, SceneOutputTimeline, TimelineStateIndex, withContentTimeline } from '@tb/core/link';
import { ContentTracks, contentEditRules, type ContentTracksProps } from './ContentTracks';
import type { Airtime } from './timeline-air';
import { EditorPlayhead } from './editor-playhead';

// The renderer's TSX compiles to React.createElement here; the desktop bridge needs a window.
vi.stubGlobal('React', React);
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));

const at = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
const camera = (id: string, seconds: number): LinkCue => ({
  id, name: `机位 ${id}`, enabled: true, notes: '', timecode: at(seconds), durationMs: 2_000, layerId: 'cameras',
  actions: [{ id: `${id}-scene`, label: `切到 ${id}`, kind: 'obs.setProgramScene', sceneName: `机位 ${id}` }]
});
/** An older “显示来源” cue, shown at the playhead (9 s). */
const caption: LinkCue = { id: 'caption', name: '字幕', enabled: true, notes: '', timecode: at(8), durationMs: 2_000, layerId: 'sources',
  actions: [{ id: 'caption-show', label: '显示字幕', kind: 'obs.setSceneItemEnabled', sceneName: '机位 a', sourceName: '字幕', enabled: true }] };
/** The song as 联动台播放 started it: camera a at 2 s, camera b at 8 s, the caption from 8 s. */
function started(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '第三首', enabled: true, notes: '',
    visualLayers: [{ id: 'sources', name: '轨道 1', visible: true, locked: false }, { id: 'cameras', name: '轨道 2', visible: true, locked: false }],
    cues: [camera('a', 2), camera('b', 8), caption] }] });
}

/** Each part's classes on the tracks, by the name it shows. */
function drawn(project: LinkProject, onAirtime: Airtime | null, pending: ReadonlySet<string>): Map<string, string[]> {
  const item = project.rundown[0]!;
  const props: ContentTracksProps = {
    layers: item.visualLayers, clips: item.referenceMediaClips, cues: item.cues, assets: new Map(), frameRate: project.timebase.frameRate, durationMs: 20_000,
    playhead: new EditorPlayhead(9_000), timelineState: new TimelineStateIndex(project, item).at(9_000), airtime: new SceneOutputTimeline(project, 'song').airtime(), onAirtime, pending,
    selectedClipId: null, selectedCueId: null, audioSnapPoints: [], rules: contentEditRules(project, 'song'),
    viewport: { viewportRef: { current: null }, pixelsPerSecond: 50, scrollLeft: 0, scrollTop: 0, viewportWidth: 2_000, viewportHeight: 600, timeAtClientX: () => 0 },
    tracks: { start: 0, lightingIndex: item.visualLayers.length, lightingHeight: 0, coveredTop: 0 }, snap: { enabled: false, thresholdMs: 0 }, lanePointer: {},
    focusTimeline: vi.fn(), onOpenMenu: vi.fn(), onSelectClip: vi.fn(), onSelectCue: vi.fn(), onMoveClip: vi.fn(), onMoveCue: vi.fn(), onTrim: vi.fn(),
    onDropAsset: vi.fn(), onDropObsResource: vi.fn()
  };
  const html = renderToStaticMarkup(React.createElement(ContentTracks, props));
  return new Map([...html.matchAll(/<button[^>]* class="(timeline-(?:cue|clip)[^"]*)"[^>]*>.*?<span>([^<]+)<\/span>/g)]
    .map(([, classes, name]) => [name!, classes!.split(/\s+/).filter(Boolean)]));
}

describe('时间线上的“正在播出”和“停下重播才生效”', () => {
  it('播放中挪走机位 B：OBS 还在播 B，但时间线上 B 标等重播，不标正在播出；显示着的字幕照常标', () => {
    const playing = started();
    const editing = withContentTimeline(moveContentCommand('song', { kind: 'cue', id: 'b' }, 12_000, { track: 'cameras' })).execute(playing);
    const parts = drawn(editing, new SceneOutputTimeline(playing, 'song').airtime(), new Set(['cue:b']));
    expect(parts.get('机位 b')).toContain('is-pending');
    expect(parts.get('机位 b')).not.toContain('is-active');
    expect(parts.get('字幕')).toContain('is-active');
    expect(parts.get('机位 a')).not.toContain('is-active');
  });

  it('不在播的时候按时间线本身标：播放头处的机位和字幕都标正在播出', () => {
    const project = started();
    const parts = drawn(project, new SceneOutputTimeline(project, 'song').airtime(), new Set());
    expect(parts.get('机位 b')).toContain('is-active');
    expect(parts.get('字幕')).toContain('is-active');
    expect([...parts.values()].flat()).not.toContain('is-pending');
  });

  it('无法确认 OBS 按哪一版在播：哪个都不标正在播出，显示着的字幕也不标', () => {
    const parts = drawn(started(), null, new Set());
    expect(parts.size).toBe(3);
    expect([...parts.values()].flat()).not.toContain('is-active');
  });
});
