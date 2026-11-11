import { Button, IconButton, Notice, Switch } from '../ui';
import { LayoutNumber } from './LayoutNumber';
import { clipLookOnlyInPreview } from '@tb/core/link';
import type { LinkMediaAsset, ReferenceCanvasTransform, ReferenceMediaClip } from '@tb/schema';
import { Crosshair, Maximize, MonitorUp, RotateCcw, Trash2, Undo2 } from 'lucide-react';
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
  /** Sends the position adjusted before 0.5.9 to OBS from now on (E16). */
  onSendLookToObs: () => void;
  /** Leaves the clip as OBS has it, dropping the editor's own position. */
  onUseObsLook: () => void;
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
    <div className="inspector-hero" title={`${props.clip.label} · ${formatBytes(props.asset.byteLength)}`}><span><strong>{props.clip.label}</strong><small>{props.asset.kind === 'video' ? '视频' : props.asset.kind === 'image' ? '图片' : '音频'}</small></span><IconButton variant="danger" label="从时间线移除" icon={Trash2} onClick={props.onRemove} /></div>
    <div className="property-metadata">
      {isVisual ? <span className="visual-source-summary">原始尺寸 {sourceWidth} × {sourceHeight}</span> : null}
      <span>开始 {formatTimecode(props.clip.startTimecode)}</span>
      <span>时长 {formatMilliseconds(props.clip.durationMs)}</span>
    </div>
    {isVisual ? <section className="visual-layout-editor media-layout-editor">
      {clipLookOnlyInPreview(props.clip) ? <Notice tone="warning" title="这个位置只在编辑器预览里，正式画面用的是 OBS 里的样子"
        actions={<>
          <Button variant="secondary" size="sm" icon={MonitorUp} onClick={props.onSendLookToObs}>送到 OBS</Button>
          <Button variant="ghost" size="sm" icon={Undo2} onClick={props.onUseObsLook}>用 OBS 里的样子</Button>
        </>}>
        以前在这里调的位置和大小没有送到 OBS。要让正式画面也这样摆，点「送到 OBS」；想保持 OBS 里现在的样子，点「用 OBS 里的样子」。
      </Notice> : null}
      <div className="layout-preset-row">
        <Button variant="secondary" size="sm" icon={RotateCcw} onClick={() => props.onTransform(originalMediaCanvasTransform())}>原始大小</Button>
        <Button variant="secondary" size="sm" icon={Crosshair} onClick={() => props.onTransform(centerMediaCanvasTransform(transform))}>画布居中</Button>
        <Button variant="secondary" size="sm" icon={Maximize} onClick={() => props.onTransform(fitMediaCanvasTransform(sourceWidth, sourceHeight))}>适应画布</Button>
        {props.clip.obsTransform === 'project' ? <Button variant="secondary" size="sm" icon={Undo2} onClick={props.onUseObsLook}>用 OBS 里的样子</Button> : null}
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
    {props.asset.kind === 'video' ? <Switch className="inspector-toggle" label="片段声音"
      help={master ? '这段视频的声音已经作为歌曲音轨播放，这里不再重复混入' : videoSoundAvailable ? '通过 OBS 媒体源混入直播声音' : '要先在「播放习惯」里打开“视频素材原声”'}
      disabled={!videoSoundAvailable} checked={videoSoundAvailable && props.clip.embeddedAudioEnabled !== false} onChange={(event) => props.onEmbeddedAudioEnabled(event.currentTarget.checked)} /> : null}
  </div>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
