import type { MusicStructureSegment } from '@tb/schema';

export function musicSegmentAt(segments: readonly MusicStructureSegment[], atMs: number): MusicStructureSegment | undefined {
  return segments.find(segment => atMs >= segment.startMs && atMs < segment.endMs)
    ?? (atMs === segments.at(-1)?.endMs ? segments.at(-1) : undefined);
}

export function musicSegmentTempoLabel(segment: MusicStructureSegment | undefined): string {
  if (!segment || segment.bpm === null) return '无可测 BPM';
  return `约 ${segment.bpm}${segment.endBpm === null ? '' : ` → ${segment.endBpm}`} BPM`;
}
