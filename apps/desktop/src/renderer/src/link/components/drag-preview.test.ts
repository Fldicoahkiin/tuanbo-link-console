import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkCue, type LinkProject } from '@tb/schema';
import { contentPlaceTaken, contentTrimBounds, resolveTimelineState, type ContentRef } from '@tb/core/link';
import { DragPreview, dragTarget, trackLayout, trimTarget, type DragViewport, type FrameScheduler, type ItemDragSnapshot, type TrackLayout } from './drag-preview';
import { DragSession, type DragHandle } from './drag-session';
import { timelineInteractionTime, timelineMoveSnapPoints } from './timeline-geometry';
import { timelineLayout } from './timeline-layout';
import { timelineItemDuration, timelineSnapPoints } from './timeline-snap-points';
import { timelineCueSpan } from './TimelineItems';

// The scene of ContentTracks.test.ts: camera a at 2 s and b at 8 s on 轨道 2, the caption from 8 s on 轨道 1, and a
// lighting row between the two tracks; the editor below a 28 px ruler and one sound row.
const at = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
const camera = (id: string, seconds: number): LinkCue => ({
  id, name: `机位 ${id}`, enabled: true, notes: '', timecode: at(seconds), durationMs: 2_000, layerId: 'cameras',
  actions: [{ id: `${id}-scene`, label: `切到 ${id}`, kind: 'obs.setProgramScene', sceneName: `机位 ${id}` }]
});
const caption: LinkCue = { id: 'caption', name: '字幕', enabled: true, notes: '', timecode: at(8), durationMs: 2_000, layerId: 'sources',
  actions: [{ id: 'caption-show', label: '显示字幕', kind: 'obs.setSceneItemEnabled', sceneName: '机位 a', sourceName: '字幕', enabled: true }] };
function song(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '第三首', enabled: true, notes: '',
    visualLayers: [{ id: 'sources', name: '轨道 1', visible: true, locked: false }, { id: 'cameras', name: '轨道 2', visible: true, locked: false }],
    cues: [camera('a', 2), camera('b', 8), caption] }] });
}

const DURATION_MS = 20_000;
const SNAP = { enabled: true, thresholdMs: 280 };
const VIEWPORT: DragViewport = { left: 200, top: 300, width: 1_000, height: 260, scrollLeft: 150, scrollTop: 40, pixelsPerSecond: 50 };
const LIGHTING_INDEX = 1;

/** The grid as the browser lays it out (timeline-layout.ts), and what lies at a point on screen, as `elementFromPoint`
 * and `closest('[data-visual-layer-id], [data-new-visual-layer]')` found it before E3: the sticky ruler over the
 * top, each row by its CSS order (ReferenceTimeline, ContentTracks, LightingTimeline), the dragged part left out. */
function elementTrack(project: LinkProject, clientX: number, clientY: number): string | null | undefined {
  const item = project.rundown[0]!;
  // The grid's rows: the ruler (28 px), the sound row (76), then the children by CSS `order`: tracks (50 px) at
  // 100 + 100·i, lighting (72) at 50 + 100·laneIndex, the new-track drop (the rest) last. undefined: no track there.
  const children: { order: number; height: number; track: string | null | undefined }[] = [{ order: 0, height: 28, track: undefined }, { order: 0, height: 76, track: undefined },
    ...item.visualLayers.map((layer, index) => ({ order: 100 + index * 100, height: 50, track: layer.id })),
    { order: 50 + LIGHTING_INDEX * 100, height: 72, track: undefined }, { order: 1_000_000, height: Number.POSITIVE_INFINITY, track: null }];
  const rows = children.map((child, index) => ({ ...child, index })).sort((a, b) => a.order - b.order || a.index - b.index);
  if (clientX < VIEWPORT.left || clientX >= VIEWPORT.left + VIEWPORT.width || clientY < VIEWPORT.top || clientY >= VIEWPORT.top + VIEWPORT.height) return undefined;
  const local = clientY - VIEWPORT.top;
  // The ruler is sticky: it covers the viewport's top whatever the scroll.
  if (local < 28) return undefined;
  let top = 0;
  const y = local + VIEWPORT.scrollTop;
  for (const row of rows) {
    if (y >= top && y < top + row.height) return row.track;
    top += row.height;
  }
  return undefined;
}

