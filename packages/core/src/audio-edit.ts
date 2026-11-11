import { referenceAudioSchema, referenceAudioSourceSchema, type AudioSegment, type AudioTrack, type MtcFrameRate, type ReferenceAudio } from '@tb/schema';
import { playbackFramesPerSecond } from './mtc-timecode';

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

/** Where the last segment of any track ends: the song has music up to here. */
export function audioTracksEndMs(tracks: readonly Pick<AudioTrack, 'segments'>[]): number {
  return Math.max(...tracks.flatMap((track) => track.segments.map((segment) => segment.startMs + segment.durationMs)));
}

/** How long the song is, and the only place that decides it (0.5.9 E13): the saved length when the song ends in
 * silence (`timeline.durationMs`), otherwise where its last segment ends, as before. */
export function songDurationMs(audio: ReferenceAudio): number {
  return audio.timeline?.durationMs ?? audioTracksEndMs(audioTracks(audio));
}

/** The silence before the music: where the earliest segment of any track starts. */
export function songLeadBlankMs(audio: ReferenceAudio): number {
  return Math.min(...audioTracks(audio).flatMap((track) => track.segments.map((segment) => segment.startMs)));
}

/** The silence after the music: the song's length past the last segment's end. */
export function songTailBlankMs(audio: ReferenceAudio): number {
  return songDurationMs(audio) - audioTracksEndMs(audioTracks(audio));
}

/** How long the song is once its tracks are edited to `tracks`. A song with no saved length ends with its music, as
 * before (undefined); a saved length stays, so editing a segment keeps the silence after the music, and a segment
 * moved or trimmed past it makes the song longer, up to that segment's end. */
export function editedSongDurationMs(audio: ReferenceAudio, tracks: readonly Pick<AudioTrack, 'segments'>[]): number | undefined {
  const saved = audio.timeline?.durationMs;
  return saved === undefined ? undefined : Math.max(saved, audioTracksEndMs(tracks));
}

/** Whole frames at the project's frame rate, in whole milliseconds. */
function frameAlignedMs(milliseconds: number, frameRate: MtcFrameRate): number {
  const fps = playbackFramesPerSecond(frameRate);
  return Math.round(Math.round(milliseconds / 1_000 * fps) * 1_000 / fps);
}

/** Blank time before and after the music: every track's segments move together by `leadDeltaMs` (rounded to whole
 * frames, so every event on the console moves by the same frames), and the song lasts to the new last end plus
 * `tailMs` (whole frames too). Returns the tracks and the song's length; rendering the WAV of that length is the
 * main process's (audio-edit-service). The song's beats follow the segments by themselves (songBeats). */
export function padAudioTimeline(audio: ReferenceAudio, leadDeltaMs: number, tailMs: number, frameRate: MtcFrameRate): { tracks: AudioTrack[]; durationMs: number } {
  if (!Number.isFinite(leadDeltaMs) || !Number.isFinite(tailMs) || tailMs < 0) throw new Error('空白的长度无效');
  const delta = Math.sign(leadDeltaMs) * frameAlignedMs(Math.abs(leadDeltaMs), frameRate);
  if (songLeadBlankMs(audio) + delta < 0) throw new Error('前面的空白不能比 0 还短');
  const tracks = audioTracks(audio).map((track) => ({ ...track, segments: track.segments.map((segment) => ({ ...segment, startMs: segment.startMs + delta })) }));
  const durationMs = audioTracksEndMs(tracks) + frameAlignedMs(tailMs, frameRate);
  if (durationMs > 86_400_000) throw new Error('歌曲不能超过 24 小时');
  return { tracks, durationMs };
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
  const songMs = editedSongDurationMs(audio, [{ segments: next }]);
  const durationMs = songMs ?? audioTracksEndMs([{ segments: next }]);
  referenceAudioSchema.parse({ ...audio, durationMs, timeline: { source: audio.timeline?.source ?? audio, segments: next, ...(songMs === undefined ? {} : { durationMs: songMs }) } });
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
