import { Button } from './Button';
import { PropertyNumberInput } from './PropertyNumberInput';
import type { LinkMediaAsset, ReferenceCanvasTransform, ReferenceMediaClip } from '@tb/schema';
import { Crosshair, Maximize, RotateCcw, Trash2 } from 'lucide-react';
import { formatBytes, formatMilliseconds, formatTimecode } from './media-utils';
import { VideoAudioSource } from './VideoAudioSource';
import { useDocumentStore } from '../stores/document-store';
import { centerMediaCanvasTransform, fitMediaCanvasTransform, originalMediaCanvasTransform, REFERENCE_CANVAS_HEIGHT, REFERENCE_CANVAS_WIDTH } from './media-canvas-transform';

export function ClipInspector(props: {
  itemId: string;
  notify: (message: string, tone?: 'info' | 'error') => void;
  clip: ReferenceMediaClip;
  asset: LinkMediaAsset;
  onTransform: (transform: ReferenceCanvasTransform) => void;
  onEmbeddedAudioEnabled: (enabled: boolean) => void;
  onRemove: () => void;
}): JSX.Element {
  const project = useDocumentStore((state) => state.project);
  const internal = project?.playbackSource === 'internal';
  const master = internal && project?.rundown.find((item) => item.id === props.itemId)?.referenceAudio?.sourceMediaAssetId === props.asset.id;
  const videoSoundAvailable = !master && (!internal || project?.internalVideoAudio === true);
  const transform = props.clip.canvasTransform;
  const isVisual = props.asset.kind === 'video' || props.asset.kind === 'image';
  const sourceWidth = props.asset.width ?? REFERENCE_CANVAS_WIDTH;
  const sourceHeight = props.asset.height ?? REFERENCE_CANVAS_HEIGHT;
  const patch = (values: Partial<ReferenceCanvasTransform>): void => props.onTransform({ ...transform, ...values });
  return <div className="inspector-body clip-inspector">
    <div className="inspector-hero" title={`${props.clip.label} · ${formatBytes(props.asset.byteLength)}`}><span><strong>{props.clip.label}</strong><small>{props.asset.kind === 'video' ? '视频' : props.asset.kind === 'image' ? '图片' : '音频'}</small></span><Button className="icon-button danger-text" aria-label="从时间线移除" title="从时间线移除" onClick={props.onRemove}><Trash2 /></Button></div>
    <div className="property-metadata">
      {isVisual ? <span className="visual-source-summary">原始尺寸 {sourceWidth} × {sourceHeight}</span> : null}
      <span>开始 {formatTimecode(props.clip.startTimecode)}</span>
      <span>时长 {formatMilliseconds(props.clip.durationMs)}</span>
    </div>
    {isVisual ? <section className="visual-layout-editor media-layout-editor">
      <div className="layout-preset-row">
        <button onClick={() => props.onTransform(originalMediaCanvasTransform())}><RotateCcw />原始大小</button>
        <button onClick={() => props.onTransform(centerMediaCanvasTransform(transform))}><Crosshair />画布居中</button>
        <button onClick={() => props.onTransform(fitMediaCanvasTransform(sourceWidth, sourceHeight))}><Maximize />适应画布</button>
      </div>
      <div className="visual-layout-grid">
        <LayoutNumber label="位置 X" unit="px" value={transform.x * REFERENCE_CANVAS_WIDTH} onCommit={(value) => patch({ x: clamp(value / REFERENCE_CANVAS_WIDTH, -1, 2) })} />
        <LayoutNumber label="位置 Y" unit="px" value={transform.y * REFERENCE_CANVAS_HEIGHT} onCommit={(value) => patch({ y: clamp(value / REFERENCE_CANVAS_HEIGHT, -1, 2) })} />
        <LayoutNumber label="宽度" unit="%" value={transform.scale * transform.scaleX * 100} onCommit={(value) => patch({ scaleX: clamp(value / 100 / transform.scale, 0.05, 8) })} />
        <LayoutNumber label="高度" unit="%" value={transform.scale * transform.scaleY * 100} onCommit={(value) => patch({ scaleY: clamp(value / 100 / transform.scale, 0.05, 8) })} />
        <LayoutNumber label="旋转" unit="°" value={transform.rotation} onCommit={(value) => patch({ rotation: clamp(value, -180, 180) })} />
      </div>
    </section> : null}
    {props.asset.kind === 'video' && internal ? <VideoAudioSource itemId={props.itemId} asset={props.asset} notify={props.notify} /> : null}
    {props.asset.kind === 'video' ? <label className="inspector-toggle" title={master ? '这段视频的声音已作为歌曲音轨播放，这里不再重复混入' : videoSoundAvailable ? '通过 OBS 媒体源混入直播声音' : '需要先在「播放习惯」里打开“视频素材原声”'}><span>片段声音</span><input type="checkbox" disabled={!videoSoundAvailable} checked={videoSoundAvailable && props.clip.embeddedAudioEnabled !== false} onChange={(event) => props.onEmbeddedAudioEnabled(event.currentTarget.checked)} />{!videoSoundAvailable ? <small>{master ? '已用作歌曲音轨' : '未开启视频原声'}</small> : null}</label> : null}
  </div>;
}

function LayoutNumber(props: { label: string; unit: string; value: number; onCommit: (value: number) => void }): JSX.Element {
  return <label className="layout-number"><span>{props.label}</span><div><PropertyNumberInput label={props.label} value={props.value} step={0.01} precision={2} onCommit={props.onCommit} /><small>{props.unit}</small></div></label>;
}


function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
