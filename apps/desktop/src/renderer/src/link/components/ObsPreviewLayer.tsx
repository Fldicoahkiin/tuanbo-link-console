import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import type { SceneItemTransform } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { resizeCanvasScale } from './canvas-scale';
import { snapCanvasAxis } from './canvas-snap';
import { hasVisibleObsPreviewPixels, obsPreviewRequestSize, obsSourceSizeOnCanvas, type ObsSourceSize } from './obs-source-geometry';

export function ObsPreviewLayer(props: {
  sourceName: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  zIndex: number;
  selected: boolean;
  locked: boolean;
  transform: SceneItemTransform | null;
  sourceSize: ObsSourceSize | null;
  canvasWidth: number;
  canvasHeight: number;
  onSnapGuides: (guides: { x: number | null; y: number | null }) => void;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onTransform: (transform: SceneItemTransform) => void;
}): JSX.Element {
  const [imageData, setImageData] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warming, setWarming] = useState(false);
  const [preview, setPreview] = useState(props.transform);
  const [intrinsicSource, setIntrinsicSource] = useState<{ sourceName: string; size: ObsSourceSize } | null>(null);
  const gesture = useRef<ObsCanvasGesture | null>(null);
  const intrinsicSize = intrinsicSource?.sourceName === props.sourceName ? intrinsicSource.size : null;
  const effectiveSourceSize = props.sourceSize ?? intrinsicSize;
  const sourceWidth = effectiveSourceSize?.width;
  const sourceHeight = effectiveSourceSize?.height;
  useEffect(() => setPreview(props.transform), [props.transform]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let emptySince: number | null = null;
    const refresh = async (): Promise<void> => {
      const startedAt = performance.now();
      if (props.status !== 'connected') {
        setImageData(null);
        setWarming(false);
        setError('OBS WebSocket 未连接，无法读取画面');
        return;
      }
      try {
        const dimensions = sourceWidth === undefined || sourceHeight === undefined
          ? {}
          : obsPreviewRequestSize({ width: sourceWidth, height: sourceHeight });
        const next = await linkDesktopViewModel.getObsSourceScreenshot({ sourceName: props.sourceName, ...dimensions });
        const visible = await hasVisibleObsPreview(next, props.sourceName);
        if (cancelled) return;
        if (!visible) {
          emptySince ??= performance.now();
          setImageData(null);
          const preparing = performance.now() - emptySince < 2000;
          setWarming(preparing);
          setError(preparing ? null : `OBS 返回的“${props.sourceName}”预览没有可见画面。请检查该场景中的来源是否可见、采集目标是否有效。`);
        } else { emptySince = null; setWarming(false); setImageData(next); setError(null); }
      } catch (reason) {
        if (!cancelled) { setImageData(null); setWarming(false); setError(toMessage(reason)); }
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), Math.max(16, 100 - (performance.now() - startedAt)));
      }
    };
    void refresh();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [props.sourceName, props.status, sourceHeight, sourceWidth]);
  const beginGesture = (event: PointerEvent<HTMLElement>, mode: ObsCanvasGesture['mode'], handle?: CanvasHandle): void => {
    if (event.button !== 0 || props.locked || !preview) return;
    event.preventDefault();
    event.stopPropagation();
    props.onSelect();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { mode, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: preview, direction: handle ? resizeDirection(handle) : { x: 0, y: 0 } };
  };
  const moveGesture = (event: PointerEvent<HTMLElement>): void => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const frame = event.currentTarget.closest('.stage-frame')?.getBoundingClientRect();
    if (!frame) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    const baseWidth = effectiveSourceSize ? Math.max(1, effectiveSourceSize.width - current.origin.cropLeft - current.origin.cropRight) : props.canvasWidth;
    const baseHeight = effectiveSourceSize ? Math.max(1, effectiveSourceSize.height - current.origin.cropTop - current.origin.cropBottom) : props.canvasHeight;
    if (current.mode === 'move') {
      const anchor = obsAlignmentAnchor(current.origin.alignment ?? 0);
      const snappedX = snapCanvasAxis({ value: current.origin.positionX + dx / frame.width * props.canvasWidth, itemSize: baseWidth * current.origin.scaleX, anchor: anchor.x / 100, canvasSize: props.canvasWidth, threshold: 8 / frame.width * props.canvasWidth });
      const snappedY = snapCanvasAxis({ value: current.origin.positionY + dy / frame.height * props.canvasHeight, itemSize: baseHeight * current.origin.scaleY, anchor: anchor.y / 100, canvasSize: props.canvasHeight, threshold: 8 / frame.height * props.canvasHeight });
      props.onSnapGuides({ x: snappedX.guide === null ? null : snappedX.guide / props.canvasWidth, y: snappedY.guide === null ? null : snappedY.guide / props.canvasHeight });
      setPreview({ ...current.origin, positionX: snappedX.value, positionY: snappedY.value });
      return;
    }
    props.onSnapGuides({ x: null, y: null });
    const scale = resizeCanvasScale({
      scaleX: current.origin.scaleX,
      scaleY: current.origin.scaleY,
      deltaX: current.direction.x === 0 ? 0 : current.direction.x * dx / frame.width * props.canvasWidth / Math.max(baseWidth, 1),
      deltaY: current.direction.y === 0 ? 0 : current.direction.y * dy / frame.height * props.canvasHeight / Math.max(baseHeight, 1),
      freeform: event.shiftKey
    });
    setPreview({ ...current.origin, ...scale });
  };
  const endGesture = (event: PointerEvent<HTMLElement>): void => {
    if (!gesture.current || gesture.current.pointerId !== event.pointerId || !preview) return;
    gesture.current = null;
    props.onSnapGuides({ x: null, y: null });
    props.onTransform(preview);
  };
  const cancelGesture = (event: PointerEvent<HTMLElement>): void => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    setPreview(current.origin);
    props.onSnapGuides({ x: null, y: null });
  };
  const anchor = obsAlignmentAnchor(preview?.alignment ?? 0);
  const baseWidth = effectiveSourceSize && preview ? Math.max(1, effectiveSourceSize.width - preview.cropLeft - preview.cropRight) : props.canvasWidth;
  const baseHeight = effectiveSourceSize && preview ? Math.max(1, effectiveSourceSize.height - preview.cropTop - preview.cropBottom) : props.canvasHeight;
  const canvasSize = obsSourceSizeOnCanvas({ width: baseWidth, height: baseHeight }, { width: props.canvasWidth, height: props.canvasHeight });
  const style: CSSProperties = preview
    ? { zIndex: props.zIndex, inset: 'auto', width: `${canvasSize.width}%`, height: `${canvasSize.height}%`, left: `${preview.positionX / props.canvasWidth * 100}%`, top: `${preview.positionY / props.canvasHeight * 100}%`, transformOrigin: `${anchor.x}% ${anchor.y}%`, transform: `translate(${-anchor.x}%, ${-anchor.y}%) rotate(${preview.rotation}deg) scale(${preview.scaleX}, ${preview.scaleY})` }
    : { zIndex: props.zIndex };
  return <button className={`stage-obs-layer ${props.selected ? 'is-selected' : ''} ${props.locked ? 'is-locked' : ''}`} style={style} onClick={props.onSelect} onContextMenu={props.onContextMenu} onPointerDown={(event) => beginGesture(event, 'move')} onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={cancelGesture}>
    {imageData ? <img
      src={imageData}
      alt={`OBS ${props.sourceName}`}
      onLoad={(event) => {
        if (props.sourceSize || intrinsicSize) return;
        const { naturalWidth, naturalHeight } = event.currentTarget;
        if (naturalWidth <= 0 || naturalHeight <= 0) {
          setError('OBS 来源预览未返回有效原始尺寸');
          return;
        }
        setIntrinsicSource({ sourceName: props.sourceName, size: { width: naturalWidth, height: naturalHeight } });
      }}
    /> : null}
    {error ? <span className="stage-obs-error">{error}</span> : null}
    {warming ? <span className="stage-obs-warming" role="status">正在准备采集画面…</span> : null}
    {props.selected && preview && !props.locked ? CANVAS_HANDLES.map((handle) => <i key={handle} className={`stage-obs-handle ${handle}`} onPointerDown={(event) => beginGesture(event, 'resize', handle)} />) : null}
  </button>;
}

type CanvasHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type ResizeDirection = { x: -1 | 0 | 1; y: -1 | 0 | 1 };
type ObsCanvasGesture = { mode: 'move' | 'resize'; pointerId: number; startX: number; startY: number; origin: SceneItemTransform; direction: ResizeDirection };
const CANVAS_HANDLES: CanvasHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function resizeDirection(handle: CanvasHandle): ResizeDirection {
  return { x: handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0, y: handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0 };
}

function obsAlignmentAnchor(alignment: number): { x: number; y: number } {
  if (alignment === 0) return { x: 50, y: 50 };
  return { x: alignment & 1 ? 0 : alignment & 2 ? 100 : 50, y: alignment & 4 ? 0 : alignment & 8 ? 100 : 50 };
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function hasVisibleObsPreview(dataUrl: string, sourceName: string): Promise<boolean> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error(`OBS 来源“${sourceName}”未返回有效预览尺寸`);
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法分析 OBS 来源预览像素');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return hasVisibleObsPreviewPixels(context.getImageData(0, 0, canvas.width, canvas.height).data);
}
