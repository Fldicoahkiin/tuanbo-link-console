import type { LinkMediaAsset, ReferenceCanvasTransform, ReferenceMediaClip } from '@tb/schema';
import { lookPartsOf, quarterTurn, withLookParts } from '@tb/core/link';
import { Crosshair, FlipHorizontal2, FlipVertical2, Layers3, Maximize, RotateCcw, RotateCcwSquare, RotateCwSquare, Trash2 } from 'lucide-react';
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
  const transform = props.context.clip.canvasTransform;
  // A preset only places the picture: its mirror, crop and opacity stay (E17).
  const place = (placed: ReferenceCanvasTransform): void => props.onTransform({ ...placed, ...lookPartsOf(transform) });
  return <Menu x={props.context.x} y={props.context.y} label="画面素材菜单" title={props.context.clip.label} onClose={props.onClose}>
    <MenuItem icon={RotateCcw} onSelect={() => run(() => place(originalMediaCanvasTransform()))}>原始大小</MenuItem>
    <MenuItem icon={Crosshair} onSelect={() => run(() => props.onTransform(centerMediaCanvasTransform(transform)))}>画布居中</MenuItem>
    <MenuItem icon={Maximize} onSelect={() => run(() => place(fitMediaCanvasTransform(sourceWidth, sourceHeight)))}>适应画布</MenuItem>
    <MenuSeparator />
    <MenuItem icon={FlipHorizontal2} onSelect={() => run(() => props.onTransform(withLookParts(transform, { flipX: transform.flipX !== true })))}>{transform.flipX === true ? '取消左右镜像' : '左右镜像'}</MenuItem>
    <MenuItem icon={FlipVertical2} onSelect={() => run(() => props.onTransform(withLookParts(transform, { flipY: transform.flipY !== true })))}>{transform.flipY === true ? '取消上下镜像' : '上下镜像'}</MenuItem>
    <MenuItem icon={RotateCcwSquare} onSelect={() => run(() => props.onTransform(quarterTurn(transform, -1)))}>向左转 90°</MenuItem>
    <MenuItem icon={RotateCwSquare} onSelect={() => run(() => props.onTransform(quarterTurn(transform, 1)))}>向右转 90°</MenuItem>
    <MenuSeparator />
    <MenuItem icon={Layers3} disabled={!props.topLayerId || props.context.clip.layerId === props.topLayerId} onSelect={() => run(props.onMoveToTop)}>移到最顶图层</MenuItem>
    <MenuSeparator />
    <MenuItem icon={Trash2} danger onSelect={() => run(props.onRemove)}>从时间线删除</MenuItem>
  </Menu>;
}
