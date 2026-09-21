import { LightingTempoMap, lightingClipSpan, nextLightingCue } from '@tb/core/link';
import type { LightingDocument, LightingTrack, LightingClip, LightingEvent } from '@tb/schema';

export function stampTimeline(document: LightingDocument, trackId: string | undefined, ms: number, durationMs: number, selectedClipId?: string): { document: LightingDocument; trackId: string; clipId: string; eventId: string | null } {
  if (!Number.isFinite(ms) || ms < 0 || ms >= durationMs) throw new Error('请将播放头移到音频范围内再打点');
  const track: LightingTrack = document.tracks.find(entry => entry.id === trackId) ?? (() => {
    if (document.tracks.length) throw new Error('请选择打点轨道');
    return { id: crypto.randomUUID(), kind: 'ma2', name: '灯光', color: '#ba8fff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [] };
  })();
  if (track.locked) throw new Error('打点轨道已锁定，请先解锁');
  const map = new LightingTempoMap(document.tempos);
  const matching = track.clips.filter(clip => { const span = lightingClipSpan(clip, map); return ms >= span.startMs && ms < span.endMs; });
  // Honor an explicit selection. Ambiguous overlaps get a separate manual clip;
  // existing clips and their events remain intact.
  const target = matching.find(clip => clip.id === selectedClipId) ?? (matching.length === 1 ? matching[0] : undefined);
  const clip: LightingClip = target ?? { id: crypto.randomUUID(), name: '手动打点', start: 0, duration: durationMs, timeLock: 'time', events: [], muted: false };
  if (track.cueStamp?.mode === 'marker') return { document: { ...document, markers: [...document.markers, { id: crypto.randomUUID(), name: `标记 ${document.markers.length + 1}`, startMs: ms, endMs: null }] }, trackId: track.id, clipId: clip.id, eventId: null };
  const base = { id: crypto.randomUUID(), at: (clip.timeLock === 'time' ? ms : map.msToBeat(ms)) - clip.start };
  const event: LightingEvent = track.kind === 'ma2' ? { ...base, kind: 'ma2', action: 'goto', ...nextLightingCue(document, track, ms) } : track.kind === 'automation' ? { ...base, kind: 'point', value: 127, shape: 'linear' } : { ...base, kind: 'note', note: 60, velocity: 127, duration: Math.min(clip.timeLock === 'time' ? 200 : 0.25, clip.duration - base.at) };
  const updated = { ...track, clips: [...track.clips.filter(entry => entry.id !== clip.id), { ...clip, events: [...clip.events, event] }] };
  return { document: { ...document, tracks: document.tracks.some(entry => entry.id === track.id) ? document.tracks.map(entry => entry.id === track.id ? updated : entry) : [...document.tracks, updated] }, trackId: track.id, clipId: clip.id, eventId: event.id };
}
