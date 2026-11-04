import type { LinkMediaAsset, ReferenceCanvasTransform, ReferenceMediaClip } from '@tb/schema';
import { Crosshair, Layers3, Maximize, RotateCcw, Trash2 } from 'lucide-react';
import { Menu, MenuItem, MenuSeparator } from '../ui';
import { centerMediaCanvasTransform, fitMediaCanvasTransform, originalMediaCanvasTransform } from './media-canvas-transform';

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
