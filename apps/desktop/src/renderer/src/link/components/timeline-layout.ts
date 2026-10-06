import type { CSSProperties } from 'react';

type LayoutInput = {
  lightingWorkspace?: boolean;
  lighting?: { document: { markers: readonly unknown[]; tracks: readonly unknown[]; laneIndex?: number | undefined } };
  audioEditor?: { tracks: readonly unknown[] };
  audioRowHeight?: number;
  layers: readonly unknown[];
  playheadMs: number;
  referenceAudio: { durationMs: number } | null;
};
type TimelineStyle = CSSProperties & { '--timeline-grid-size': string };

export function timelineRulerHeight(props: Pick<LayoutInput, 'lightingWorkspace' | 'lighting'>): number {
  return (props.lightingWorkspace ? 44 : 28) + (props.lighting?.document.markers.length ? 16 : 0);
}

export function timelineLayout(props: LayoutInput, contentWidth: number, pixelsPerSecond: number, gridSize: number) {
  const audioRows = Math.max(1, props.audioEditor?.tracks.length ?? 0), audioHeight = props.audioRowHeight ?? 76;
  const rows = [`${timelineRulerHeight(props)}px`, ...Array.from({ length: audioRows }, () => `${audioHeight}px`), ...props.layers.map(() => '50px')];
  const lightingIndex = Math.min(props.layers.length, props.lighting?.document.laneIndex ?? 0);
  const lightingRows = props.lighting && !props.lightingWorkspace ? Math.max(1, props.lighting.document.tracks.length) : 0;
  rows.splice(1 + audioRows + lightingIndex, 0, ...Array.from({ length: lightingRows }, () => '72px'));
  rows.push(props.lightingWorkspace ? 'minmax(0, 1fr)' : 'minmax(90px, 1fr)');
  const contentStyle: TimelineStyle = { width: contentWidth, gridTemplateRows: rows.join(' '), '--timeline-grid-size': `${gridSize}px` };
  return {
    playheadLeft: props.playheadMs / 1_000 * pixelsPerSecond, contentStyle,
    headingStyle: { gridTemplateRows: contentStyle.gridTemplateRows },
    visualTracks: { start: timelineRulerHeight(props) + audioRows * audioHeight, lightingIndex, lightingHeight: lightingRows * 72 },
    waveformContentWidth: props.referenceAudio ? Math.min(contentWidth, props.referenceAudio.durationMs / 1_000 * pixelsPerSecond) : contentWidth
  };
}
