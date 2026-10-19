import { type Ma2AttributeGroup, type Ma2CueAttributes, type Ma2AttributeRole, type Ma2EffectLibrary, type LightingLibraryEntry } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { projectLightingLibrary, setLightingLibraryCommand } from './lighting-library';
import { updateConsoleCueCategoriesCommand, type ConsoleCueReference } from './lighting-library-classification';
import { saveMa2MaterialLibraryCommand } from './ma2-program-import';

/** Metadata refresh must not certify old fixture data or erase manual categories. */
export function mergeMa2MetadataCommand(source: string, result: Ma2EffectLibrary): LinkCommand {
  const apply: LinkCommand['execute'] = project => {
    const cache = project.ma2MaterialLibrary;
    if (!cache?.library || cache.source !== source || result.sourceUnverified || ['show', 'generation', 'version'].some(key => Reflect.get(cache.library!.directory, key) !== Reflect.get(result.directory, key))) throw new Error('控台或 Show 已变化，页面素材未合入原目录');
    if (result.errors.length) throw new Error(result.errors.map(error => `序列 ${error.sequence}：${error.message}`).join('；'));
    const incoming = new Map(result.sequences.map(sequence => [sequence.sequence, sequence]));
    const sequences = [...cache.library.sequences.filter(sequence => !incoming.has(sequence.sequence) && result.directory.entries.some(entry => entry.target === sequence.sequence)), ...result.sequences];
    return saveMa2MaterialLibraryCommand(source, { ...cache.library, directory: result.directory, readAt: result.readAt, sequences }).execute(project);
  };
  return { id: crypto.randomUUID(), label: '回读页面 Cue 名称', historyRebaseKey: `ma2-page-metadata:${source}`, rebaseHistory: project => project.ma2MaterialLibrary?.source === source && project.ma2MaterialLibrary.library?.directory.generation === result.directory.generation ? apply(project) : project, execute: apply, undo: before => before };
}

export const ma2AttributeRoles: Readonly<Record<Ma2AttributeRole, string>> = {
  intensity: '亮度', position: '位置 / XY', gobo: '图案', color: '颜色', beam: '光束', focus: '聚焦 / 缩放',
  control: '控制', shapers: '切割 / 遮扉', video: '视频 / 媒体', shutter: '频闪 / 快门', effect: '属性效果',
  other: '控台扩展分类', unresolved: '属性读取不完整', unwritten: '本步无属性'
};
const presetRoles = new Map<string, Ma2AttributeRole>([
  ['DIMMER', 'intensity'], ['POSITION', 'position'], ['GOBO', 'gobo'], ['COLOR', 'color'], ['BEAM', 'beam'],
  ['FOCUS', 'focus'], ['CONTROL', 'control'], ['SHAPERS', 'shapers'], ['VIDEO', 'video']
]);

/** Use the current Show's actual hierarchy, never mutable numbers or name-prefix guesses. */
export function classifyMa2Attributes(value: Pick<Ma2CueAttributes, 'attributes' | 'hasEffects'> & Partial<Pick<Ma2CueAttributes, 'groups' | 'unknownChannels' | 'content'>>): { roles: Ma2AttributeRole[]; unknown: string[] } {
  const roles = new Set<Ma2AttributeRole>(); const unknown: string[] = [];
  const groups = new Map(value.groups?.map(group => [group.attribute, group]));
  for (const attribute of value.attributes) {
    const group = groups.get(attribute);
    if (!group) { unknown.push(attribute); continue; }
    roles.add(presetRoles.get(group.presetType) ?? 'other');
    // Shutter is a useful secondary tag; the console's Beam parent is retained.
    if (group.presetType === 'BEAM' && group.feature === 'SHUTTER') roles.add('shutter');
  }
  if (unknown.length || value.unknownChannels || value.content?.state === 'partial') roles.add('unresolved');
  if (!value.attributes.length && !value.unknownChannels) roles.add(value.content?.state === 'complete' ? 'unwritten' : 'unresolved');
  if (value.hasEffects) roles.add('effect');
  return { roles: (Object.keys(ma2AttributeRoles) as Ma2AttributeRole[]).filter(role => roles.has(role)), unknown };
}

