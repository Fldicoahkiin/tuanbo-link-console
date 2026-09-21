import { lightingDocumentSchema, type LightingDocument, type LightingTrack } from '@tb/schema';
import { LightingTempoMap, lightingEventTime } from './lighting-edit';
import { nextLightingCue } from './lighting-cue-sequence';

export function hasAutomaticCueBatch(document: LightingDocument, sha256: string, durationMs: number): boolean {
  if (!document.tracks.some(track => track.clips.some(clip => clip.events.some(event => event.kind === 'ma2')))) return false;
  return document.tracks.some(track => track.clips.some(clip => clip.name === '音频标记 Cue' && clip.events.some(event => event.kind === 'ma2')))
    || document.autoCueSource?.sha256 === sha256 && document.autoCueSource.durationMs === durationMs;
}

/** Build once and commit once: errors leave the original document untouched. */
export function cuesFromAudioMarks(document: LightingDocument, marks: readonly number[], durationMs: number, selectedClipId: string | null, sha256: string): LightingDocument {
  if (hasAutomaticCueBatch(document, sha256, durationMs)) return document;
  const candidates = document.tracks.filter(track => track.kind === 'ma2' && !track.locked);
  let target = candidates.find(track => track.clips.some(clip => clip.id === selectedClipId));
  const populated = candidates.filter(track => track.clips.some(clip => clip.events.length));
  if (!target && populated.length === 1) target = populated[0];
  if (!target && candidates.length > 1) throw new Error('请先点击目标灯光轨道的一个 Cue，再一键打 Cue');
  target ??= candidates[0];
  if (!target && document.tracks.some(track => track.kind === 'ma2')) throw new Error('灯光轨道已锁定');
  const track: LightingTrack = target ?? { id: crypto.randomUUID(), name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, cueStamp: { mode: 'sequence' }, clips: [] };
  const map = new LightingTempoMap(document.tempos);
  const occupied = track.clips.flatMap(clip => clip.events.filter(event => event.kind === 'ma2').map(event => lightingEventTime(clip, event, map)));
  const points = [...new Set(marks.map(Math.round))].filter(ms => Number.isFinite(ms) && ms >= 0 && ms < durationMs && !occupied.some(time => Math.abs(time - ms) < 1)).sort((a, b) => a - b);
  if (!points.length) throw new Error('没有需要新增的标记，已有位置不会重复打 Cue');
  const clip = { id: crypto.randomUUID(), name: '音频标记 Cue', start: 0, duration: durationMs, timeLock: 'time' as const, muted: false, events: [] as LightingTrack['clips'][number]['events'] };
  let updated = { ...track, clips: [...track.clips, clip] };
  for (const at of points) {
    const cue = nextLightingCue(document, updated, at);
    const events = [...updated.clips.at(-1)!.events, { id: crypto.randomUUID(), at, kind: 'ma2' as const, action: 'goto' as const, ...cue }];
    updated = { ...updated, clips: [...updated.clips.slice(0, -1), { ...clip, events }] };
  }
  return lightingDocumentSchema.parse({ ...document, tracks: target ? document.tracks.map(value => value.id === target.id ? updated : value) : [...document.tracks, updated] });
}
