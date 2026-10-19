import { LightingTempoMap, lightingEventTime, normalizeMa2AutoBindings } from '@tb/core/link';
import { lightingMa2BindingSchema, type LightingDocument, type LightingEvent, type Ma2AutoBindPlan, type Ma2TimecodePreview } from '@tb/schema';

/** Restore only an exact, unique correspondence. Never infer that missing remote events may be deleted. */
export function recoverMa2AutoBinding(document: LightingDocument, preview: Ma2TimecodePreview, id: string): Ma2AutoBindPlan {
  const fail = (): never => { throw new Error(`Timecode ${preview.target} 的已有编排与本地不能唯一对应，请在歌曲导入中读取此时间线后核对；控台内容未覆盖`); };
  if (preview.unconverted.length) fail();
  const assignments: Ma2AutoBindPlan['assignments'] = [];
  const poolSequences = new Set(document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.flatMap(event => event.kind === 'ma2' && !event.executor && event.sequence ? [event.sequence] : []))));
  for (const mapping of preview.mappings) {
    if (!mapping.sequence) continue;
    const pool = poolSequences.has(mapping.sequence);
    if (pool && assignments.some(entry => entry.sequence === mapping.sequence && entry.executor !== mapping.executor)) fail();
    if (assignments.some(entry => entry.executor === mapping.executor && entry.sequence === mapping.sequence)) continue;
    const track = preview.document.tracks.find(entry => entry.id === mapping.trackId);
    if (!track) fail();
    assignments.push({ sequence: mapping.sequence, executor: mapping.executor, executorName: track!.name, pool });
  }
  const empty = { id, timecode: preview.target, name: preview.name, readAt: preview.readAt, sourceXml: preview.sourceXml, baselineTracks: [], mappings: [], trackMappings: [], nativeEvents: [], playback: 'editable' as const };
  const normalized = normalizeMa2AutoBindings(document, { bindingId: id, newBinding: empty, assignments });
  const existingTracks = new Set(document.ma2Bindings?.flatMap(binding => [...binding.baselineTracks.map(track => track.id), ...binding.pendingTracks?.map(track => track.trackId) ?? []]));
  const clock = new LightingTempoMap(normalized.tempos);
  const key = (event: LightingEvent, time: number, muted: boolean): string => {
    const frame = Math.round(time * 30 / 1000);
    if (event.kind === 'ma2') return JSON.stringify([event.kind, event.executor, event.action, event.sequence ?? null, event.cue ? Number(event.cue) : null, frame, muted]);
    if (event.kind === 'ma2-fader') return JSON.stringify([event.kind, event.executor, event.fader, event.level, frame, muted]);
    return '';
  };
  const candidates = normalized.tracks.filter(track => !existingTracks.has(track.id)).flatMap(track => track.clips.flatMap(clip => clip.events.map(event => ({ track, clip, event, key: key(event, lightingEventTime(clip, event, clock), track.muted || clip.muted) }))));
  const identities = new Map<string, typeof candidates[number]>();
  const used = new Set<string>(); const trackIds = new Map<string, string>();
  for (const track of preview.document.tracks) {
    for (const clip of track.clips) for (const event of clip.events) {
      const signature = key(event, clip.start + event.at, track.muted || clip.muted);
      const matches = candidates.filter(candidate => candidate.key === signature);
      if (matches.length !== 1 || used.has(matches[0]!.event.id)) fail();
      const match = matches[0]!;
      if (trackIds.has(track.id) && trackIds.get(track.id) !== match.track.id) fail();
      trackIds.set(track.id, match.track.id); identities.set(event.id, match); used.add(match.event.id);
    }
    if (!trackIds.has(track.id)) fail();
  }
  if (new Set(trackIds.values()).size !== trackIds.size) fail();
  const baselineTracks = preview.document.tracks.map(track => {
    const clips = new Map<string, typeof track.clips[number]>();
    for (const clip of track.clips) for (const event of clip.events) {
      const match = identities.get(event.id)!;
      const baseline = clips.get(match.clip.id) ?? { ...clip, id: match.clip.id, start: 0, timeLock: 'time' as const, events: [] };
      baseline.events.push({ ...event, id: match.event.id, at: clip.start + event.at });
      clips.set(match.clip.id, baseline);
    }
    return { ...track, id: trackIds.get(track.id)!, clips: [...clips.values()] };
  });
  const binding = lightingMa2BindingSchema.parse({ ...empty, baselineTracks, cueCatalog: preview.cueCatalog,
    mappings: preview.mappings.map(mapping => { const match = identities.get(mapping.eventId); if (!match) return fail(); return { ...mapping, eventId: match.event.id, trackId: match.track.id, clipId: match.clip.id }; }),
    trackMappings: preview.trackMappings?.map(mapping => ({ ...mapping, trackId: trackIds.get(mapping.trackId)! }))
  });
  return { bindingId: id, newBinding: binding, assignments };
}
