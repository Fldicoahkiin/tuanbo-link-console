import type { LightingDocument, LightingEvent, LightingTrack } from '@tb/schema';
import { LightingTempoMap, lightingEventTime } from './lighting-edit';

type Cue = Extract<LightingEvent, { kind: 'ma2' }>;
type Entry = { atMs: number; event: Cue; track: LightingTrack };

function lightingCueTarget(event: Cue): string {
  return event.executor ? `executor:${event.executor}` : `sequence:${event.sequence}`;
}

/** Each logical Cue switches once, including all of its delayed/prepared ingredients.
 * Imported/legacy cues retain their previous behaviour until explicitly edited. */
export function planLightingCueRuns(document: LightingDocument): Entry[] {
  const map = new LightingTempoMap(document.tempos);
  const solo = document.tracks.some(track => track.solo && !track.muted);
  const groups = new Map<string, { start: number; mode: Cue['runMode'] }>();
  const entries: Array<Entry & { group: string }> = [];
  for (const track of document.tracks) {
    if (track.muted || solo && !track.solo) continue;
    for (const clip of track.clips) {
      if (clip.muted) continue;
      for (const event of clip.events) {
        if (event.kind !== 'ma2') continue;
        const atMs = lightingEventTime(clip, event, map);
        const start = atMs - (event.preparation?.leadMs ?? 0);
        if (start < 0) throw new Error(`“${event.label}”的埋步早于节目开始，请后移正式 Cue 或缩短提前时间`);
        const group = event.effectGroupId ?? event.id;
        const previous = groups.get(group);
        if (previous?.mode && event.runMode && previous.mode !== event.runMode) throw new Error('同一个 Cue 组合的运行方式不一致，请重新选择运行方式');
        groups.set(group, { start: Math.min(start, previous?.start ?? start), mode: event.runMode ?? previous?.mode });
        if (event.preparation) entries.push({ atMs: start, track, group, event: { ...event, cue: event.preparation.cue, preparation: undefined } });
        entries.push({ atMs, event, track, group });
      }
    }
  }
  const boundaries = new Set([...groups.values()].filter(group => group.mode === 'independent').map(group => group.start));
  const active = new Map<string, Entry>();
  const result: Entry[] = [];
  let cutoff = -Infinity;
  for (const entry of entries.sort((a, b) => a.atMs - b.atMs)) {
    if (boundaries.delete(entry.atMs)) {
      // All cues starting at the same time form one batch; never switch siblings off.
      for (const previous of active.values()) result.push({ atMs: entry.atMs, track: previous.track,
        event: { ...previous.event, action: 'off', cue: undefined, preparation: undefined } });
      active.clear(); cutoff = entry.atMs;
    }
    if (groups.get(entry.group)!.start < cutoff) continue;
    const target = lightingCueTarget(entry.event);
    if (entry.event.action === 'off') active.delete(target); else active.set(target, entry);
    result.push(entry);
  }
  return result;
}
