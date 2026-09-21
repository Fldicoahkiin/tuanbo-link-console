import { type LightingDocument, type LightingEvent } from '@tb/schema';
import { LightingTempoMap, lightingEventTime } from './lighting-edit';

export function lightingEffectMembers(document: LightingDocument, id: string): string[] {
  const events = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events));
  const selected = events.find(event => event.id === id);
  return selected?.effectGroupId ? events.filter(event => event.effectGroupId === selected.effectGroupId).map(event => event.id) : [id];
}
export function removeLightingEffects(document: LightingDocument, ids: string[]): LightingDocument {
  const selected = new Set(ids.flatMap(id => lightingEffectMembers(document, id)));
  if (document.tracks.some(track => track.locked && track.clips.some(clip => clip.events.some(event => selected.has(event.id))))) throw new Error('组合中包含锁定轨道，不能删除');
  return { ...document, tracks: document.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, events: clip.events.filter(event => !selected.has(event.id)) })) })) };
}
export function moveLightingEffect(document: LightingDocument, id: string, ms: number, durationMs: number, cue?: string): LightingDocument {
  const map = new LightingTempoMap(document.tempos);
  const members = new Set(lightingEffectMembers(document, id));
  const all = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.map(event => ({ track, clip, event, ms: lightingEventTime(clip, event, map) }))));
  const anchor = all.find(value => value.event.id === id);
  if (!anchor) throw new Error('Cue 已不存在');
  const offset = ms - anchor.ms;
  for (const value of all.filter(value => members.has(value.event.id))) {
    if (value.track.locked) throw new Error('组合中包含锁定轨道，不能移动');
    const start = value.clip.timeLock === 'time' ? value.clip.start : map.beatToMs(value.clip.start);
    if (value.ms + offset < start || value.ms + offset >= durationMs) throw new Error('组合中的 Cue 超出音频或片段范围');
  }
  return { ...document, tracks: document.tracks.map(track => ({ ...track, clips: track.clips.map(clip => {
    const events = clip.events.map((event): LightingEvent => {
      if (!members.has(event.id)) return event;
      const target = lightingEventTime(clip, event, map) + offset;
      const at = (clip.timeLock === 'time' ? target : map.msToBeat(target)) - clip.start;
      return event.kind === 'ma2' && event.id === id && cue !== undefined ? { ...event, at, cue } : { ...event, at };
    });
    return { ...clip, events, duration: Math.max(clip.duration, ...events.map(event => event.at + (event.kind === 'note' ? event.duration : 1))) };
  }) })) };
}
