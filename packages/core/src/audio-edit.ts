import { referenceAudioSchema, referenceAudioSourceSchema, type AudioSegment, type AudioTrack, type ReferenceAudio } from '@tb/schema';

export function audioTracks(audio: ReferenceAudio, title = '歌曲音频'): AudioTrack[] {
  return audio.timeline?.tracks ?? [{ id: `track-${audio.assetId}`, title, source: referenceAudioSourceSchema.parse(audio.timeline?.source ?? audio), segments: audioSegments(audio) }];
}

export function audioContainsMediaSource(audio: ReferenceAudio | undefined, assetId: string): boolean {
  return audio?.sourceMediaAssetId === assetId || Boolean(audio?.timeline?.tracks?.some(track => track.source.sourceMediaAssetId === assetId));
}

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
  // The song's beats live on the song (`rundownItem.music`, bound to the source file), so an edit keeps them.
  return referenceAudioSchema.parse({ ...next, ...(audio.sourceMediaAssetId ? { sourceMediaAssetId: audio.sourceMediaAssetId } : {}), timeline: { source, segments } });
}

/** One mono music track: moves cannot overlap adjacent segments. */
export function updateAudioSegment(audio: ReferenceAudio, id: string, patch: Partial<Pick<AudioSegment, 'startMs' | 'durationMs' | 'sourceOffsetMs'>>): AudioSegment[] {
  const segments = audioSegments(audio);
  if (!segments.some((segment) => segment.id === id)) throw new Error('音频片段已不存在');
  const next = segments.map((segment) => segment.id === id ? { ...segment, ...patch } : segment).sort((a, b) => a.startMs - b.startMs);
  const source = audio.timeline?.source ?? audio;
  for (const [index, segment] of next.entries()) {
    if (![segment.startMs, segment.sourceOffsetMs, segment.durationMs].every(Number.isSafeInteger) || segment.startMs < 0 || segment.sourceOffsetMs < 0 || segment.durationMs < 1) throw new Error('位置和素材入点不能小于 0，片段时长至少为 1 毫秒');
    if (segment.sourceOffsetMs + segment.durationMs > source.durationMs) throw new Error('裁剪结尾超过原素材长度，请缩短时长或提前素材入点');
    const previous = next[index - 1];
    if (previous && previous.startMs + previous.durationMs > segment.startMs) throw new Error('和同一音轨上的片段重叠了，请移到空白位置或另一条音轨');
  }
  const durationMs = Math.max(...next.map((segment) => segment.startMs + segment.durationMs));
  referenceAudioSchema.parse({ ...audio, durationMs, timeline: { source: audio.timeline?.source ?? audio, segments: next } });
  return next;
}

/** Clamp pointer edits to source media and neighbouring clips; preview and commit share this result. */
export function dragAudioSegment(segments:readonly AudioSegment[], id:string, edge:'move'|'start'|'end', deltaMs:number, sourceDurationMs:number):AudioSegment {
  const segment=segments.find(value=>value.id===id);
  if(!segment||!Number.isFinite(deltaMs))throw new Error('音频拖动目标无效');
  const previous=Math.max(0,...segments.filter(value=>value.id!==id&&value.startMs<segment.startMs).map(value=>value.startMs+value.durationMs));
  const following=Math.min(86_400_000,...segments.filter(value=>value.id!==id&&value.startMs>=segment.startMs).map(value=>value.startMs));
  const end=segment.startMs+segment.durationMs;
  const clamp=(minimum:number,maximum:number):number=>Math.max(minimum,Math.min(maximum,Math.round(deltaMs)));
  if(edge==='move')return {...segment,startMs:segment.startMs+clamp(previous-segment.startMs,following-end)};
  if(edge==='start'){
    const delta=clamp(Math.max(previous-segment.startMs,-segment.sourceOffsetMs),segment.durationMs-1);
    return {...segment,startMs:segment.startMs+delta,sourceOffsetMs:segment.sourceOffsetMs+delta,durationMs:segment.durationMs-delta};
  }
  return {...segment,durationMs:segment.durationMs+clamp(1-segment.durationMs,Math.min(following-end,sourceDurationMs-segment.sourceOffsetMs-segment.durationMs))};
}
