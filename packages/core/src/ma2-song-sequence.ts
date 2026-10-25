import { lightingDocumentSchema, type LightingDocument, type LightingEffectSpeed, type LightingEvent, type Ma2SongPoint, type Ma2SongSyncResult } from '@tb/schema';
import { LightingTempoMap, lightingEventTime } from './lighting-edit';
import { consoleLabelText } from './ma2-console-label';
import { lightingEffectBpm, lightingPointEffectSpeed } from './lighting-effect-speed';

/** Song positions are stable identities; pool Cue numbers are never inferred from labels. */
export function ma2SongPoints(document: LightingDocument): Ma2SongPoint[] {
  const map = new LightingTempoMap(document.tempos);
  const groups = new Map<string, { name: string; atMs: number; values: Array<{ event: LightingEvent; ms: number }> }>();
  for (const track of document.tracks) for (const clip of track.clips) for (const event of clip.events) {
    if (event.kind !== 'ma2' && event.kind !== 'empty-cue') continue;
    if (event.kind === 'ma2' && (event.action !== 'goto' || event.preparation)) throw new Error('歌曲序列只同步指定 Cue；埋步和执行器动作请保留在原时间线');
    const id = event.effectGroupId ?? event.id; const ms = lightingEventTime(clip, event, map);
    const group = groups.get(id) ?? { name: event.label, atMs: ms, values: [] };
    group.atMs = Math.min(group.atMs, ms); if (event.id === id) group.name = event.label;
    group.values.push({ event, ms }); groups.set(id, group);
  }
  return [...groups].map(([id, group]) => {
    // The step's effect speed follows the song's tempo where the point fires.
    const speed = lightingPointEffectSpeed(group.values.map(value => value.event), group.name);
    return { id, name: group.name, atMs: group.atMs, cues: group.values.flatMap(({ event, ms }) => event.kind === 'ma2' && event.sequence && event.cue ? [{ sequence: event.sequence, cue: event.cue, delayMs: ms - group.atMs }] : []),
      ...(speed ? { effectBpm: lightingEffectBpm(document, speed, group.atMs) } : {}) };
  }).sort((a, b) => a.atMs - b.atMs);
}

/** Apply only the positions observed by this request. Concurrent local edits remain pending. */
export function applyMa2SongReadback(document: LightingDocument, observed: Ma2SongPoint[], result: Ma2SongSyncResult): LightingDocument {
  const current = new Map(ma2SongPoints(document).map(point => [point.id, point]));
  const unchanged = new Set(observed.filter(point => JSON.stringify(point) === JSON.stringify(current.get(point.id))).map(point => point.id));
  const mapping = new Map(result.binding.points.map(point => [point.id, point.cue]));
  const cues = result.library.sequences.find(value => value.sequence === result.binding.sequence)?.cues ?? [];
  // A combined point becomes one event on the song's own Cue; it keeps the point's effect speed.
  const speeds = new Map<string, LightingEffectSpeed>();
  for (const track of document.tracks) for (const clip of track.clips) for (const event of clip.events) if (event.kind === 'ma2' && event.effectSpeed) speeds.set(event.effectGroupId ?? event.id, event.effectSpeed);
  return lightingDocumentSchema.parse({ ...document, version: 2, consoleSong: result.binding, tracks: document.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, events: clip.events.flatMap((event): LightingEvent[] => {
    const id = event.effectGroupId ?? event.id;
    if (!unchanged.has(id)) return [event];
    const cue = mapping.get(id); if (!cue || event.kind !== 'ma2' && event.kind !== 'empty-cue') return [event];
    // The console holds pinyin for a Chinese label; only a name changed on the console replaces it.
    const consoleName = cues.find(value => Number(value.number) === Number(cue))?.name;
    const label = !consoleName || consoleName === consoleLabelText(event.label) ? event.label : consoleName;
    if (event.id !== id) return [];
    return [{ id, kind: 'ma2', at: event.at, action: 'goto', executor: result.binding.executor ?? '', sequence: result.binding.sequence, cue,
      label,
      ...(event.beatAnchor === undefined ? {} : { beatAnchor: event.beatAnchor }),
      ...(speeds.has(id) ? { effectSpeed: speeds.get(id) } : {}),
      runMode: event.runMode ?? (document.outputMode === 'timecode' ? undefined : 'independent') }];
  }) })) })) });
}
