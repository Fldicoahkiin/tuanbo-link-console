import { parseLinkProject, type LightingDocument, type LightingTrack, type LinkProject } from '@tb/schema';
import type { LinkCommand } from './link-command';

function matchesSource(light: LightingDocument, source: string | undefined, show: string | undefined): boolean {
  return (!light.consoleSong || light.consoleSong.endpoint === source && light.consoleSong.show === show)
    && (!light.ma2Library || light.ma2Library.show === show);
}
/** Confirmed native moves remain true when the user undoes an unrelated timeline edit. */
export function applyMa2ExecutorChangeCommand(source: string, show: string, sequence: number | undefined, address: string, destination: string | null): LinkCommand {
  const apply = (project: LinkProject): LinkProject => {
    if (project.ma2MaterialLibrary?.source !== source || project.ma2MaterialLibrary.library?.directory.show !== show) return project;
    const next = structuredClone(project);
    const track = (value: LightingTrack): void => {
      if (value.cueStamp?.mode === 'fixed' && value.cueStamp.executor === address) value.cueStamp.executor = destination ?? '';
      for (const clip of value.clips) for (const event of clip.events) {
        if ((event.kind !== 'ma2' && event.kind !== 'ma2-fader') || event.executor !== address) continue;
        if (destination) event.executor = destination;
        else if (event.kind === 'ma2' && event.action === 'goto' && event.sequence) event.executor = '';
      }
    };
    for (const item of next.rundown) {
      const light = item.lighting;
      if (!light || !matchesSource(light, source, show)) continue;
      const song = light.consoleSong;
      if (song?.endpoint === source && song.show === show && song.sequence === sequence && song.executor === address) {
        song.assignment = destination ? 'assigned' : 'unassigned';
        if (destination) song.executor = destination;
      }
      light.tracks.forEach(track);
      for (const template of light.templates) {
        if (template.sourceShow && template.sourceShow !== show) continue;
        track(template.track);
        for (const member of template.members ?? []) if (member.executor === address) member.executor = destination ?? '';
      }
      // The baseline still describes the original console snapshot. The next
      // Timecode reconciliation verifies any native changes before writing it.
      if (destination) for (const binding of light.ma2Bindings ?? []) {
        for (const reference of [...binding.pendingTracks ?? [], ...binding.trackMappings ?? [], ...binding.mappings]) {
          if (reference.executor === address) reference.executor = destination;
        }
      }
    }
    for (const entry of next.ma2MaterialLibrary?.userLibrary?.entries ?? []) {
      if (entry.source.endpoint !== source || entry.source.show !== show) continue;
      track(entry.track);
      for (const member of entry.members ?? []) if (member.executor === address) member.executor = destination ?? '';
    }
    return parseLinkProject(next);
  };
  return { id: crypto.randomUUID(), label: destination ? '记录控台执行器新位置' : '记录控台执行器解除分配', scope: 'lighting', execute: apply, undo: before => before, rebaseHistory: apply, historyRebaseKey: `ma2-executor:${source}:${address}:${crypto.randomUUID()}` };
}

/** These actions have no sequence-pool equivalent; show them before deleting their target. */
export function ma2ExecutorDeletionUses(project: LinkProject, address: string): string[] {
  const needsExecutor = (track: LightingTrack): boolean => track.clips.some(clip => clip.events.some(event =>
    (event.kind === 'ma2-fader' || event.kind === 'ma2' && (event.action !== 'goto' || !event.sequence)) && event.executor === address));
  const message = '含执行器专用动作，请先重新指定这些动作的目标';
  const material = project.ma2MaterialLibrary;
  const show = material?.library?.directory.show;
  const uses = project.rundown.flatMap(item => {
    const light = item.lighting;
    if (!light || !matchesSource(light, material?.source, show)) return [];
    // The song's own executor is where its Timecode show fires the song; the song sync would put it straight back.
    const song = light.consoleSong;
    const ownExecutor = song?.executor === address && song.assignment !== 'unassigned' && song.endpoint === material?.source && song.show === show;
    return [
      ...(ownExecutor ? [`${item.title}：这是本曲控台序列 ${song.sequence} 的执行器，时间码靠它演出本曲；要换位置请移动，不要删除`] : []),
      ...(light.tracks.some(needsExecutor) ? [`${item.title}：${message}`] : []),
      ...light.templates.filter(template => (!template.sourceShow || template.sourceShow === show) && needsExecutor(template.track)).map(template => `${item.title} · 素材「${template.name}」：${message}`)
    ];
  });
  for (const entry of material?.userLibrary?.entries ?? []) {
    if (entry.source.endpoint === material?.source && entry.source.show === material.library?.directory.show && needsExecutor(entry.track)) uses.push(`素材「${entry.name}」：${message}`);
  }
  return uses;
}