function customPresetCategory(group: Ma2AttributeGroup): { id: string; name: string } | null {
  return presetRoles.has(group.presetType) ? null : { id: `attribute:preset:${encodeURIComponent(group.presetType)}`, name: group.presetName.slice(0, 64) };
}

/** Merges only selected, freshly verified sequences; other cached cues are preserved. */
export function mergeMa2AttributesCommand(source: string, result: Ma2EffectLibrary, targets: number[], autoClassify: boolean): LinkCommand {
  return { id: crypto.randomUUID(), label: autoClassify ? '读取属性并自动分类' : '读取 Cue 属性', scope: 'lighting', execute(project) {
    const cache = project.ma2MaterialLibrary;
    if (!cache?.library || cache.source !== source || ['show', 'generation', 'version'].some(key => Reflect.get(cache.library!.directory, key) !== Reflect.get(result.directory, key)) || result.sourceUnverified) throw new Error('控台或 Show 已变化，属性结果未合入原目录');
    const failed = new Set(result.errors.map(entry => entry.sequence));
    const byCue = new Map(result.cueAttributes?.map(value => [`${value.sequence}:${value.cueIndex}`, value]));
    const partial = result.sequences.filter(sequence => sequence.cues.some(cue => {
      const details = byCue.get(`${sequence.sequence}:${cue.index}`);
      return !details || details.content?.state !== 'complete' || classifyMa2Attributes(details).roles.includes('unresolved');
    }));
    for (const sequence of partial) failed.add(sequence.sequence);
    const good = new Set(result.sequences.filter(sequence => targets.includes(sequence.sequence) && !failed.has(sequence.sequence)).map(entry => entry.sequence));
    const keep = (sequence: number): boolean => !good.has(sequence) && result.directory.entries.some(entry => entry.target === sequence);
    const merge = <T extends { sequence: number }>(old: T[], incoming: T[]): T[] => {
      const previous = new Set(old.map(entry => entry.sequence));
      return [...old.filter(entry => keep(entry.sequence)), ...incoming.filter(entry => good.has(entry.sequence) || !previous.has(entry.sequence))];
    };
    const errors = [...result.errors, ...partial.filter(sequence => !result.errors.some(error => error.sequence === sequence.sequence)).map(sequence => ({ sequence: sequence.sequence, message: '部分属性数据不完整，已保留此前读取结果和分类；请查看属性详情并手动补读' }))];
    const merged: Ma2EffectLibrary = { ...cache.library, directory: result.directory, readAt: result.readAt,
      // Verified names and numbers remain useful even if fixture detail is incomplete.
      sequences: [...cache.library.sequences.filter(sequence => !result.sequences.some(incoming => incoming.sequence === sequence.sequence && !result.errors.some(error => error.sequence === incoming.sequence)) && result.directory.entries.some(entry => entry.target === sequence.sequence)), ...result.sequences.filter(sequence => !result.errors.some(error => error.sequence === sequence.sequence))],
      cueAttributes: merge(cache.library.cueAttributes ?? [], result.cueAttributes ?? []),
      fixtureUsage: merge(cache.library.fixtureUsage, result.fixtureUsage),
      errors: [...cache.library.errors.filter(entry => !targets.includes(entry.sequence) && keep(entry.sequence)), ...errors] };
    let next = saveMa2MaterialLibraryCommand(source, merged).execute(project);
    if (!autoClassify) return next;
    const library = projectLightingLibrary(next);
    const categories = [...library.categories];
    for (const [role, name] of Object.entries(ma2AttributeRoles)) if (!categories.some(category => category.id === `attribute:${role}`)) categories.push({ id: `attribute:${role}`, name, section: 'effect', view: 'shape', custom: true });
    for (const details of result.cueAttributes ?? []) for (const group of details.groups ?? []) {
      const category = customPresetCategory(group);
      if (category && !categories.some(value => value.id === category.id)) categories.push({ ...category, section: 'effect', view: 'shape', custom: true });
    }
    const entries = library.entries.map(entry => {
      const ref = entry.track.cueStamp;
      if (ref?.mode !== 'fixed' || !good.has(ref.sequence) || entry.source.endpoint !== source || entry.source.show !== result.directory.show) return entry;
      return { ...entry, categoryIds: entry.categoryIds.filter(id => !entry.autoCategoryIds?.includes(id)), autoCategoryIds: [] };
    });
    next = setLightingLibraryCommand({ ...library, categories, entries }).execute(next);
    const grouped = new Map<string, ConsoleCueReference[]>();
    const add = (role: string, ref: ConsoleCueReference): void => { const refs=grouped.get(role); if(refs)refs.push(ref);else grouped.set(role,[ref]); };
    for (const sequence of result.sequences) {
      if (!good.has(sequence.sequence)) continue;
      const whole = new Set<string>();
      for (const cue of sequence.cues) {
        const details = byCue.get(`${sequence.sequence}:${cue.index}`);
        if (!details) continue;
        const categoryIds = [...classifyMa2Attributes(details).roles.map(role => `attribute:${role}`), ...(details.groups ?? []).flatMap(group => customPresetCategory(group)?.id ?? [])];
        for (const role of new Set(categoryIds)) {
          whole.add(role); add(role, { sequence: sequence.sequence, cue: cue.number, kind: 'single' });
        }
      }
      const first = sequence.cues[0];
      if (first && sequence.cues.length > 1) for (const role of whole) add(role, { sequence: sequence.sequence, cue: first.number, kind: 'sequence' });
    }
    const manual = new Map(entries.map(entry => [entry.id, entry.categoryIds]));
    for (const [role, refs] of grouped) next = updateConsoleCueCategoriesCommand(refs, { add: [role], remove: [] }, { endpoint: source, show: result.directory.show }).execute(next);
    const classified = projectLightingLibrary(next);
    return setLightingLibraryCommand({ ...classified, entries: classified.entries.map((entry): LightingLibraryEntry => {
      const ref = entry.track.cueStamp;
      if (ref?.mode !== 'fixed' || !good.has(ref.sequence) || entry.source.endpoint !== source || entry.source.show !== result.directory.show) return entry;
      return { ...entry, autoCategoryIds: entry.categoryIds.filter(id => id.startsWith('attribute:') && !manual.get(entry.id)?.includes(id)) };
    }) }).execute(next);
  }, undo: before => before };
}

