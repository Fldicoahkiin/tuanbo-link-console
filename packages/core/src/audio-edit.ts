import { referenceAudioSchema, type AudioSegment, type ReferenceAudio } from '@tb/schema';

export function audioSegments(audio: ReferenceAudio): AudioSegment[] {
  return audio.timeline?.segments ?? [{ id: `audio-${audio.assetId}`, startMs: 0, sourceOffsetMs: 0, durationMs: audio.durationMs }];
}

export function splitAudioSegments(segments: readonly AudioSegment[], pointsMs: readonly number[], createId: () => string = () => crypto.randomUUID()): AudioSegment[] {
  const points = [...new Set(pointsMs.map(Math.round))].filter(Number.isFinite).sort((a, b) => a - b);
  return segments.flatMap((segment) => {
    const end = segment.startMs + segment.durationMs;
    const cuts = points.filter((point) => point > segment.startMs && point < end);
    const boundaries = [segment.startMs, ...cuts, end];
    return boundaries.slice(0, -1).map((startMs, index) => ({ id: index === 0 ? segment.id : createId(), startMs,
      sourceOffsetMs: segment.sourceOffsetMs + startMs - segment.startMs, durationMs: boundaries[index + 1]! - startMs }));
  });
}

export function editedAudio(audio: ReferenceAudio, segments: AudioSegment[], rendered?: ReferenceAudio): ReferenceAudio {
  const source = audio.timeline?.source ?? { assetId: audio.assetId, relativePath: audio.relativePath, sha256: audio.sha256, durationMs: audio.durationMs,
    ...(audio.sourceMediaAssetId ? { sourceMediaAssetId: audio.sourceMediaAssetId } : {}) };
  const next = rendered ?? audio;
  return referenceAudioSchema.parse({ ...next, ...(audio.sourceMediaAssetId ? { sourceMediaAssetId: audio.sourceMediaAssetId } : {}), timeline: { source, segments }, ...(rendered ? { beats: undefined } : {}) });
}

/** One mono music track: moves cannot overlap adjacent segments. */
export function updateAudioSegment(audio: ReferenceAudio, id: string, patch: Partial<Pick<AudioSegment, 'startMs' | 'durationMs' | 'sourceOffsetMs'>>): AudioSegment[] {
  const segments = audioSegments(audio);
  if (!segments.some((segment) => segment.id === id)) throw new Error('音频片段已不存在');
  const next = segments.map((segment) => segment.id === id ? { ...segment, ...patch } : segment).sort((a, b) => a.startMs - b.startMs);
  const durationMs = Math.max(...next.map((segment) => segment.startMs + segment.durationMs));
  referenceAudioSchema.parse({ ...audio, durationMs, beats: undefined, timeline: { source: audio.timeline?.source ?? audio, segments: next } });
  return next;
}
