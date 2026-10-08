import { createLightingUserLibrary, lightingLibraryViewSchema, lightingUserLibrarySchema, parseLinkProject, validateLinkProjectRelations, type LightingDocument, type LightingEvent, type LightingLibraryEntry, type LightingUserLibrary, type LinkProject } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { LightingTempoMap, lightingEventTime } from './lighting-edit';
import { assertMusicCueConflicts } from './lighting-music';
const completedLibraries = new WeakMap<LightingUserLibrary,LightingUserLibrary>();
const beatCategories = createLightingUserLibrary().categories.filter(category=>category.view==='beat');

/** Legacy song templates remain untouched until a user explicitly changes the library. */
export function projectLightingLibrary(project: LinkProject): LightingUserLibrary {
  if (project.ma2MaterialLibrary?.userLibrary) {
    const current = project.ma2MaterialLibrary.userLibrary;
    const cached = completedLibraries.get(current); if(cached) return cached;
    const missing = beatCategories.filter(category=>!current.categories.some(value=>value.id===category.id));
    const completed = missing.length ? {...current,categories:[...current.categories,...missing]} : current;
    completedLibraries.set(current,completed);return completed;
  }
  const library = createLightingUserLibrary();
  const identities = new Set<string>();
  for (const item of project.rundown) for (const template of item.lighting?.templates ?? []) {
    const identity = JSON.stringify([template.sourceShow, template.name, template.track.cueStamp, template.members, template.track.clips]);
    if (identities.has(identity)) continue;
    identities.add(identity);
    const categoryIds = (template.categories ?? []).map(name => {
      let category = library.categories.find(value => value.section === 'effect' && value.view === 'shape' && value.name === name);
      if (!category) { category = { id: `legacy:${encodeURIComponent(name)}`, name, section: 'effect', view: 'shape' }; library.categories.push(category); }
      return category.id;
    });
    library.entries.push({ id: library.entries.some(entry => entry.id === template.id) ? `${item.id}:${template.id}` : template.id, name: template.name, originalName: template.name, revision: 1, kind: template.nativeSequence ? 'sequence' : template.members ? 'combination' : 'single', categoryIds, favorite: template.favorite ?? false, source: { endpoint: '', show: template.sourceShow ?? '', verified: false }, track: template.track, ...(template.members ? { members: template.members } : {}) });
  }
  return library;
}

export function libraryTemplates(library: LightingUserLibrary): LightingDocument['templates'] {
  const cached = templateCache.get(library.entries); if(cached) return cached;
  const templates = library.entries.map(entry => ({ id: entry.id, name: entry.name, track: entry.track, favorite: entry.favorite, categories: entry.categoryIds, libraryRevision: entry.revision, nativeSequence: entry.kind === 'sequence', ...(entry.source.show ? { sourceShow: entry.source.show } : {}), ...(entry.members ? { members: entry.members } : {}) }));
  templateCache.set(library.entries,templates);return templates;
}
const templateCache = new WeakMap<LightingUserLibrary['entries'],LightingDocument['templates']>();
export function libraryReferenceIssue(project: LinkProject, entry: LightingLibraryEntry): string | null {
  const pool = project.ma2MaterialLibrary;
  if (!pool?.library || pool.library.sourceUnverified) return '控台目录尚未核对，请读取当前 Show';
  if (!entry.source.verified || !entry.source.show || !entry.source.endpoint) return '旧素材来源待确认，请核对控台引用';
  if (entry.source.show !== pool.library.directory.show || entry.source.endpoint !== pool.source) return '此素材来自另一份 Show 或控台，保留原绑定，请明确重新绑定';
  const refs = entry.members ?? (entry.track.cueStamp?.mode === 'fixed' ? [entry.track.cueStamp] : []);
  for (const ref of refs) {
    const sequence = pool.library.sequences.find(value => value.sequence === ref.sequence);
    if (!sequence || !sequence.cues.some(cue => cue.number === ref.cue)) return `序列 ${ref.sequence} / Cue ${ref.cue} 已缺失或未读完整`;
  }
  return refs.length ? null : '缺少明确的控台引用';
}

