import { lightingDocumentSchema, type LightingClip, type LightingDocument } from '@tb/schema';
import { LightingTempoMap, lightingClipSpan, lightingEventTime } from './lighting-edit';
import { musicClipInTime } from './lighting-music';

/*
 * The whole song's lighting moves by `deltaMs` with its music (blank time added or removed before it, 0.5.9 E14).
 * Every time a lighting document holds, and what happens to it:
 * - clip `start` (ms in a time clip): + delta. Event `at`, note `duration`, `preparation.leadMs` are inside the clip
 *   and stay. A clip that would start before 0 starts at 0 and its events keep their times.
 * - beat clips: their beats count from 0 ms of the tempo map, not from the first beat, so moving the tempo map is
 *   only a move when the tempo never changes. They become time clips at the times they play now (musicClipInTime,
 *   the conversion the lighting workspace makes when cues are locked to time), and every event at or after the first
 *   beat keeps following the beats through its `beatAnchor`.
 * - `beatAnchor` of time clips: beats counted from `music.firstBeatMs`, which moves too, so it stays.
 * - `music.firstBeatMs`, `music.sections`, `markers`: + delta. `tempos` are beats and stay.
 * - `loop` (the practice range): + delta, kept inside the song: one that would start before 0 starts at 0.
 * - `ma2Bindings` (`timeOriginMs`, `baselineTracks`, mappings) and `consoleSong` (points as last written, timecode
 *   offset) stay: they are what the console has, and the difference to them is the one rewrite the console gets.
 * - `templates` are library entries, not on the song's timeline; `autoCueSource` names the audio cues came from.
 * Beats of the song itself are not here: they live on the song by its source audio (songBeats) and follow the segments.
 */

const ahead = '前面的空白里还有灯光点，请先挪开';

export function shiftLightingDocument(lighting: LightingDocument, deltaMs: number): LightingDocument {
  if (!Number.isFinite(deltaMs)) throw new Error('挪动的时间无效');
  if (deltaMs === 0) return lighting;
  if (lighting.musicAnalysis) throw new Error('这首歌的灯光里还有旧格式的节拍，请保存并重新打开工程后再加空白');
  const map = new LightingTempoMap(lighting.tempos);
  const firstBeatMs = lighting.music?.firstBeatMs ?? 0;
  const moved = (ms: number, reason = ahead): number => {
    const next = ms + deltaMs;
    if (next < 0) throw new Error(reason);
    return next;
  };
  const marked = (ms: number): number => moved(ms, '前面的空白里还有标记或歌曲段落，请先挪开');
  const shiftClip = (source: LightingClip): LightingClip => {
    const clip = source.timeLock === 'beat' ? musicClipInTime(lighting, source, map, (_event, ms) => ms >= firstBeatMs) : source;
    const start = clip.start + deltaMs;
    for (const event of clip.events) moved(lightingEventTime(clip, event, map));
    if (start >= 0) return { ...clip, start };
    if (!clip.events.length) throw new Error(ahead);
    // Starting at 0 instead: the events keep their times, the clip is shorter by what it lost before 0.
    return { ...clip, start: 0, duration: clip.duration + start, events: clip.events.map(event => ({ ...event, at: event.at + start })) };
  };
  const loopStart = Math.max(0, lighting.loop.startMs + deltaMs);
  const next: LightingDocument = {
    ...lighting,
    version: 2,
    tracks: lighting.tracks.map(track => ({ ...track, clips: track.clips.map(shiftClip) })),
    markers: lighting.markers.map(marker => ({ ...marker, startMs: marked(marker.startMs), endMs: marker.endMs === null ? null : marked(marker.endMs) })),
    loop: { ...lighting.loop, startMs: loopStart, endMs: loopStart + lighting.loop.endMs - lighting.loop.startMs },
    ...(lighting.music ? { music: { ...lighting.music, firstBeatMs: moved(lighting.music.firstBeatMs, '音乐网格的第一拍会挪到歌曲开头之前，请先把第一拍往后挪'),
      sections: lighting.music.sections.map(section => ({ ...section, startMs: marked(section.startMs), endMs: marked(section.endMs) })) } } : {})
  };
  return lightingDocumentSchema.parse(next);
}

/** What on the lighting timeline holds a whole-song move: the points (cues, notes and empty clips), the markers, the
 * song's sections and the first beat of the music grid. */
export type LightingTimeKind = 'point' | 'marker' | 'section' | 'first-beat';

/** Where the earliest and latest lighting things of each kind are, in song time; a kind the document has none of is
 * left out. songPaddingLimits says from it what stops taking blank time away (0.5.9 E15). */
export function lightingTimeRanges(lighting: LightingDocument): Partial<Record<LightingTimeKind, { startMs: number; endMs: number }>> {
  const map = new LightingTempoMap(lighting.tempos);
  const times: Record<LightingTimeKind, number[]> = { point: [], marker: [], section: [], 'first-beat': [] };
  for (const track of lighting.tracks) for (const clip of track.clips) {
    // The clip itself may start at 0 (shiftLightingDocument starts it there); only where it plays counts.
    for (const event of clip.events) {
      times.point.push(lightingEventTime(clip, event, map));
      if (event.kind === 'note') times.point.push(lightingEventTime(clip, { ...event, at: event.at + event.duration }, map));
    }
    if (!clip.events.length) times.point.push(lightingClipSpan(clip, map).startMs);
  }
  for (const marker of lighting.markers) times.marker.push(marker.startMs, marker.endMs ?? marker.startMs);
  if (lighting.music) {
    times['first-beat'].push(lighting.music.firstBeatMs);
    for (const section of lighting.music.sections) times.section.push(section.startMs, section.endMs);
  }
  const ranges: Partial<Record<LightingTimeKind, { startMs: number; endMs: number }>> = {};
  for (const kind of Object.keys(times) as LightingTimeKind[]) {
    const values = times[kind];
    if (values.length) ranges[kind] = { startMs: Math.min(...values), endMs: Math.max(...values) };
  }
  return ranges;
}

/** Where the earliest and latest lighting things are, in song time: what moving the song's lighting is held to.
 * Null when the document has nothing on its timeline. */
export function lightingTimeRange(lighting: LightingDocument): { startMs: number; endMs: number } | null {
  const ranges = Object.values(lightingTimeRanges(lighting));
  return ranges.length ? { startMs: Math.min(...ranges.map(range => range.startMs)), endMs: Math.max(...ranges.map(range => range.endMs)) } : null;
}
