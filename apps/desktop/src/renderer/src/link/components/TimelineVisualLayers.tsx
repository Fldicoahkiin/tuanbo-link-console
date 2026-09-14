import type { HTMLAttributes, MouseEvent, PointerEvent, DragEvent } from 'react';
import type { TimelineSpan } from '@tb/core/link';
import type { LinkCue, LinkMediaAsset, MtcFrameRate, ReferenceMediaClip, VisualLayer } from '@tb/schema';
import { CueLane, TimelineClip, type TimelineDrag } from './TimelineItems';

type Props = {
  layers: VisualLayer[];
  clips: ReferenceMediaClip[];
  cues: LinkCue[];
  assets: Map<string, LinkMediaAsset>;
  clipSpans: ReadonlyMap<string, TimelineSpan>;
  frameRate: MtcFrameRate;
  pixelsPerSecond: number;
  selectedClipId: string | null;
  selectedCueId: string | null;
  activeClipIds: ReadonlySet<string>;
  activeCueIds: ReadonlySet<string>;
  visualCueSpans: ReadonlyMap<string, TimelineSpan>;
  drag: TimelineDrag | null;
  resizeDrag: { id: string; previewStartMs: number; previewDurationMs: number } | null;
  cueResizeDrag: { id: string; previewStartMs: number; previewDurationMs: number } | null;
  lanePointer: Pick<HTMLAttributes<HTMLElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>;
  onDrop: (event: DragEvent<HTMLElement>, layer: VisualLayer) => void;
  onBeginDrag: (event: PointerEvent<HTMLButtonElement>, kind: TimelineDrag['kind'], id: string, originMs: number) => void;
  onMoveDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onEndDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onCancelDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onTrimBegin: (event: PointerEvent<HTMLElement>, clip: ReferenceMediaClip, edge: 'start' | 'end', sourceDurationMs?: number) => void;
  onTrimMove: (event: PointerEvent<HTMLElement>) => void;
  onTrimEnd: (event: PointerEvent<HTMLElement>) => void;
  onTrimCancel: (event: PointerEvent<HTMLElement>) => void;
  onCueTrimBegin: (event: PointerEvent<HTMLElement>, cue: LinkCue, durationMs: number, edge: 'start' | 'end') => void;
  onCueTrimMove: (event: PointerEvent<HTMLElement>) => void;
  onCueTrimEnd: (event: PointerEvent<HTMLElement>) => void;
  onCueTrimCancel: (event: PointerEvent<HTMLElement>) => void;
  onSelectClip: (clipId: string) => void;
  onSelectCue: (cueId: string) => void;
  onOpenCueMenu: (event: MouseEvent<HTMLButtonElement>, cue: LinkCue) => void;
  onOpenClipMenu: (event: MouseEvent<HTMLButtonElement>, clip: ReferenceMediaClip) => void;
};

export function TimelineVisualLayers(props: Props): JSX.Element[] {
  return props.layers.map((layer, index) => {
    const draggingItem = props.drag?.moved === true && props.drag.originLayerId === layer.id;
    return <CueLane
    key={layer.id} order={100 + index * 100}
    cues={props.cues.filter((cue) => cue.layerId === layer.id)}
    frameRate={props.frameRate}
    selectedCueId={props.selectedCueId}
    device="all"
    visualClipMode
    activeCueIds={props.activeCueIds}
    visualCueSpans={props.visualCueSpans}
    resizeDrag={props.cueResizeDrag}
    pixelsPerSecond={props.pixelsPerSecond}
    drag={props.drag}
    layerId={layer.id}
    locked={layer.locked}
    visible={layer.visible}
    dropTarget={props.drag?.moved === true && props.drag.targetLayerId === layer.id}
    draggingItem={draggingItem}
    lanePointer={props.lanePointer}
    onDrop={(event) => props.onDrop(event, layer)}
    onBeginDrag={props.onBeginDrag}
    onMoveDrag={props.onMoveDrag}
    onEndDrag={props.onEndDrag}
    onCancelDrag={props.onCancelDrag}
    onSelectCue={props.onSelectCue}
    onContextMenu={(event, cue) => { event.preventDefault(); props.onSelectCue(cue.id); props.onOpenCueMenu(event, cue); }}
    onTrimPointerDown={props.onCueTrimBegin}
    onTrimPointerMove={props.onCueTrimMove}
    onTrimPointerUp={props.onCueTrimEnd}
    onTrimPointerCancel={props.onCueTrimCancel}
  >
    <span className={`visual-layer-drop-state ${layer.locked ? 'is-locked' : ''}`} />
    {props.clips.filter((clip) => clip.layerId === layer.id).map((clip) => {
      const span = props.clipSpans.get(clip.id);
      if (!span) throw new Error(`时间线解析结果缺少素材片段：${clip.id}`);
      const itemDrag = props.drag?.kind === 'clip' && props.drag.id === clip.id ? props.drag : null;
      return <TimelineClip key={clip.id} clip={clip} asset={props.assets.get(clip.assetId)} resolvedStartMs={span.startMs} resolvedDurationMs={span.durationMs}
      frameRate={props.frameRate}
      pixelsPerSecond={props.pixelsPerSecond}
      selected={props.selectedClipId === clip.id}
      active={props.activeClipIds.has(clip.id)}
      locked={layer.locked}
      previewMs={props.resizeDrag?.id === clip.id ? props.resizeDrag.previewStartMs : itemDrag?.previewMs ?? null}
      previewDurationMs={props.resizeDrag?.id === clip.id ? props.resizeDrag.previewDurationMs : null}
      previewOffsetY={itemDrag?.moved ? itemDrag.previewOffsetY : null}
      onPointerDown={props.onBeginDrag}
      onPointerMove={props.onMoveDrag}
      onPointerUp={props.onEndDrag}
      onPointerCancel={props.onCancelDrag}
      onTrimPointerDown={props.onTrimBegin}
      onTrimPointerMove={props.onTrimMove}
      onTrimPointerUp={props.onTrimEnd}
      onTrimPointerCancel={props.onTrimCancel}
      onSelect={() => props.onSelectClip(clip.id)}
      onContextMenu={(event, target) => { event.preventDefault(); props.onSelectClip(target.id); props.onOpenClipMenu(event, target); }}
      />;
    })}
  </CueLane>;
  });
}