export function setLightingLibraryCommand(input: LightingUserLibrary, label = '修改灯光分类库'): LinkCommand {
  const library = lightingUserLibrarySchema.parse(input);
  return { id: crypto.randomUUID(), label, scope: 'lighting', historyGroup:label === '浏览灯光分类' ? 'lighting-library-view' : undefined, execute(project) {
    const next:LinkProject = { ...project, schemaVersion: 2, updatedAt: new Date().toISOString(), ma2MaterialLibrary: { ...project.ma2MaterialLibrary, version: 2, source: project.ma2MaterialLibrary?.source ?? `project:${project.projectId}`, userLibrary: library } };
    validateLinkProjectRelations(next);return next;
  }, undo: before => before };
}

/** Navigation does not become an undo step or clone the Cue library. */
export function setLightingLibraryViewCommand(input: NonNullable<LightingUserLibrary['view']>): LinkCommand {
  const view=lightingLibraryViewSchema.parse(input);
  const apply=(project:LinkProject):LinkProject=>({...project,schemaVersion:2,ma2MaterialLibrary:{...project.ma2MaterialLibrary,version:2,source:project.ma2MaterialLibrary?.source ?? `project:${project.projectId}`,userLibrary:{...projectLightingLibrary(project),view}}});
  return {id:crypto.randomUUID(),label:'浏览灯光分类',scope:'lighting',execute:apply,undo:before=>before,rebaseHistory:apply,historyRebaseKey:'lighting-library-view'};
}

export function updateLibraryTemplates(project: LinkProject, templates: LightingDocument['templates']): LinkProject {
  const library = structuredClone(projectLightingLibrary(project));
  const entries: LightingLibraryEntry[] = templates.map(template => {
    const old = library.entries.find(entry => entry.id === template.id);
    const changed = old && JSON.stringify([old.track.cueStamp, old.members, old.track.clips]) !== JSON.stringify([template.track.cueStamp, template.members, template.track.clips]);
    const categoryIds = (template.categories ?? []).map(name => {
      const category = library.categories.find(value => value.id === name || value.name === name);
      if (category) return category.id;
      const id = `custom:${encodeURIComponent(name)}`;
      library.categories = [...library.categories, { id, name, section: 'effect', view: 'shape' }];
      return id;
    });
    return { id: template.id, name: template.name, originalName: old?.originalName ?? template.name, revision: (old?.revision ?? 1) + (changed ? 1 : 0), kind: template.nativeSequence ? 'sequence' : template.members ? 'combination' : 'single', categoryIds, favorite: template.favorite ?? false, source: old?.source ?? { endpoint: project.ma2MaterialLibrary?.source ?? '', show: template.sourceShow ?? project.ma2MaterialLibrary?.library?.directory.show ?? '', verified: Boolean(project.ma2MaterialLibrary?.library && !project.ma2MaterialLibrary.library.sourceUnverified) }, track: template.track, ...(template.members ? { members: template.members } : {}) };
  });
  return setLightingLibraryCommand({ ...library, entries }).execute(project);
}

export function libraryAffectedSongs(project: LinkProject, entry: LightingLibraryEntry): { itemId: string; title: string; positions: number[]; previous: string[]; next: string[] }[] {
  return project.rundown.flatMap(item => {
    if (!item.lighting) return [];
    const map = new LightingTempoMap(item.lighting.tempos);
    const positions = item.lighting.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.filter(event => event.librarySource?.id === entry.id && event.librarySource.revision < entry.revision).map(event => lightingEventTime(clip, event, map))));
    const previous = item.lighting.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.filter(event => event.librarySource?.id === entry.id && event.librarySource.revision < entry.revision).flatMap(event => event.kind === 'ma2' ? [`${event.label} · ${event.sequence}/${event.cue} · ${event.executor || '序列池'}`] : [])));
    const refs = entry.members ?? (entry.track.cueStamp?.mode === 'fixed' ? [{ ...entry.track.cueStamp, name:entry.name, delayMs:0 }] : []);
    const next = refs.map(ref => `${ref.name} · ${ref.sequence}/${ref.cue} · ${ref.executor || '序列池'} · +${ref.delayMs}ms`);
    return positions.length ? [{ itemId: item.id, title: item.title, positions, previous:[...new Set(previous)], next }] : [];
  });
}

