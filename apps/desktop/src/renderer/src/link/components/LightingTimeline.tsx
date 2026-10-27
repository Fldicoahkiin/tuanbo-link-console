import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LightingTempoMap, nextLightingCue, nextLightingMaster, copyLightingEvents, copyLightingEventsAt, pasteLightingEvents, lightingClipSpan, lightingEventTime } from '@tb/core/link';
import type { LightingClip, LightingDocument, LightingTrack, LightingEvent, ReferenceAudio } from '@tb/schema';
import { GripVertical, Lock, LockOpen, Plus, Trash2, Volume2, VolumeX } from 'lucide-react';
import { useLightingClipboardStore } from '../stores/lighting-clipboard-store';
import { LightingMasterCurve } from './LightingMasterCurve';
import { masterCurveY } from './lighting-master-curve';

function groupStackedEvents(tracks: LightingTrack[], map: LightingTempoMap, pixelsPerSecond: number): Map<string, LightingEvent[]> {
  const result = new Map<string, LightingEvent[]>();
  const entries = tracks.flatMap(track => track.clips.flatMap(clip => clip.events.map(event => ({ event, ms: lightingEventTime(clip, event, map) })))).sort((a, b) => a.ms - b.ms);
  const groups = new Map<number, LightingEvent[]>();
  let anchor = -Infinity;
  for (const { event, ms } of entries) {
    const pixel = ms / 1000 * pixelsPerSecond;
    if (pixel - anchor >= 16) anchor = pixel;
    const group = groups.get(anchor) ?? []; group.push(event); groups.set(anchor, group);
  }
  for (const group of groups.values()) for (const event of group) result.set(event.id, group);
  return result;
}

