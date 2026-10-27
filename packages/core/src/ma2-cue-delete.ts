import type { LinkProject, Ma2CueDeleteResult } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { projectLightingLibrary, setLightingLibraryCommand } from './lighting-library';
import { saveMa2MaterialLibraryCommand } from './ma2-program-import';

/** Removing even an empty step changes Go order; sequence bindings therefore count as uses. */
export function ma2CueDeletionUsage(project: LinkProject, sequence: number, cue: string): string[] {
  const reasons = new Set<string>();
  for (const song of project.rundown) {
    const light = song.lighting;
    if (!light) continue;
    if (light.ma2Bindings?.some(binding => binding.mappings.some(mapping => mapping.sequence === sequence) || binding.cueCatalog?.some(entry => entry.sequence === sequence))) reasons.add(`歌曲「${song.title}」的控台时间线使用此序列`);
    for (const track of [...light.tracks, ...light.templates.map(template => template.track)]) {
      if (track.cueStamp?.mode === 'fixed' && track.cueStamp.sequence === sequence && Number(track.cueStamp.cue) === Number(cue)) reasons.add(`歌曲「${song.title}」引用此 Cue`);
      if (track.clips.some(clip => clip.events.some(event => event.kind === 'ma2' && event.sequence === sequence && (event.cue === undefined || Number(event.cue) === Number(cue) || Number(event.preparation?.cue) === Number(cue))))) reasons.add(`歌曲「${song.title}」编排中引用此 Cue`);
    }
    if (light.templates.some(template => template.members?.some(ref => ref.sequence === sequence && Number(ref.cue) === Number(cue)))) reasons.add(`歌曲「${song.title}」组合素材引用此 Cue`);
  }
  if (projectLightingLibrary(project).entries.some(entry => entry.kind === 'combination' && entry.members?.some(ref => ref.sequence === sequence && Number(ref.cue) === Number(cue)))) reasons.add('组合素材引用此 Cue');
  return [...reasons];
}

/** External deletion is a confirmed baseline: local undo cannot resurrect console objects. */
export function applyMa2CueDeletionCommand(source: string, result: Ma2CueDeleteResult): LinkCommand {
  const rebase = (project: LinkProject): LinkProject => {
    const cache = project.ma2MaterialLibrary;
    if (!cache?.library || cache.source !== source || !result.deleted.length && !result.error || result.library && (cache.library.directory.show !== result.library.directory.show || cache.library.directory.generation !== result.library.directory.generation)) return project;
    const changed = new Set(result.deleted.map(ref => ref.sequence));
    const old = cache.library;
    const deleted = (ref: { sequence: number; cue: string }): boolean => result.deleted.some(value => value.sequence === ref.sequence && Number(value.cue) === Number(ref.cue));
    const nextLibrary = { ...old, directory: result.library?.directory ?? old.directory, readAt: result.library?.readAt ?? old.readAt,
      ...(!result.library || result.error ? { sourceUnverified: true } : {}),
      sequences: result.library ? [...old.sequences.filter(value => !changed.has(value.sequence)), ...result.library.sequences.filter(value => changed.has(value.sequence))] : old.sequences.map(sequence => ({ ...sequence, cues: sequence.cues.filter(cue => !deleted({sequence:sequence.sequence,cue:cue.number})) })),
      fixtureUsage: [...old.fixtureUsage.filter(value => !changed.has(value.sequence)), ...(result.library?.fixtureUsage.filter(value => changed.has(value.sequence)) ?? [])],
      cueAttributes: [...(old.cueAttributes ?? []).filter(value => !changed.has(value.sequence)), ...(result.library?.cueAttributes?.filter(value => changed.has(value.sequence)) ?? [])],
      errors: [...old.errors.filter(value => !changed.has(value.sequence)), ...(result.library?.errors.filter(value => changed.has(value.sequence)) ?? [...changed].map(sequence => ({sequence,message:'删除已确认，但重新读取控台失败；请刷新素材后再用'})))] };
    let next = saveMa2MaterialLibraryCommand(source, nextLibrary).execute(project);
    const user = projectLightingLibrary(next);
    const remainingFirst = (sequence: number): string | undefined => nextLibrary.sequences.find(value => value.sequence === sequence)?.cues[0]?.number;
    next = setLightingLibraryCommand({ ...user, entries: user.entries.flatMap(entry => {
      const ref = entry.track.cueStamp;
      if (entry.source.endpoint !== source || entry.source.show !== old.directory.show || ref?.mode !== 'fixed' || !deleted(ref)) return [entry];
      const first = remainingFirst(ref.sequence);
      return entry.kind === 'sequence' && first ? [{...entry,track:{...entry.track,cueStamp:{...ref,cue:first}}}] : [];
    }), ...(user.hiddenConsoleCues ? { hiddenConsoleCues: user.hiddenConsoleCues.flatMap(ref => {
      if (ref.endpoint !== source || ref.show !== old.directory.show || !deleted(ref)) return [ref];
      const first = remainingFirst(ref.sequence);
      return ref.kind === 'sequence' && first ? [{...ref,cue:first}] : [];
    }) } : {}), ...(user.consoleRenames ? { consoleRenames: user.consoleRenames.flatMap(ref => {
      if (ref.endpoint !== source || ref.show !== old.directory.show || !deleted(ref)) return [ref];
      const first = remainingFirst(ref.sequence);
      return ref.kind === 'sequence' && first ? [{...ref,cue:first}] : [];
    }) } : {}) }).execute(next);
    return next;
  };
  return { id: crypto.randomUUID(), label: '记录控台空 Cue 删除结果', historyRebaseKey: `ma2-delete:${crypto.randomUUID()}`, rebaseHistory: rebase, execute: rebase, undo: before => before };
}