export function updateLibraryPlacementsCommand(entryId: string, revision: number, itemIds: string[], expected?: Readonly<Record<string, LightingDocument>>): LinkCommand {
  return { id: crypto.randomUUID(), label: '更新选中歌曲的分类 Cue', scope: 'lighting', execute(project) {
    const entry = projectLightingLibrary(project).entries.find(value => value.id === entryId);
    if (!entry || entry.revision !== revision) throw new Error('分类素材已改变，请重新生成更新预览');
    const binding = entry.track.cueStamp;
    if (binding?.mode !== 'fixed') throw new Error('此素材没有可用的控台 Cue 引用');
    const members = entry.members ?? [{ name: entry.name, sequence: binding.sequence, cue: binding.cue, executor: binding.executor, delayMs: 0 }];
    return parseLinkProject({ ...project, updatedAt: new Date().toISOString(), rundown: project.rundown.map(item => {
      if (!itemIds.includes(item.id) || !item.lighting) return item;
      if (expected && JSON.stringify(expected[item.id]) !== JSON.stringify(item.lighting)) throw new Error(`“${item.title}”已改变，请重新生成更新预览`);
      const lighting = item.lighting; const map = new LightingTempoMap(lighting.tempos);
      const groups = new Map<string, { at: number; ids: Set<string>; originals: LightingEvent[]; trackId: string; clipId: string }>();
      for (const track of lighting.tracks) for (const clip of track.clips) for (const event of clip.events) {
        if (event.librarySource?.id !== entryId || event.librarySource.revision >= revision) continue;
        if (track.locked) throw new Error(`“${item.title}”的轨道已锁定`);
        if (clip.timeLock !== 'time') throw new Error(`“${item.title}”需先将素材片段转换为固定时间再更新`);
        const id = event.effectGroupId ?? event.id; const at = lightingEventTime(clip, event, map);
        const group = groups.get(id) ?? { at, ids: new Set<string>(), originals: [], trackId: track.id, clipId: clip.id };
        group.at = Math.min(group.at, at); group.ids.add(event.id); group.originals.push(event); groups.set(id, group);
      }
      const removed = new Set([...groups.values()].flatMap(group => [...group.ids]));
      const tracks = lighting.tracks.map(track => ({ ...track, clips: track.clips.map(clip => {
        const events = clip.events.filter(event => !removed.has(event.id));
        for (const [groupId, group] of groups) {
          if (group.trackId !== track.id || group.clipId !== clip.id) continue;
          members.forEach((member, index) => {
            const at = group.at + member.delayMs;
            if (item.referenceAudio && at >= item.referenceAudio.durationMs) throw new Error(`“${item.title}”更新后超出歌曲范围`);
            const original = group.originals[index];
            const beatAnchor = original?.beatAnchor === undefined ? undefined : map.msToBeat(at - (lighting.music?.firstBeatMs ?? 0));
            events.push({ id: [...group.ids][index] ?? crypto.randomUUID(), kind: 'ma2', action: 'goto', label: member.name, at: at - clip.start, sequence: member.sequence, cue: member.cue, executor: member.executor, librarySource: { id: entryId, revision }, ...(beatAnchor === undefined ? {} : {beatAnchor}), ...(members.length > 1 ? { effectGroupId: groupId } : {}) });
          });
        }
        return { ...clip, events, duration: Math.max(clip.duration, ...events.map(event => event.at + (event.kind === 'note' ? event.duration : .001))) };
      }) }));
      const next = { ...lighting, version: 2 as const, tracks }; assertMusicCueConflicts(next);
      return { ...item, lighting: next };
    }) });
  }, undo: before => before };
}
