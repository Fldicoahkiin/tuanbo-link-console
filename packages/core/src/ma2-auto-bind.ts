import { lightingDocumentSchema, ma2AutoBindPlanSchema, parseLinkProject, type LightingDocument, type LightingEvent, type LightingTrack, type LinkProject, type Ma2AutoBindPlan } from '@tb/schema';
import type { LinkCommand } from './link-command';

function nativeBindings(document: LightingDocument) {
  return new Map(document.ma2Bindings?.flatMap(binding => [
    ...binding.baselineTracks.map(track => ({ trackId: track.id, binding, executor: binding.trackMappings?.find(mapping => mapping.trackId === track.id)?.executor ?? binding.mappings.find(mapping => mapping.trackId === track.id)?.executor })),
    ...binding.pendingTracks?.map(track => ({ trackId: track.trackId, binding, executor: track.executor })) ?? []
  ]).map(entry => [entry.trackId, entry]));
}

export function ma2AutoBindEvents(document: LightingDocument): Array<Extract<LightingEvent, { kind: 'ma2' | 'ma2-fader' }>> {
  const bound = nativeBindings(document);
  return document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.flatMap(event => {
    if (event.kind !== 'ma2' && event.kind !== 'ma2-fader') return [];
    const binding = bound.get(track.id);
    if (binding?.binding.nativeEvents?.length || binding?.binding.playback === 'native-timecode') return [];
    return !binding || !event.executor || binding.executor !== event.executor ? [event] : [];
  })));
}

/** Resolve physical addresses without changing event IDs, time locks or composition membership. */
export function normalizeMa2AutoBindings(input: LightingDocument, plan: Ma2AutoBindPlan): LightingDocument {
  const document = structuredClone(input);
  if (!document.ma2Bindings?.some(binding => binding.id === plan.bindingId)) {
    if (!plan.newBinding) throw new Error('自动同步的目标时间线已移除');
    document.ma2Bindings = [...document.ma2Bindings ?? [], structuredClone(plan.newBinding)];
  }
  const bound = nativeBindings(document);
  const destination = document.ma2Bindings.find(binding => binding.id === plan.bindingId)!;
  const names = new Map(plan.assignments.map(entry => [entry.executor, entry.executorName]));
  const managed = new Map(plan.assignments.filter(entry => entry.pool).map(entry => [entry.sequence, entry.executor]));
  const result: LightingTrack[] = [];
  for (const track of document.tracks) {
    const native = bound.get(track.id);
    if (native?.binding.nativeEvents?.length || native?.binding.playback === 'native-timecode') { result.push(track); continue; }
    const binding = native?.binding ?? destination;
    const groups = new Map<string, LightingTrack>();
    if (native) groups.set(native.executor ?? '', { ...track, clips: track.clips.map(clip => ({ ...clip, events: [] })) });
    for (const [clipIndex, clip] of track.clips.entries()) for (const event of clip.events) {
      const executor = event.kind === 'ma2' ? event.executor || managed.get(event.sequence ?? 0) || '' : event.kind === 'ma2-fader' ? event.executor : '';
      let group = groups.get(executor);
      if (!group) {
        const retainId = !native && groups.size === 0;
        const id = retainId ? track.id : `${track.id}:ma2:${executor || 'local'}`;
        group = { ...track, id, cueStamp: track.cueStamp?.mode === 'fixed' && executor ? { ...track.cueStamp, executor } : track.cueStamp,
          clips: track.clips.map(value => ({ ...value, id: retainId ? value.id : `${value.id}:ma2:${executor || 'local'}`, events: [] })) };
        groups.set(executor, group);
      }
      group.clips[clipIndex]!.events.push(event.kind === 'ma2' && executor ? { ...event, executor } : event);
    }
    if (!groups.size) { result.push(track); continue; }
    for (const [executor, group] of groups) {
      result.push(group);
      if (!executor || bound.has(group.id) || binding.pendingTracks?.some(entry => entry.trackId === group.id)) continue;
      const name = names.get(executor);
      // Edits made during I/O may introduce another target; the next cycle verifies it.
      if (!name) continue;
      binding.pendingTracks = [...binding.pendingTracks ?? [], { trackId: group.id, executor, executorName: name }];
    }
  }
  // A subsequent edit may resolve a group that was split in an earlier cycle.
  const tracks = new Map<string, LightingTrack>();
  for (const track of result) {
    const previous = tracks.get(track.id);
    if (!previous) { tracks.set(track.id, track); continue; }
    for (const clip of track.clips) {
      const retained = previous.clips.find(value => value.id === clip.id);
      if (retained) retained.events.push(...clip.events); else previous.clips.push(clip);
    }
  }
  return lightingDocumentSchema.parse({ ...document, tracks: [...tracks.values()] });
}

export function applyMa2AutoBindingsCommand(itemId: string, expected: LightingDocument, input: Ma2AutoBindPlan): LinkCommand {
  const plan = ma2AutoBindPlanSchema.parse(input);
  // History must retain the verified association even before the first local event existed.
  plan.newBinding ??= structuredClone(expected.ma2Bindings?.find(binding => binding.id === plan.bindingId));
  const rebase = (project: LinkProject): LinkProject => parseLinkProject({ ...project, schemaVersion: 2,
    rundown: project.rundown.map(item => item.id === itemId && item.lighting ? { ...item, lighting: normalizeMa2AutoBindings(item.lighting, plan) } : item)
  });
  const id = crypto.randomUUID();
  return { id, label: '自动准备控台同步', historyRebaseKey: `ma2-auto-bind:${itemId}:${id}`, rebaseHistory: rebase,
    execute(project) {
      const current = project.rundown.find(item => item.id === itemId)?.lighting;
      if (!current || JSON.stringify(current.ma2Bindings) !== JSON.stringify(expected.ma2Bindings)) throw new Error('准备同步时控台的绑定变了，自动关联已保留在控台，请重新开启同步');
      return rebase(project);
    }, undo: before => parseLinkProject(before) };
}