/** The drag as useTimelineItemDrag worked it out on every move before E3, with `elementFromPoint` for the track. */
function previousDrag(project: LinkProject, ref: ContentRef, originMs: number, grab: { x: number; y: number }, pointer: { x: number; y: number }, playheadMs: number) {
  const item = project.rundown[0]!;
  const timeAt = (x: number): number => Math.min(86_399_000, Math.max(0, (x - VIEWPORT.left + VIEWPORT.scrollLeft) / VIEWPORT.pixelsPerSecond * 1000));
  const grabOffsetMs = timeAt(grab.x) - originMs;
  const moved = Math.hypot(pointer.x - grab.x, pointer.y - grab.y) >= 4;
  const ms = timeAt(pointer.x) - grabOffsetMs;
  const state = resolveTimelineState(project, item, 0);
  const previewMs = moved ? timelineInteractionTime(ms, Math.max(DURATION_MS, ms), project.timebase.frameRate, SNAP.enabled,
    timelineMoveSnapPoints([0, DURATION_MS, ...timelineSnapPoints(state, item.cues, project.timebase.frameRate, playheadMs, ref)], timelineItemDuration({ clips: item.referenceMediaClips, cues: item.cues }, ref)), SNAP.thresholdMs) : originMs;
  const origin = item.cues.find(cue => cue.id === ref.id)?.layerId;
  const element = moved ? elementTrack(project, pointer.x, pointer.y) : undefined;
  const targetLayerId = element === undefined ? origin : element;
  const dropAbove = moved && typeof targetLayerId === 'string' && contentPlaceTaken(project, 'song', ref, previewMs, targetLayerId);
  return { previewMs, targetLayerId, dropAbove };
}

function snapshotFor(project: LinkProject, ref: ContentRef, originMs: number, grab: { x: number; y: number }): ItemDragSnapshot {
  const item = project.rundown[0]!;
  const layout = timelineLayout({ layers: item.visualLayers, referenceAudio: null, lighting: { document: { markers: [], tracks: [], laneIndex: LIGHTING_INDEX } } }, 2_000, 50, 50);
  const state = resolveTimelineState(project, item, 0);
  const cue = item.cues.find(entry => entry.id === ref.id)!;
  return {
    viewport: VIEWPORT, layout: trackLayout(item.visualLayers, layout.visualTracks), frameRate: project.timebase.frameRate, durationMs: DURATION_MS,
    snap: { ...SNAP, before: [0, DURATION_MS, 0], after: timelineSnapPoints(state, item.cues, project.timebase.frameRate, undefined, ref).slice(1), audio: [] },
    placeTaken: (part, startMs, layerId) => contentPlaceTaken(project, 'song', part, startMs, layerId), ref, originMs, itemDurationMs: cue.durationMs ?? 0,
    grabOffsetMs: (grab.x - VIEWPORT.left + VIEWPORT.scrollLeft) / VIEWPORT.pixelsPerSecond * 1000 - originMs,
    startClientX: grab.x, startClientY: grab.y, originLayerId: cue.layerId, layerMovable: true
  };
}

