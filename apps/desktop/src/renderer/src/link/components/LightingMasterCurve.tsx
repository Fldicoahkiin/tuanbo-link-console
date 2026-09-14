import { lightingClipSpan, type LightingTempoMap } from '@tb/core/link';
import type { LightingClip, LightingEvent } from '@tb/schema';
import { lightingMasterSegments } from './lighting-master-curve';

export function LightingMasterCurve(props: { clip: LightingClip; map: LightingTempoMap; pixelsPerSecond: number;
  scrollLeft: number; viewportWidth: number; previewEvent: (clip: LightingClip, event: LightingEvent) => LightingEvent }): JSX.Element | null {
  const start = lightingClipSpan(props.clip, props.map).startMs / 1000 * props.pixelsPerSecond;
  const left = Math.max(start, props.scrollLeft);
  const width = props.scrollLeft + props.viewportWidth - left;
  if (width <= 0) return null;
  const events = props.clip.events.map((event) => props.previewEvent(props.clip, event));
  const segments = lightingMasterSegments(props.clip, events, props.map, props.pixelsPerSecond, left, left + width);
  if (!segments.length) return null;
  return <svg className="lighting-master-curve" aria-hidden="true" style={{ left: left - start, width }} height={56}>
    {segments.map((segment, index) => <line key={index} data-executor={segment.executor} x1={segment.x1} y1={segment.y1} x2={segment.x2} y2={segment.y2} />)}
  </svg>;
}
