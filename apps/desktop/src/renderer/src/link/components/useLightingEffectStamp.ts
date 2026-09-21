import { removeLightingEffects, setLightingCommand, lightingEventTime, LightingTempoMap } from '@tb/core/link';
import { lightingDocumentSchema, type LightingDocument } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';

type Stamp = { effectId: string; ms: number; id: string; groupId?: string };
export function placeEffect(document: LightingDocument, stamp: Stamp, durationMs: number): LightingDocument {
  const effect = document.templates.find(entry => entry.id === stamp.effectId);
  const binding = effect?.track.cueStamp;
  if (!effect || binding?.mode !== 'fixed') throw new Error('请先绑定灯光效果');
  if (effect.members) {
    if (effect.members.some(member => stamp.ms + member.delayMs >= durationMs)) throw new Error('组合效果超出音频结尾，请提前放置');
    return [...effect.members].sort((a, b) => a.delayMs - b.delayMs).reduce((result, member, index) => {
      const temporary = { ...effect, name: member.name, members: undefined, track: { ...effect.track, cueStamp: { mode: 'fixed' as const, sequence: member.sequence, cue: member.cue, executor: member.executor } } };
      const value = placeEffect({ ...result, templates: result.templates.map(entry => entry.id === effect.id ? temporary : entry) }, { ...stamp, ms: stamp.ms + member.delayMs, id: index === 0 ? stamp.id : crypto.randomUUID(), groupId: stamp.id }, durationMs);
      return { ...value, templates: document.templates };
    }, document);
  }
  const existing = document.tracks.find(track => track.group === 'effect-canvas' && track.cueStamp?.mode === 'fixed' && track.cueStamp.executor === binding.executor && !track.locked);
  const track = existing ?? { ...effect.track, id: crypto.randomUUID(), name: '灯光', group: 'effect-canvas', clips: [] };
  const event = { id: stamp.id, ...(stamp.groupId ? { effectGroupId: stamp.groupId } : {}), kind: 'ma2' as const, action: 'goto' as const, label: effect.name, at: stamp.ms, executor: binding.executor, sequence: binding.sequence, cue: binding.cue };
  const clip = track.clips.find(entry => entry.timeLock === 'time' && entry.start === 0 && !entry.muted);
  const updatedClip = clip ? { ...clip, duration: Math.max(clip.duration, stamp.ms + 1), events: [...clip.events, event] } : { id: crypto.randomUUID(), name: effect.name, start: 0, duration: Math.max(durationMs, stamp.ms + 1), timeLock: 'time' as const, muted: false, events: [event] };
  const updated = { ...track, clips: [...track.clips.filter(entry => entry.id !== clip?.id), updatedClip] };
  return lightingDocumentSchema.parse({ ...document, tracks: existing ? document.tracks.map(entry => entry.id === track.id ? updated : entry) : [...document.tracks, updated] });
}
export function useLightingEffectStamp(itemId: string | null, document: LightingDocument, durationMs: number, notify: (message: string, tone?: 'info' | 'error') => void) {
  const documentId = useDocumentStore.getState().documentId;
  const commit = (id: string, value: LightingDocument): void => useDocumentStore.getState().execute(setLightingCommand(id, value, '添加灯光点'));
  const stamp = (effectId: string, ms: number, replaceId?: string): void => {
    if (!itemId || !durationMs) return;
    try {
      const state = useDocumentStore.getState();
      if (state.documentId !== documentId) throw new Error('工程已切换，请重新打点');
      let base = state.project?.rundown.find(item => item.id === itemId)?.lighting ?? document;
      if (replaceId) {
        const map = new LightingTempoMap(base.tempos);
        for (const track of base.tracks) for (const clip of track.clips) { const old = clip.events.find(event => event.id === replaceId); if (old) ms = lightingEventTime(clip, old, map); }
        base = removeLightingEffects(base, [replaceId]);
      }
      const value = placeEffect(base, { effectId, ms: Math.max(0, Math.min(Math.round(ms), durationMs - 1)), id: crypto.randomUUID() }, durationMs);
      commit(itemId, value);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
  return { stamp };
}