describe('拖动的落点：按帧算的和以前每次移动都算的一样', () => {
  const project = song();
  const ref = { kind: 'cue', id: 'b' } as const;
  const originMs = timelineCueSpan(project.rundown[0]!.cues[1]!, project.timebase.frameRate)!.startMs;
  // Camera b drawn at 8 s: x = 200 + 8·50 − 150 = 450; its track 轨道 2 below the ruler (28), the sound row (76), 轨道 1 (50) and lighting (72).
  const grab = { x: 460, y: 300 - 40 + 28 + 76 + 50 + 72 + 20 };

  it('整片指针位置上：目标轨道、时间、“放到上方新轨道”都和以前一样', () => {
    const snapshot = snapshotFor(project, ref, originMs, grab);
    let compared = 0;
    for (let y = 280; y <= 580; y += 7) for (let x = 180; x <= 1_220; x += 37) for (const playheadMs of [0, 6_120]) {
      const before = previousDrag(project, ref, originMs, grab, { x, y }, playheadMs);
      const moved = Math.hypot(x - grab.x, y - grab.y) >= 4;
      const now = dragTarget(snapshot, { clientX: x, clientY: y, moved, playheadMs });
      expect({ at: [x, y, playheadMs], startMs: now.startMs, layerId: now.layerId, taken: now.taken })
        .toEqual({ at: [x, y, playheadMs], startMs: before.previewMs, layerId: before.targetLayerId, taken: before.dropAbove });
      compared += 1;
    }
    expect(compared).toBeGreaterThan(1_000);
  });

  it('具体几处：拖到轨道 1 的字幕上要新建轨道，拖到下面的空白新建时间线，拖到灯光行和标尺上留在原轨道', () => {
    const snapshot = snapshotFor(project, ref, originMs, grab);
    const sourcesY = 300 - 40 + 28 + 76 + 20, lightingY = sourcesY + 50, newY = 300 - 40 + 28 + 76 + 50 + 72 + 50 + 10;
    const onCaption = dragTarget(snapshot, { clientX: grab.x, clientY: sourcesY, moved: true, playheadMs: 0 });
    expect(onCaption).toMatchObject({ layerId: 'sources', taken: true, startMs: 8_000 });
    expect(dragTarget(snapshot, { clientX: grab.x + 300, clientY: newY, moved: true, playheadMs: 0 }).layerId).toBeNull();
    expect(dragTarget(snapshot, { clientX: grab.x, clientY: lightingY, moved: true, playheadMs: 0 }).layerId).toBe('cameras');
    expect(dragTarget(snapshot, { clientX: grab.x, clientY: 310, moved: true, playheadMs: 0 }).layerId).toBe('cameras');
    // Over the track headings left of the viewport: no track, as before.
    expect(dragTarget(snapshot, { clientX: 150, clientY: sourcesY, moved: true, playheadMs: 0 }).layerId).toBe('cameras');
  });

  it('吸到 A 的尾巴时有吸附线，没动够 4 像素就留在原处', () => {
    const snapshot = snapshotFor(project, ref, originMs, grab);
    // b moved so its start meets a's end at 4 s: 4 s earlier is 200 px left.
    const snapped = dragTarget(snapshot, { clientX: grab.x - 205, clientY: grab.y, moved: true, playheadMs: 0 });
    expect(snapped.startMs).toBe(4_000);
    expect(snapped.snapMs).toBe(4_000);
    expect(dragTarget(snapshot, { clientX: grab.x + 2, clientY: grab.y, moved: false, playheadMs: 0 })).toMatchObject({ moved: false, startMs: originMs, layerId: 'cameras', snapMs: undefined });
  });

  it('修剪：按帧算的边和以前一样，3 像素以内不动', () => {
    const item = project.rundown[0]!;
    const state = resolveTimelineState(project, item, 0);
    const trim = { viewport: VIEWPORT, frameRate: project.timebase.frameRate, snap: { ...SNAP, before: [0], after: timelineSnapPoints(state, item.cues, project.timebase.frameRate, undefined, ref).slice(1) },
      edge: 'end' as const, startClientX: 550, originPointerMs: (550 - 200 + 150) / 50 * 1000, originStartMs: 8_000, originDurationMs: 2_000,
      bounds: contentTrimBounds(project, 'song', ref) };
    const span = { startMs: 8_000, durationMs: 2_000 };
    expect(trimTarget(trim, 552, 0, span)).toBe(span);
    expect(trimTarget(trim, 650, 0, span)).toEqual({ startMs: 8_000, durationMs: 4_000 });
  });
});