export type LightingTimelineProps = {
  onCreateCue?: ((ms: number) => void) | undefined;
  onClearSelection?: () => void;
  onAuditionEvent?: (eventId: string) => void;
  snapTime?: (milliseconds: number, excludedEventId?: string) => number;
  document: LightingDocument;
  selectedClipId: string | null;
  selectedEventId?: string | null;
  selectedEventIds?: string[];
  onSelectEvent?: (trackId: string, clipId: string, eventId: string, eventIds?: string[]) => void;
  onError?: (message: string) => void;
  detailOpen?: boolean;
  onOpenTools?: (tool: import('./LightingTimelineTools').LightingTool) => void;
  preview?: boolean;
  onPreviewChange?: (enabled: boolean) => void;
  /** The song's MTC start, the same one the program sends; throws when the song's start is invalid. */
  mtcOrigin?: () => number;
  onSelect: (trackId: string, clipId: string | null) => void;
  onChange: (document: LightingDocument, label: string, automaticSource?: ReferenceAudio) => void;
};
export function LightingHeadings(props: LightingTimelineProps & { durationMs: number }): JSX.Element {
  const reorder = useRef<{ y: number; target: number } | null>(null);
  const [moving, setMoving] = useState(false);
  const [context, setContext] = useState<{ track: LightingTrack; x: number; y: number } | null>(null);
  const remove = (track: LightingTrack): void => { if (!track.locked) props.onChange({ ...props.document, tracks: props.document.tracks.filter((entry) => entry.id !== track.id) }, '删除灯光轨道'); setContext(null); };
  useEffect(() => {
    if (!context) return;
    const close = (): void => setContext(null);
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); };
  }, [context]);
  const update = (track: LightingTrack): void => props.onChange({ ...props.document, tracks: props.document.tracks.map((entry) => entry.id === track.id ? track : entry) }, '修改灯光轨道');
  return <>
    <div className="track-heading lighting-heading lighting-empty-heading" style={{ display: props.document.tracks.length ? 'none' : undefined, order: 50 + (props.document.laneIndex ?? 0) * 100 }}><button className="lighting-add-track" aria-label="添加灯光轨道" onClick={() => {
      const clip: LightingClip = { id: crypto.randomUUID(), name: '灯光编排', start: 0, duration: Math.max(1, props.durationMs), timeLock: 'time', events: [], muted: false };
      const track: LightingTrack = { id: crypto.randomUUID(), kind: 'ma2', name: '灯光', color: '#ba8fff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [clip] };
      props.onChange({ ...props.document, tracks: [...props.document.tracks, track] }, '添加灯光轨道'); props.onSelect(track.id, clip.id);
    }}><Plus />添加灯光轨道</button></div>
    {(props.document.tracks.length ? [props.document.tracks.find(track => track.clips.some(clip => clip.id === props.selectedClipId)) ?? props.document.tracks[0]!] : []).map((track) => <div className={`track-heading lighting-heading ${moving ? 'is-dragging' : ''}`} key="lighting" onContextMenu={(event) => { event.preventDefault(); setContext({ track, x: Math.min(event.clientX, window.innerWidth - 160), y: Math.min(event.clientY, window.innerHeight - 50) }); }} style={{ borderLeft: '3px solid var(--accent)', order: 50 + (props.document.laneIndex ?? 0) * 100 }}
      onPointerDown={(event) => { if (event.button !== 0 || track.locked || !(event.target as Element).closest('.lighting-track-name,.lighting-grip')) return; event.currentTarget.setPointerCapture(event.pointerId); reorder.current = { y: event.clientY, target: props.document.laneIndex ?? 0 }; }}
      onPointerMove={(event) => { if (!reorder.current) return; const rows = [...(event.currentTarget.parentElement?.querySelectorAll('.visual-layer-heading') ?? [])]; reorder.current.target = rows.filter((row) => { const rect = row.getBoundingClientRect(); return event.clientY > rect.top + rect.height / 2; }).length; if (Math.abs(event.clientY - reorder.current.y) > 4) setMoving(true); }}
      onPointerUp={(event) => { const current = reorder.current; reorder.current = null; setMoving(false); if (current && Math.abs(event.clientY - current.y) <= 4) props.onSelect(track.id, track.clips[0]?.id ?? null); if (current && Math.abs(event.clientY - current.y) > 4 && current.target !== (props.document.laneIndex ?? 0)) props.onChange({ ...props.document, laneIndex: current.target }, '移动灯光轨道位置'); }} onPointerCancel={() => { reorder.current = null; setMoving(false); }}>
      <button className="lighting-grip" aria-label="调整灯光轨道顺序" title="上下拖动调整位置"><GripVertical /></button>
      <button className="lighting-track-name" title={`当前来源：${track.name}`} onClick={() => props.onSelect(track.id, track.clips[0]?.id ?? null)}>{props.document.tracks.length === 1 ? track.name : '灯光'}</button>
      <button aria-label={`${track.name}静音`} aria-pressed={track.muted} onClick={() => update({ ...track, muted: !track.muted })}>{track.muted ? <VolumeX /> : <Volume2 />}</button>
      {props.document.tracks.length > 1 ? <button aria-label={`${track.name}独奏`} aria-pressed={track.solo} onClick={() => update({ ...track, solo: !track.solo })}>S</button> : null}
      <button aria-label={`${track.name}锁定`} aria-pressed={track.locked} onClick={() => update({ ...track, locked: !track.locked })}>{track.locked ? <Lock /> : <LockOpen />}</button>
      <button aria-label={`删除${track.name}轨道`} title="删除轨道" disabled={track.locked} onClick={() => remove(track)}><Trash2 /></button>
    </div>)}
    {context ? createPortal(<div className="resource-context-menu" style={{ position: 'fixed', left: context.x, top: context.y, zIndex: 10000 }} onPointerDown={(event) => event.stopPropagation()}><button disabled={context.track.locked} onClick={() => remove(context.track)}><Trash2 />删除灯光轨道</button></div>, document.body) : null}
  </>;
}
export function LightingLanes(props: LightingTimelineProps & { pixelsPerSecond: number; scrollLeft: number; viewportWidth: number; getPlaybackPosition?: () => number; playheadMs: number; onSeek: (ms: number) => void; timeAtClientX: (x: number) => number }): JSX.Element {
  const map = useMemo(() => new LightingTempoMap(props.document.tempos), [props.document.tempos]);
  const clipboard = useLightingClipboardStore((state) => state.clipboard);
  const [context, setContext] = useState<{ trackId: string; clipId: string; eventId: string | null; ms: number; x: number; y: number } | null>(null);
  useDismissLightingContext(Boolean(context), setContext);
  const activeTrack = props.document.tracks.find((entry) => entry.clips.some((clip) => clip.id === props.selectedClipId)) ?? props.document.tracks[0];
  const activeClip = activeTrack?.clips.find((entry) => entry.id === props.selectedClipId) ?? activeTrack?.clips.find((entry) => { const span = lightingClipSpan(entry, map); return props.playheadMs >= span.startMs && props.playheadMs < span.endMs; });
  const menuTrack = props.document.tracks.find((entry) => entry.id === context?.trackId);
  const menuClip = menuTrack?.clips.find((entry) => entry.id === context?.clipId);
  const menuEvent = menuClip?.events.find((entry) => entry.id === context?.eventId);
  const stackedEvents = useMemo(() => groupStackedEvents(props.document.tracks, map, props.pixelsPerSecond), [props.document.tracks, props.pixelsPerSecond, map]);
  const selectedStack = props.selectedEventId ? stackedEvents.get(props.selectedEventId) : undefined;
  const selectedIds = new Set(props.selectedEventIds ?? (props.selectedEventId ? [props.selectedEventId] : []));
  const menuIds = menuEvent && menuClip?.id === props.selectedClipId && selectedIds.has(menuEvent.id) ? selectedIds : new Set(menuEvent ? [menuEvent.id] : []);
  const marquee = useRef<{ clipId: string; start: number; x: number; ids: string[] } | null>(null);
  const suppressClick = useRef(false);
  const [range, setRange] = useState<{ clipId: string; start: number; end: number } | null>(null);
  const { drag, dragRef, setDrag } = useLightingPointDrag();
  const visibleEvents = useVisibleLightingEvents(props, map, drag);
  const select = (track: LightingTrack, clip: LightingClip, event: LightingEvent, additive: boolean): string[] => {
    const ids = additive && props.selectedClipId === clip.id ? new Set(selectedIds) : new Set<string>();
    if (additive && ids.has(event.id)) ids.delete(event.id); else ids.add(event.id);
    const primary = ids.has(event.id) ? event.id : [...ids].at(-1);
    if (primary) props.onSelectEvent?.(track.id, clip.id, primary, [...ids]); else props.onSelect(track.id, clip.id);
    if (!additive) props.onAuditionEvent?.(event.id);
    return [...ids];
  };
  const movedAt = (clip: LightingClip, event: LightingEvent, deltaMs: number): number => movedLightingTime(clip, event, deltaMs, map);
  const movedEvent = (clip: LightingClip, event: LightingEvent, current = drag): LightingEvent => {
    if (!current || current.clipId !== clip.id || !current.ids.includes(event.id)) return event;
    if (current.valueDrag) return event.kind === 'ma2-fader' ? { ...event, level: Number((event.level + current.deltaLevel).toFixed(3)) } : event;
    return { ...event, at: movedAt(clip, event, current.deltaMs) };
  };
  const changeClip = (track: LightingTrack, candidate: LightingClip, label: string): void => { const clip = { ...candidate, duration: candidate.events.reduce((end, event) => Math.max(end, event.at + (event.kind === 'note' ? event.duration : 0.001)), candidate.duration) }; props.onChange({ ...props.document, tracks: props.document.tracks.map((entry) => entry.id === track.id ? { ...track, clips: track.clips.map((entry) => entry.id === clip.id ? clip : entry) } : entry) }, label); };
  const copy = (track: LightingTrack, clip: LightingClip, ids: ReadonlySet<string>, cut = false): void => {
    if (cut && track.locked) return;
    const snapshot = copyLightingEvents(clip, ids);
    if (!snapshot) return;
    useLightingClipboardStore.getState().setClipboard(snapshot);
    if (cut) { changeClip(track, { ...clip, events: clip.events.filter((entry) => !ids.has(entry.id)) }, '剪切灯光点'); props.onSelect(track.id, clip.id); }
  };
  const paste = (track: LightingTrack, clip: LightingClip, ms: number): void => {
    if (!clipboard || track.locked || ms < lightingClipSpan(clip, map).startMs) return;
    const result = pasteLightingEvents(clip, clipboard, ms, map);
    const primary = result.pastedIds.at(-1);
    if (!primary) return;
    changeClip(track, result.clip, '粘贴灯光点');
    props.onSelectEvent?.(track.id, clip.id, primary, result.pastedIds);
    props.onSeek(ms);
  };
  const add = (track: LightingTrack, clip: LightingClip, positionMs: number, master = false): void => {
    const ms = props.snapTime?.(positionMs) ?? positionMs;     if (track.locked) return;
    if (!master && track.kind === 'ma2' && track.cueStamp?.mode === 'marker') {
      props.onChange({ ...props.document, markers: [...props.document.markers, { id: crypto.randomUUID(), name: `标记 ${props.document.markers.length + 1}`, startMs: ms, endMs: null }] }, '时间线打标记');
      return;
    }
    const at = (clip.timeLock === 'time' ? ms : map.msToBeat(ms)) - clip.start;
    if (at < 0) return;
    let added: LightingEvent;
    try {
      added = makeTimelineEvent(props.document, track, clip, ms, at, master);
    } catch (error) {
      props.onError?.(error instanceof Error ? error.message : String(error));
      return;
    }
    changeClip(track, { ...clip, events: [...clip.events, added] }, '灯光时间线打点');
    props.onSelectEvent?.(track.id, clip.id, added.id);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.code === 'Escape') { setDrag(null); marquee.current = null; setRange(null); }
      if (event.defaultPrevented || context || props.detailOpen || event.repeat || event.altKey || event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      const track = activeTrack; const clip = activeClip;
      if (!track || !clip) return;
      if (event.ctrlKey || event.metaKey) {
        if (props.selectedClipId !== clip.id) return;
        if (event.code === 'KeyA' && props.selectedClipId === clip.id && clip.events.length) { event.preventDefault(); props.onSelectEvent?.(track.id, clip.id, clip.events.at(-1)!.id, clip.events.map((entry) => entry.id)); }
        if (event.code === 'KeyC' || event.code === 'KeyX') { event.preventDefault(); copy(track, clip, selectedIds, event.code === 'KeyX'); }
        if (event.code === 'KeyV') { event.preventDefault(); paste(track, clip, props.playheadMs); }
        return;
      }
      if (track.locked) return;
      if (!document.querySelector('.lighting-workbench') && event.code === 'KeyM') { event.preventDefault(); add(track, clip, props.getPlaybackPosition?.() ?? props.playheadMs); }
      if ((event.code === 'Delete' || event.code === 'Backspace') && props.selectedEventId) { event.preventDefault(); changeClip(track, { ...clip, events: clip.events.filter((entry) => !selectedIds.has(entry.id)) }, '删除灯光点'); props.onSelect(track.id, clip.id); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });
  return <>
    {!props.document.tracks.length ? <div className="timeline-lane lighting-empty-lane" style={{ order: 50 + (props.document.laneIndex ?? 0) * 100 }} /> : null}
    {activeTrack ? <div className="timeline-lane lighting-lane lighting-combined-lane" aria-label="灯光时间线" style={{ order: 50 + (props.document.laneIndex ?? 0) * 100 }} onClick={(event) => { if (event.target === event.currentTarget) { props.onSeek(props.snapTime?.(props.timeAtClientX(event.clientX)) ?? props.timeAtClientX(event.clientX)); props.onSelect(activeTrack.id, null); } }} onDoubleClick={(event) => {
      const track = activeTrack;
      if (track.locked || event.target !== event.currentTarget) return;
      const start = Math.max(0, props.timeAtClientX(event.clientX));
      const previous = track.clips.find((entry) => lightingClipSpan(entry, map).startMs <= start);
      if (previous) { add(track, previous, start); return; }
      const clip: LightingClip = { id: crypto.randomUUID(), name: track.name, start, duration: 8000, timeLock: 'time', events: [], muted: false };
      props.onChange({ ...props.document, tracks: props.document.tracks.map((entry) => entry.id === track.id ? { ...track, clips: [...track.clips, clip] } : entry) }, '添加灯光片段'); props.onSelect(track.id, clip.id);
    }}>
      {props.document.tracks.flatMap(track => track.clips.map((clip) => {
        const previewDuration = drag?.clipId === clip.id ? clip.events.reduce((end, entry) => drag.ids.includes(entry.id) ? Math.max(end, movedAt(clip, entry, drag.deltaMs) + (entry.kind === 'note' ? entry.duration : 0.001)) : end, clip.duration) : clip.duration;
        const span = lightingClipSpan({ ...clip, duration: previewDuration }, map);
        return <div key={clip.id} role="group" aria-label={`${track.name}时间线片段`} data-active={activeClip?.id === clip.id} className={`lighting-clip ${props.selectedClipId === clip.id ? 'selected' : ''} ${track.muted || clip.muted ? 'is-muted' : ''}`} style={{ left: span.startMs / 1000 * props.pixelsPerSecond, width: Math.max(12, (span.endMs - span.startMs) / 1000 * props.pixelsPerSecond), '--lighting-color': track.color } as React.CSSProperties}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); const id = (event.target as Element).closest<HTMLElement>('[data-lighting-event]')?.dataset.lightingEvent ?? null; if (id && (props.selectedClipId !== clip.id || !selectedIds.has(id))) props.onSelectEvent?.(track.id, clip.id, id, [id]); if (!id) props.onSelect(track.id, clip.id); setContext({ trackId: track.id, clipId: clip.id, eventId: id, ms: props.timeAtClientX(event.clientX), x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 140) }); }}
          onPointerDown={(input) => { if (input.button !== 0 || (input.target as Element).closest('[data-lighting-event]')) return; input.stopPropagation(); input.currentTarget.setPointerCapture(input.pointerId); suppressClick.current = false; marquee.current = { clipId: clip.id, start: props.timeAtClientX(input.clientX), x: input.clientX, ids: (input.ctrlKey || input.metaKey || input.shiftKey) && props.selectedClipId === clip.id ? [...selectedIds] : [] }; }}
          onPointerMove={(input) => { const current = marquee.current; if (!current || current.clipId !== clip.id || Math.abs(input.clientX - current.x) < 4) return; setRange({ clipId: clip.id, start: current.start, end: props.timeAtClientX(input.clientX) }); }}
          onPointerUp={(input) => { const current = marquee.current; if (!current || current.clipId !== clip.id) return; input.currentTarget.releasePointerCapture(input.pointerId); if (range) { const end = props.timeAtClientX(input.clientX); const ids = new Set(current.ids); for (const entry of clip.events) { const ms = lightingEventTime(clip, entry, map); if (ms >= Math.min(current.start, end) && ms <= Math.max(current.start, end)) ids.add(entry.id); } const primary = [...ids].at(-1); if (primary) props.onSelectEvent?.(track.id, clip.id, primary, [...ids]); else props.onSelect(track.id, clip.id); suppressClick.current = true; } marquee.current = null; setRange(null); }}
          onPointerCancel={() => { marquee.current = null; setRange(null); }}
          onClick={(event) => { event.stopPropagation(); if (suppressClick.current) { suppressClick.current = false; return; } props.onSelect(track.id, clip.id); props.onSeek(props.snapTime?.(props.timeAtClientX(event.clientX)) ?? props.timeAtClientX(event.clientX)); }}
          onDoubleClick={(event) => { event.stopPropagation(); add(track, clip, props.timeAtClientX(event.clientX)); }}>
          {!clip.events.length && activeTrack.id === track.id ? <span className="lighting-clip-caption">双击打点 · M</span> : null}
          {props.selectedClipId === clip.id ? <LightingMasterCurve clip={clip} map={map} pixelsPerSecond={props.pixelsPerSecond} scrollLeft={props.scrollLeft} viewportWidth={props.viewportWidth} previewEvent={movedEvent} /> : null}
          {range?.clipId === clip.id ? <span className="lighting-marquee" style={{ position: 'absolute', pointerEvents: 'none', top: 0, bottom: 0, left: (Math.min(range.start, range.end) - span.startMs) / 1000 * props.pixelsPerSecond, width: Math.abs(range.end - range.start) / 1000 * props.pixelsPerSecond, background: 'rgb(74 155 255 / 16%)', border: '1px solid var(--accent)' }} /> : null}
          {(visibleEvents.get(clip.id) ?? []).map((stored) => {
            const event = movedEvent(clip, stored);
            const ms = lightingEventTime(clip, event, map);
            const stack = stackedEvents.get(stored.id) ?? [stored];
            const foreground = stack === selectedStack ? props.selectedEventId : stack[0]?.id;
            const covered = stack.length > 1 && foreground !== event.id && drag?.event.id !== event.id;
            if (covered) return null;
            return <button key={event.id} data-lighting-event={event.id} className={`lighting-timeline-point ${selectedIds.has(event.id) ? 'selected' : ''}`} aria-pressed={selectedIds.has(event.id)} aria-label={`灯光点 ${event.kind === 'ma2' ? event.label : event.kind === 'ma2-fader' ? `Master ${Number((event.level * 100).toFixed(6))}%` : event.kind}`} title={`${event.kind === 'ma2' ? `${event.label}${event.action === 'goto' ? ` · Cue ${event.cue}` : ''}` : event.kind === 'ma2-fader' ? `${event.label} · Alt 上下拖动调节百分比` : '灯光事件'} · ${(ms / 1000).toFixed(3)} 秒 · Ctrl 点击多选，拖动调整`} style={{ left: (ms - span.startMs) / 1000 * props.pixelsPerSecond }}
              onClick={(input) => { input.stopPropagation(); if (input.detail === 0) select(track, clip, stored, input.ctrlKey || input.metaKey || input.shiftKey); props.onSeek(ms); }} onDoubleClick={(input) => input.stopPropagation()}
              onPointerDown={(input) => { input.stopPropagation(); if (input.button !== 0) return; const additive = input.ctrlKey || input.metaKey || input.shiftKey; if (track.locked) { select(track, clip, stored, additive); return; } const ids = !additive && selectedIds.has(event.id) ? [...selectedIds] : select(track, clip, stored, additive); if (!ids.includes(event.id)) return; input.currentTarget.setPointerCapture(input.pointerId); setDrag({ trackId: track.id, clipId: clip.id, event: stored, at: stored.at, x: input.clientX, y: input.clientY, valueDrag: input.altKey && stored.kind === 'ma2-fader', deltaLevel: 0, ids, deltaMs: 0 }); }}
              onPointerMove={(input) => {
                const drag = dragRef.current;
                if (!drag || drag.event.id !== event.id) return;
                if (drag.valueDrag) { setDrag({ ...drag, deltaLevel: masterDragDelta(clip, drag.ids, drag.y - input.clientY) }); return; }
                const earliest = Math.min(...clip.events.filter((entry) => drag.ids.includes(entry.id)).map((entry) => lightingEventTime(clip, entry, map)));
                const originMs = lightingEventTime(clip, drag.event, map);                 const targetMs = originMs + (input.clientX - drag.x) / props.pixelsPerSecond * 1000;                 const deltaMs = Math.max(lightingClipSpan(clip, map).startMs - earliest, (props.snapTime?.(targetMs) ?? targetMs) - originMs);
                setDrag({ ...drag, deltaMs, at: movedAt(clip, drag.event, deltaMs) });
              }}
              onPointerUp={(input) => { const current = dragRef.current; setDrag(null); if (!current || current.event.id !== event.id) return; input.currentTarget.releasePointerCapture(input.pointerId); if (current.deltaMs !== 0 || current.deltaLevel !== 0) { changeClip(track, { ...clip, events: clip.events.map((entry) => movedEvent(clip, entry, current)) }, current.valueDrag ? '调整主推杆值' : '移动灯光点'); if (!current.valueDrag) props.onSeek(lightingEventTime(clip, { ...stored, at: current.at }, map)); } else if (!input.ctrlKey && !input.metaKey && !input.shiftKey) select(track, clip, stored, false); }} onPointerCancel={() => setDrag(null)} onLostPointerCapture={() => setDrag(null)}>
              <i />{event.kind === 'ma2-fader' ? <b className="lighting-master-handle" style={{ top: masterCurveY(event.level) - 8 }} /> : null}<span className="lighting-point-label">{event.kind === 'ma2' ? event.cue ?? String(clip.events.findIndex(entry => entry.id === event.id) + 1) : event.kind === 'ma2-fader' ? `Master ${Number((event.level * 100).toFixed(6))}%` : event.kind === 'note' ? String(event.note) : event.kind === 'point' || event.kind === 'cc' ? String(event.value) : '事件'}</span>{stack.length > 1 ? <small title="此处有多个灯光点，放大或右键选择">+{stack.length - 1}</small> : null}
            </button>;
          })}
        </div>;
      }))}
    </div> : null}
    {context && menuTrack && menuClip ? createPortal(<div className="resource-context-menu lighting-point-menu" style={{ position: 'fixed', left: context.x, top: Math.min(context.y, Math.max(8, window.innerHeight - 280)), maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', zIndex: 10000 }} onPointerDown={(event) => event.stopPropagation()}>
      {menuEvent && (stackedEvents.get(menuEvent.id)?.length ?? 0) > 1 ? stackedEvents.get(menuEvent.id)?.map((entry) => <button key={entry.id} onClick={() => { for (const track of props.document.tracks) { const clip = track.clips.find(value => value.events.some(event => event.id === entry.id)); if (clip) { props.onSelectEvent?.(track.id, clip.id, entry.id); props.onSeek(lightingEventTime(clip, entry, map)); break; } } setContext(null); }}>选中：{entry.kind === 'ma2' ? entry.label : entry.kind === 'note' ? `音符 ${entry.note}` : '控制事件'}</button>) : null}
      <button disabled={menuTrack.locked} onClick={() => { add(menuTrack, menuClip, context.ms); props.onSeek(context.ms); setContext(null); }}>在这里打点</button>
      {menuTrack.kind === 'ma2' ? <button disabled={menuTrack.locked} onClick={() => { add(menuTrack, menuClip, context.ms, true); props.onSeek(context.ms); setContext(null); }}>添加主推杆点</button> : null}
      {menuEvent ? <><button onClick={() => { copy(menuTrack, menuClip, menuIds); setContext(null); }}>复制灯光点 <kbd>Ctrl+C</kbd></button><button disabled={menuTrack.locked} onClick={() => { copy(menuTrack, menuClip, menuIds, true); setContext(null); }}>剪切灯光点 <kbd>Ctrl+X</kbd></button></> : null}
      <button disabled={!clipboard || menuTrack.locked || context.ms < lightingClipSpan(menuClip, map).startMs} onClick={() => { paste(menuTrack, menuClip, context.ms); setContext(null); }}>粘贴到这里 <kbd>Ctrl+V</kbd></button>
      {menuEvent ? <><button disabled={menuTrack.locked || props.playheadMs < lightingClipSpan(menuClip, map).startMs} onClick={() => {
        const at = (menuClip.timeLock === 'time' ? props.playheadMs : map.msToBeat(props.playheadMs)) - menuClip.start;
        const copied = copyLightingEventsAt(menuClip, menuIds, at);
        changeClip(menuTrack, copied.clip, '复制灯光点');
        const primary = copied.copiedIds.at(-1);
        if (primary) props.onSelectEvent?.(menuTrack.id, menuClip.id, primary, copied.copiedIds);
        setContext(null);
      }}>{menuIds.size > 1 ? `复制 ${menuIds.size} 个点到播放头` : '复制到播放头'}</button><button disabled={menuTrack.locked} onClick={() => { changeClip(menuTrack, { ...menuClip, events: menuClip.events.filter((entry) => !menuIds.has(entry.id)) }, '删除灯光点'); props.onSelect(menuTrack.id, menuClip.id); setContext(null); }}>{menuIds.size > 1 ? `删除 ${menuIds.size} 个灯光点` : '删除灯光点'}</button></> : null}
      {!menuEvent ? <button disabled={menuTrack.locked} onClick={() => { props.onChange({ ...props.document, tracks: props.document.tracks.map((track) => track.id === menuTrack.id ? { ...track, clips: track.clips.filter((clip) => clip.id !== menuClip.id) } : track) }, '删除灯光片段'); props.onSelect(menuTrack.id, null); setContext(null); }}>删除灯光片段</button> : null}</div>, document.body) : null}
  </>;
}

function useVisibleLightingEvents(props: LightingTimelineProps & { scrollLeft: number; pixelsPerSecond: number; viewportWidth: number }, map: LightingTempoMap, drag: { ids: string[]; event: LightingEvent; clipId: string; deltaMs: number } | null): Map<string, LightingEvent[]> {
  return useMemo(() => {
    const result = new Map<string, LightingEvent[]>();
    const startMs = (props.scrollLeft - 160) / props.pixelsPerSecond * 1000;
    const endMs = (props.scrollLeft + props.viewportWidth + 160) / props.pixelsPerSecond * 1000;
    const movingIds = new Set(drag?.ids ?? []);
    for (const track of props.document.tracks) for (const clip of track.clips) {
      result.set(clip.id, clip.events.filter((event) => {
        // Keep the captured pointer's element mounted even beyond the viewport.
        if (event.id === drag?.event.id) return true;
        const ms = lightingEventTime(clip, event, map) + (clip.id === drag?.clipId && movingIds.has(event.id) ? drag.deltaMs : 0);
        return ms >= startMs && ms <= endMs;
      }));
    }
    return result;
  }, [props.document.tracks, props.scrollLeft, props.viewportWidth, props.pixelsPerSecond, map, drag]);
}

function makeTimelineEvent(document: LightingDocument, track: LightingTrack, clip: LightingClip, ms: number, at: number, master: boolean): LightingEvent {
  const base = { id: crypto.randomUUID(), at };
  if (master) return { ...base, kind: 'ma2-fader', ...nextLightingMaster(document, track, ms) };
  if (track.kind === 'ma2') return { ...base, kind: 'ma2', ...nextLightingCue(document, track, ms), action: 'goto' };
  if (track.kind === 'automation') return { ...base, kind: 'point', value: 127, shape: 'linear' };
  return { ...base, kind: 'note', note: 60, velocity: 127, duration: clip.timeLock === 'time' ? 200 : 0.25 };
}

function masterDragDelta(clip: LightingClip, ids: string[], pixels: number): number {
  const selected = new Set(ids);
  const levels = clip.events.flatMap((event) => event.kind === 'ma2-fader' && selected.has(event.id) ? [event.level] : []);
  return levels.length ? Math.max(-Math.min(...levels), Math.min(1 - Math.max(...levels), Math.round(pixels) / 1000)) : 0;
}

function movedLightingTime(clip: LightingClip, event: LightingEvent, deltaMs: number, map: LightingTempoMap): number {
  const ms = Math.max(0, lightingEventTime(clip, event, map) + deltaMs);
  return Math.max(0, (clip.timeLock === 'time' ? ms : map.msToBeat(ms)) - clip.start);
}

type PointDrag = { trackId: string; clipId: string; event: LightingEvent; at: number; x: number; y: number; valueDrag: boolean; deltaLevel: number; ids: string[]; deltaMs: number };

function useLightingPointDrag() {
  const [drag, setDragState] = useState<PointDrag | null>(null);
  const dragRef = useRef<PointDrag | null>(null);
  const setDrag = (value: PointDrag | null): void => { dragRef.current = value; setDragState(value); };
  useEffect(() => {
    const cancel = (): void => { dragRef.current = null; setDragState(null); };
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('blur', cancel); };
  }, []);
  return { drag, dragRef, setDrag };
}

function useDismissLightingContext(open: boolean, dismiss: (value: null) => void): void {
  useEffect(() => {
    if (!open) return;
    const close = (): void => dismiss(null);
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', key); window.addEventListener('blur', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); window.removeEventListener('blur', close); };
  }, [open, dismiss]);
}
