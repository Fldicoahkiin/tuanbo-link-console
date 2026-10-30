import type { LinkMediaAsset, ReferenceCanvasTransform, ReferenceMediaClip, SceneItemTransform } from '@tb/schema';
import { Crosshair, Layers3, Maximize, RotateCcw, Trash2 } from 'lucide-react';
import { Menu, MenuItem, MenuSeparator } from '../ui';
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
  return <Menu x={props.context.x} y={props.context.y} label="画面素材菜单" title={props.context.clip.label} onClose={props.onClose}>
    <MenuItem icon={RotateCcw} onSelect={() => run(() => props.onTransform(originalMediaCanvasTransform()))}>原始大小</MenuItem>
    <MenuItem icon={Crosshair} onSelect={() => run(() => props.onTransform(centerMediaCanvasTransform(props.context.clip.canvasTransform)))}>画布居中</MenuItem>
    <MenuItem icon={Maximize} onSelect={() => run(() => props.onTransform(fitMediaCanvasTransform(sourceWidth, sourceHeight)))}>适应画布</MenuItem>
    <MenuSeparator />
    <MenuItem icon={Layers3} disabled={!props.topLayerId || props.context.clip.layerId === props.topLayerId} onSelect={() => run(props.onMoveToTop)}>移到最顶图层</MenuItem>
    <MenuSeparator />
    <MenuItem icon={Trash2} danger onSelect={() => run(props.onRemove)}>从时间线删除</MenuItem>
  </Menu>;
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
  return <Menu x={props.context.x} y={props.context.y} label="OBS 画面菜单" onClose={props.onClose}>
    <MenuItem icon={RotateCcw} onSelect={() => run(() => props.onTransform(original))}>原始大小</MenuItem>
    <MenuItem icon={Crosshair} onSelect={() => run(() => props.onTransform({ ...current, positionX: props.context.canvasWidth / 2, positionY: props.context.canvasHeight / 2, alignment: 0 }))}>画布居中</MenuItem>
    <MenuItem icon={Maximize} disabled={fitScale === null} onSelect={() => { if (fitScale !== null) run(() => props.onTransform({ ...original, scaleX: fitScale, scaleY: fitScale })); }}>适应画布</MenuItem>
    <MenuSeparator />
    <MenuItem icon={Layers3} disabled={!props.topLayerId || props.context.layerId === props.topLayerId} onSelect={() => run(props.onMoveToTop)}>移到最顶图层</MenuItem>
    <MenuSeparator />
    <MenuItem icon={Trash2} danger onSelect={() => run(props.onRemove)}>从时间线删除</MenuItem>
  </Menu>;
}

function originalObsTransform(canvasWidth: number, canvasHeight: number): SceneItemTransform {
  return { positionX: canvasWidth / 2, positionY: canvasHeight / 2, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, alignment: 0 };
}