export function editLightingCategoryCommand(id: string, name: string | null): LinkCommand {
  return { id: crypto.randomUUID(), label: name === null ? '删除软件分类' : '编辑软件分类', scope: 'lighting', execute(project) {
    const library = projectLightingLibrary(project); const old = library.categories.find(category => category.id === id);
    if (old && !old.custom) throw new Error('此入口只管理自定义分类');
    if (name !== null && (!name.trim() || name.trim().length > 64)) throw new Error('分类名称需要 1–64 个字');
    const categories = name === null ? library.categories.filter(category => category.id !== id) : old ? library.categories.map(category => category.id === id ? { ...category, name: name.trim() } : category) : [...library.categories, { id, name: name.trim(), custom: true, section: 'effect' as const, view: 'shape' as const }];
    return setLightingLibraryCommand({ ...library, ...(name === null && library.navigation ? { navigation: library.navigation.filter(item => item.id !== `category:${id}`) } : {}), categories, entries: library.entries.map(entry => ({ ...entry, categoryIds: entry.categoryIds.filter(value => categories.some(category => category.id === value)), ...(entry.autoCategoryIds ? { autoCategoryIds: entry.autoCategoryIds.filter(value => categories.some(category => category.id === value)) } : {}) })) }).execute(project);
  }, undo: before => before };
}
