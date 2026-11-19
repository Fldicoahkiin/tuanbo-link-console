import { addMa2SequenceCommand, hasMa2SongSyncTarget, songBeats, placeLightingTemplate, removeLightingEffects, setLightingCommand, lightingEventTime, LightingTempoMap, libraryReferenceIssue, libraryTemplates, projectLightingLibrary, placeConsoleCue, lightingSequenceSteps } from '@tb/core/link';
import { type LightingDocument } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { consoleCueDragSchema, type ConsoleCueDrag } from './lighting-material-drag';
import { ma2SequenceLibrary } from '../view-models/ma2-sequence-library';
import { useLightingSequencePlacement } from '../stores/lighting-sequence-placement-store';
import { ma2SongSyncSettings } from '../runtime/ma2-song-sync';
import { useCueTrackingPreference, useMa2RealtimePreference } from '../runtime/ma2-realtime-preference';
import { syncMa2Once } from '../runtime/ma2-realtime-session';

export function commitLightingPlacement(id: string, value: LightingDocument, label: string, wholeSequence = false): void {
  const state = useDocumentStore.getState(); const project = state.project;
  const item = project?.rundown.find(entry => entry.id === id);
  if (!project || !item) throw new Error('歌曲已删除，请重新选择');
  if (item.lighting === value) return;
  const create = !hasMa2SongSyncTarget(item.lighting);
  const settings = ma2SongSyncSettings(project, id);
  state.execute(create || wholeSequence ? addMa2SequenceCommand(id, value, { name: item.title, sequence: settings.nextSequence, timecode: settings.nextSequence, executor: `${settings.executorPage ?? 1000}.101` }, label) : setLightingCommand(id, value, label));
  if (create && (wholeSequence || useMa2RealtimePreference.getState().enabled)) syncMa2Once(id);
}

export function useLightingEffectStamp(itemId: string | null, document: LightingDocument, durationMs: number, notify: (message: string, tone?: 'info' | 'error') => void) {
  const documentId = useDocumentStore.getState().documentId;
  const commit = (id: string, value: LightingDocument, wholeSequence = false): void =>
    commitLightingPlacement(id, value, wholeSequence ? '添加整套 Cue' : '添加灯光点', wholeSequence);
  const stamp = (effectId: string, ms: number, replaceId?: string): void => {
    if (!itemId || !durationMs) return;
    try {
      const state = useDocumentStore.getState();
      if (state.documentId !== documentId) throw new Error('工程已切换，请重新打点');
      const item = state.project?.rundown.find(value => value.id === itemId);
      let base = item?.lighting ?? document;
      if (state.project?.ma2MaterialLibrary?.userLibrary) { const entry = state.project.ma2MaterialLibrary.userLibrary.entries.find(value => value.id === effectId); if (entry) { const issue = libraryReferenceIssue(state.project, entry); if (issue) throw new Error(issue); } }
      if (state.project) base = { ...base, templates: libraryTemplates(projectLightingLibrary(state.project)) };
      if (replaceId) {
        const map = new LightingTempoMap(base.tempos);
        for (const track of base.tracks) for (const clip of track.clips) { const old = clip.events.find(event => event.id === replaceId); if (old) ms = lightingEventTime(clip, old, map); }
        base = removeLightingEffects(base, [replaceId]);
      }
      const preset = base.templates.find(entry => entry.id === effectId)?.track.cueStamp;
      const includeTracking = (preset?.mode === 'fixed' ? preset.includeTracking : undefined) ?? useCueTrackingPreference.getState().includeTracking;
      const value = placeLightingTemplate(base, { effectId, ms, id: crypto.randomUUID(), includeTracking }, durationMs, ma2SequenceLibrary(state.project, base), useLightingSequencePlacement.getState().intervalBeats, item ? songBeats(item) : undefined);
      commit(itemId, value, Boolean(base.templates.find(entry => entry.id === effectId)?.nativeSequence));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const stampConsoleCue = (input: ConsoleCueDrag, ms: number): void => {
    if (!itemId) return;
    try {
      const reference = consoleCueDragSchema.parse(input);
      const state = useDocumentStore.getState();
      if (state.documentId !== documentId) throw new Error('工程已切换，请重新拖入');
      const item = state.project?.rundown.find(value => value.id === itemId);
      if (!item) throw new Error('歌曲已删除，请重新选择');
      const pool = state.project?.ma2MaterialLibrary?.library;
      if (!pool || pool.sourceUnverified || !pool.sequences.some(sequence => sequence.sequence === reference.sequence && sequence.cues.some(cue => cue.number === reference.cue))) throw new Error('控台素材已经变了或还没确认，请重新读取后再拖入');
      const base = item.lighting ?? document;
      if (reference.wholeSequence) {
        const sequence = ma2SequenceLibrary(state.project, base).find(value => value.sequence === reference.sequence);
        if (!sequence) throw new Error('这套 Cue 还没有读取，请重新读取控台素材');
        const steps = lightingSequenceSteps(base, sequence, reference.executor, ms, useLightingSequencePlacement.getState().intervalBeats, songBeats(item));
        commit(itemId, steps.reduce((value, step) => placeConsoleCue(value, { sequence: step.sequence, cue: step.cue, name: step.name, executor: step.executor, includeTracking: useCueTrackingPreference.getState().includeTracking }, ms + step.delayMs, durationMs), base), true);
      } else commit(itemId, placeConsoleCue(base, { ...reference, includeTracking: reference.includeTracking ?? useCueTrackingPreference.getState().includeTracking }, ms, durationMs));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
  return { stamp, stampConsoleCue };
}
