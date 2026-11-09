import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { createLightingDocument, lightingTrackSchema } from '@tb/schema';
import { WaveformCuePoints } from './WaveformCuePoints';

// The renderer's TSX compiles to React.createElement here.
vi.stubGlobal('React', React);
/** The drag the Cue points draw: set by each test, as the real drag session (drag-session.test.ts) would. */
const held = vi.hoisted(() => ({ drag: null as { id: string; x: number; ms: number; target: number; snapped: boolean } | null }));
vi.mock('./useDragSession', () => ({
  useDragSession: () => ({ drag: held.drag, current: () => held.drag, begin: () => undefined, update: () => undefined, end: () => undefined })
}));

/** One Cue point, at 30 s, on a song of a minute. */
function lighting() {
  const document = createLightingDocument();
  document.tracks = [lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: 'effect-canvas', muted: false, solo: false, locked: false,
    channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 60_000, timeLock: 'time', muted: false,
      events: [{ id: 'point', kind: 'ma2', action: 'goto', at: 30_000, cue: '1.000', sequence: 1, executor: '1.101', label: '第一步' }] }] })];
  return { document, selectedClipId: null, onSelect: vi.fn(), onChange: vi.fn() };
}

/** The Cue points drawn with the timeline scrolled to `scrollLeft` (100 px a second, 1000 px on screen): each one's left edge. */
function drawn(scrollLeft: number): string[] {
  const html = renderToStaticMarkup(React.createElement(WaveformCuePoints, { mode: 'seek', height: 120, lighting: lighting(), frameRate: '25', pixelsPerSecond: 100, top: 0,
    scrollLeft, viewportWidth: 1_000, durationMs: 60_000, disabled: false }));
  return [...html.matchAll(/<button class="waveform-cue-point" data-cue-id="point"[^>]* style="left:([^;"]+)/g)].map(([, left]) => left!);
}

it('拖着的 Cue 点拖出看得见的范围也照样画着：它握着指针，被裁掉的话松手时移动就悄悄丢了（0.5.9）', () => {
  held.drag = null;
  expect(drawn(2_500)).toEqual(['3000px']);
  // Not dragged and far out of view: left out, as before.
  expect(drawn(10_000)).toEqual([]);

  // Dragged from 30 s back to 1 s while the view stays at 25 s to 35 s.
  held.drag = { id: 'point', x: 3_000, ms: 30_000, target: 1_000, snapped: false };
  expect(drawn(2_500)).toEqual(['100px']);
  // And past the right edge, with the view at the start of the song.
  held.drag = { id: 'point', x: 3_000, ms: 30_000, target: 59_000, snapped: false };
  expect(drawn(0)).toEqual(['5900px']);
});