/** Frames a test runs by hand. */
function testFrames(): FrameScheduler & { run: () => void; waiting: () => number } {
  let queue = new Map<number, () => void>(), next = 1;
  return {
    request: (draw) => { queue.set(next, draw); return next++; },
    cancel: (frame) => { queue.delete(frame); },
    run: () => { const due = queue; queue = new Map(); for (const draw of due.values()) draw(); },
    waiting: () => queue.size
  };
}

function preview(frames: FrameScheduler, alive = { value: true }) {
  const worked: number[] = [], painted: number[] = [], told: number[] = [];
  let restored = 0;
  const drag = new DragPreview<number, number>({
    target: (x) => { worked.push(x); return Math.floor(x / 10); },
    alive: () => alive.value,
    paint: (result) => { painted.push(result); },
    restore: () => { restored += 1; },
    drawn: (result) => String(result),
    changed: (result) => { told.push(result); }
  }, 0, frames);
  return { drag, worked, painted, told, restored: () => restored };
}

describe('按帧合并', () => {
  it('一帧里移动几次只算一次，用最后一次的位置；结果没变不通知 React', () => {
    const frames = testFrames();
    const { drag, worked, painted, told } = preview(frames);
    drag.move(3); drag.move(5); drag.move(8);
    expect(frames.waiting()).toBe(1);
    expect(worked).toEqual([]);
    frames.run();
    expect(worked).toEqual([8]);
    expect(painted).toEqual([0]);
    expect(told).toEqual([]);
    drag.move(14); drag.move(27); frames.run();
    expect(worked).toEqual([8, 27]);
    expect(told).toEqual([2]);
  });

  it('松手时不等这一帧，用松手的位置马上算，之后不再写', () => {
    const frames = testFrames();
    const { drag, worked, painted, restored } = preview(frames);
    drag.move(12); drag.move(31);
    expect(drag.release(33)).toBe(3);
    expect(worked).toEqual([33]);
    expect(frames.waiting()).toBe(0);
    expect(restored()).toBe(1);
    drag.move(50); frames.run();
    expect(painted).toEqual([]);
  });

  it('被拖的东西没了：这一帧不再写，松手也不发命令', () => {
    const frames = testFrames();
    const alive = { value: true };
    const { drag, painted, restored } = preview(frames, alive);
    drag.move(12); frames.run();
    alive.value = false;
    drag.move(40); frames.run();
    expect(painted).toEqual([1]);
    expect(restored()).toBe(1);
    expect(drag.release(40)).toBeNull();
  });

  it('按 Esc 取消拖动以后不再写样式（DragSession 经按键路由取消，通知结束）', () => {
    const frames = testFrames();
    const { drag, painted, restored } = preview(frames);
    const router: { escape: (() => void) | null } = { escape: null };
    const view = { addEventListener: (): void => undefined, removeEventListener: (): void => undefined };
    const session = new DragSession<number>(view, (value) => { if (value === null) drag.stop(); }, { beginDrag: (entry) => { router.escape = entry.escape; return () => undefined; } });
    const handle: DragHandle = { setPointerCapture: () => undefined, hasPointerCapture: () => true, contains: () => true };
    session.begin(handle, 1, 0);
    drag.move(25);
    router.escape?.();
    frames.run();
    drag.move(40); frames.run();
    expect(painted).toEqual([]);
    expect(restored()).toBe(1);
    expect(drag.release(40)).toBeNull();
  });
});

it('轨道的位置从布局算：灯光行插在中间，标尺盖住视口顶部', () => {
  const layout: TrackLayout = trackLayout([{ id: 'a', locked: false }, { id: 'b', locked: true }], { start: 104, lightingIndex: 1, lightingHeight: 72, coveredTop: 28 });
  expect(layout.bands).toEqual([{ layerId: 'a', top: 104, bottom: 154, locked: false }, { layerId: 'b', top: 226, bottom: 276, locked: true }]);
  expect(layout.newTrackTop).toBe(276);
});
