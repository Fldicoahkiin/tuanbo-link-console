import { useRef, useState, type PointerEvent } from 'react';
import type { ObsLiveEdit, ObsLiveItem, ObsLiveScene } from '@tb/schema';
import { obsItemBoxSize, obsItemCenter, resizeObsLiveItem } from './obs-live-geometry';

type Transform = ObsLiveItem['sceneItemTransform'];
type Direction = { x: number; y: number };
type Gesture = { sceneName: string; pointerId: number; x: number; y: number; original: Transform; item: ObsLiveItem; direction: Direction | null; latest: Transform };
const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

export function ObsLiveSelection(props: { scene: ObsLiveScene; selected: number | null; onSelect: (id: number | null) => void; onEdit: (edit: ObsLiveEdit, dragging: boolean) => void }): JSX.Element {
  const gesture = useRef<Gesture | null>(null);
  const [draft, setDraft] = useState<{ id: number; transform: Transform } | null>(null);
  const begin = (event: PointerEvent<HTMLElement>, item: ObsLiveItem, direction: Direction | null): void => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); props.onSelect(item.sceneItemId);
    if (item.sceneItemLocked) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { sceneName: props.scene.sceneName, pointerId: event.pointerId, x: event.clientX, y: event.clientY, original: item.sceneItemTransform, latest: item.sceneItemTransform, item, direction };
  };
  const payload = (current: Gesture): ObsLiveEdit => {
    const { positionX, positionY, scaleX, scaleY, boundsWidth, boundsHeight } = current.latest;
    return { sceneName: current.sceneName, sceneItemId: current.item.sceneItemId, transform: { positionX, positionY, scaleX, scaleY, ...(current.latest.boundsType === 'OBS_BOUNDS_NONE' ? {} : { boundsWidth, boundsHeight }) } };
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const frame = event.currentTarget.closest('.obs-live-canvas')?.getBoundingClientRect();
    if (!frame) return;
    const dx = (event.clientX - current.x) / frame.width * props.scene.width;
    const dy = (event.clientY - current.y) / frame.height * props.scene.height;
    current.latest = current.direction ? resizeObsLiveItem(current.original, current.direction, dx, dy, event.shiftKey)
      : { ...current.original, positionX: current.original.positionX + dx, positionY: current.original.positionY + dy };
    setDraft({ id: current.item.sceneItemId, transform: current.latest });
    props.onEdit(payload(current), true);
  };
  const end = (event: PointerEvent<HTMLElement>, cancel: boolean): void => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (cancel) current.latest = current.original;
    gesture.current = null; setDraft(null);
    props.onEdit(payload(current), false);
  };
  return <div className="obs-live-selection">{props.scene.items.filter((item) => item.sceneItemEnabled && item.sceneItemTransform.sourceWidth > 0 && item.sceneItemTransform.sourceHeight > 0).map((item) => {
    const t = draft?.id === item.sceneItemId ? draft.transform : item.sceneItemTransform;
    const center = obsItemCenter(t);
    const box = obsItemBoxSize(t);
    if (box.width === 0 || box.height === 0) return null;
    const selected = props.selected === item.sceneItemId;
    return <div key={`${props.scene.sceneName}:${item.sceneItemId}`} className={`obs-live-source ${selected ? 'is-selected' : ''}`} title={`${item.sourceName}${item.sceneItemLocked ? ' · 已锁定' : ''}`}
      style={{ left: `${center.x / props.scene.width * 100}%`, top: `${center.y / props.scene.height * 100}%`, width: `${Math.abs(box.width) / props.scene.width * 100}%`, height: `${Math.abs(box.height) / props.scene.height * 100}%`, transform: `translate(-50%,-50%) rotate(${t.rotation}deg)`, zIndex: item.sceneItemIndex + 1 }}
      onPointerDown={(event) => begin(event, item, null)} onPointerMove={move} onPointerUp={(event) => end(event, false)} onPointerCancel={(event) => end(event, true)} onLostPointerCapture={(event) => end(event, true)}>
      {selected && !item.sceneItemLocked ? handles.map((handle) => <i key={handle} className={`stage-media-handle ${handle}`} onPointerDown={(event) => begin(event, item, { x: handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0, y: handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0 })} />) : null}
    </div>;
  })}</div>;
}
