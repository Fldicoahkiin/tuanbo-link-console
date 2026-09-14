import type { VisualLayer } from '@tb/schema';
import { Eye, EyeOff, GripVertical, Lock, LockOpen, Trash2 } from 'lucide-react';
import type { PointerEvent } from 'react';

export function TimelineLayerHeading(props: {
  layer: VisualLayer;
  index: number;
  dragging: boolean;
  dropTarget: boolean;
  onDragBegin: (event: PointerEvent<HTMLElement>, layerId: string, index: number) => void;
  onDragMove: (event: PointerEvent<HTMLElement>) => void;
  onDragEnd: (event: PointerEvent<HTMLElement>) => void;
  onDragCancel: (event: PointerEvent<HTMLElement>) => void;
  onUpdateLayer: (layer: VisualLayer) => void;
  onDeleteLayer: (layerId: string) => void;
}): JSX.Element {
  return <div
    className={`track-heading visual-layer-heading ${props.layer.visible ? '' : 'is-hidden'} ${props.layer.locked ? 'is-locked' : ''} ${props.dragging ? 'is-dragging' : ''} ${props.dropTarget ? 'is-drop-target' : ''}`}
    style={{ order: 100 + props.index * 100 }}
    data-visual-layer-index={props.index}
    title={`拖动“时间线 ${props.index + 1}”整行调整上下顺序`}
    onPointerDown={(event) => props.onDragBegin(event, props.layer.id, props.index)}
    onPointerMove={props.onDragMove}
    onPointerUp={props.onDragEnd}
    onPointerCancel={props.onDragCancel}
  >
    <i className="layer-drag-handle" aria-hidden="true"><GripVertical /></i>
    <span className="layer-name" title={`时间线 ${props.index + 1} · ${props.index === 0 ? '最上层' : `自上而下第 ${props.index + 1} 层`}`}>{`时间线 ${props.index + 1}`}</span>
    <button type="button" title={props.layer.visible ? '隐藏图层' : '显示图层'} onPointerDown={(event) => event.stopPropagation()} onClick={() => props.onUpdateLayer({ ...props.layer, visible: !props.layer.visible })}>{props.layer.visible ? <Eye /> : <EyeOff />}</button>
    <button type="button" title={props.layer.locked ? '解锁图层' : '锁定图层'} onPointerDown={(event) => event.stopPropagation()} onClick={() => props.onUpdateLayer({ ...props.layer, locked: !props.layer.locked })}>{props.layer.locked ? <Lock /> : <LockOpen />}</button>
    <button type="button" title="删除空图层" onPointerDown={(event) => event.stopPropagation()} onClick={() => props.onDeleteLayer(props.layer.id)}><Trash2 /></button>
  </div>;
}
