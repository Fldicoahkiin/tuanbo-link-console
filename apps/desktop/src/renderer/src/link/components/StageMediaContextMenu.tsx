import type { LinkMediaAsset, ReferenceCanvasTransform, ReferenceMediaClip, SceneItemTransform } from '@tb/schema';
import { Crosshair, Layers3, Maximize, RotateCcw, Trash2 } from 'lucide-react';
import { centerMediaCanvasTransform, fitMediaCanvasTransform, originalMediaCanvasTransform } from './media-canvas-transform';
import type { ObsSourceSize } from './obs-source-geometry';

export function StageMediaContextMenu(props: {
  context: { clip: ReferenceMediaClip; asset: LinkMediaAsset; x: number; y: number };
  topLayerId: string | null;
  onClose: () => void;
  onTransform: (transform: ReferenceCanvasTransform) => void;
  onMoveToTop: () => void;
  onRemove: () => void;
}): JSX.Element {
  const sourceWidth = props.context.asset.width ?? 1080;
  const sourceHeight = props.context.asset.height ?? 1920;
  const run = (action: () => void): void => { props.onClose(); action(); };
  return <div className="resource-context-menu stage-media-context-menu" style={{ left: Math.min(props.context.x, window.innerWidth - 250), top: Math.min(props.context.y, window.innerHeight - 245) }} onPointerDown={(event) => event.stopPropagation()}>
    <button className="context-menu-item" onClick={() => run(() => props.onTransform(originalMediaCanvasTransform()))}><span className="context-icon"><RotateCcw /></span><span>原始大小</span></button>
    <button className="context-menu-item" onClick={() => run(() => props.onTransform(centerMediaCanvasTransform(props.context.clip.canvasTransform)))}><span className="context-icon"><Crosshair /></span><span>画布居中</span></button>
    <button className="context-menu-item" onClick={() => run(() => props.onTransform(fitMediaCanvasTransform(sourceWidth, sourceHeight)))}><span className="context-icon"><Maximize /></span><span>适应画布</span></button>
    <div className="context-separator" />
    <button className="context-menu-item" disabled={!props.topLayerId || props.context.clip.layerId === props.topLayerId} onClick={() => run(props.onMoveToTop)}><span className="context-icon"><Layers3 /></span><span>移到最顶图层</span></button>
    <div className="context-separator" />
    <button className="context-menu-item danger" onClick={() => run(props.onRemove)}><span className="context-icon"><Trash2 /></span><span>从时间线删除</span></button>
  </div>;
}

export function StageObsContextMenu(props: {
  context: { cueId: string; layerId: string; transform: SceneItemTransform | null; sourceSize: ObsSourceSize | null; canvasWidth: number; canvasHeight: number; x: number; y: number };
  topLayerId: string | null;
  onClose: () => void;
  onTransform: (transform: SceneItemTransform) => void;
  onMoveToTop: () => void;
  onRemove: () => void;
}): JSX.Element {
  const original = originalObsTransform(props.context.canvasWidth, props.context.canvasHeight);
  const current = props.context.transform ?? original;
  const fitScale = props.context.sourceSize
    ? Math.min(props.context.canvasWidth / props.context.sourceSize.width, props.context.canvasHeight / props.context.sourceSize.height)
    : null;
  const run = (action: () => void): void => { props.onClose(); action(); };
  return <div className="resource-context-menu stage-obs-context-menu" style={{ left: Math.min(props.context.x, window.innerWidth - 250), top: Math.min(props.context.y, window.innerHeight - 245) }} onPointerDown={(event) => event.stopPropagation()}>
    <button className="context-menu-item" onClick={() => run(() => props.onTransform(original))}><span className="context-icon"><RotateCcw /></span><span>原始大小</span></button>
    <button className="context-menu-item" onClick={() => run(() => props.onTransform({ ...current, positionX: props.context.canvasWidth / 2, positionY: props.context.canvasHeight / 2, alignment: 0 }))}><span className="context-icon"><Crosshair /></span><span>画布居中</span></button>
    <button className="context-menu-item" disabled={fitScale === null} onClick={() => { if (fitScale !== null) run(() => props.onTransform({ ...original, scaleX: fitScale, scaleY: fitScale })); }}><span className="context-icon"><Maximize /></span><span>适应画布</span></button>
    <div className="context-separator" />
    <button className="context-menu-item" disabled={!props.topLayerId || props.context.layerId === props.topLayerId} onClick={() => run(props.onMoveToTop)}><span className="context-icon"><Layers3 /></span><span>移到最顶图层</span></button>
    <div className="context-separator" />
    <button className="context-menu-item danger" onClick={() => run(props.onRemove)}><span className="context-icon"><Trash2 /></span><span>从时间线删除</span></button>
  </div>;
}

function originalObsTransform(canvasWidth: number, canvasHeight: number): SceneItemTransform {
  return { positionX: canvasWidth / 2, positionY: canvasHeight / 2, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, alignment: 0 };
}
