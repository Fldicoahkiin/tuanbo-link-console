import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, createLightingUserLibrary, parseLinkProject, serializeLinkProject, type LightingLibraryEntry } from '@tb/schema';
import { projectLightingLibrary, setLightingLibraryCommand, updateLibraryTemplates, libraryTemplates, updateLibraryPlacementsCommand, libraryReferenceIssue } from './lighting-library';
import { saveMa2MaterialLibraryCommand } from './ma2-program-import';
import { setLightingEffectSpeed } from './lighting-effect-speed';

const entry: LightingLibraryEntry = { id: 'light', name: '三人前区', originalName: '原名', revision: 1, kind: 'single', categoryIds: ['front:bright:3:front'], favorite: false, source: { endpoint: 'console', show: 'show', verified: true }, track: { id: 'track', name: '原名', kind: 'ma2', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [], cueStamp: { mode: 'fixed', sequence: 36, cue: '1.100', executor: '' } } };
it('建立 24 个面光、12 个轮廓空容器；同一效果可同时归入两种视图', () => {
  const library = createLightingUserLibrary();
  expect(library.categories.filter(value => value.section === 'front')).toHaveLength(24);
  expect(library.categories.filter(value => value.section === 'rim')).toHaveLength(12);
  const project = setLightingLibraryCommand({ ...library, categories:[...library.categories,{id:'effect:shape:1',section:'effect',view:'shape',name:'旧版频闪'}], entries: [{ ...entry, categoryIds: ['effect:music:3', 'effect:shape:1'] }] }).execute(createEmptyLinkProject('分类'));
  const restored = parseLinkProject(JSON.parse(serializeLinkProject(project)));
  expect(projectLightingLibrary(restored).entries).toHaveLength(1);
  expect(projectLightingLibrary(restored).entries[0]?.categoryIds).toEqual(['effect:music:3', 'effect:shape:1']);
  expect(restored.ma2MaterialLibrary?.version).toBe(2);
  expect(restored.ma2MaterialLibrary?.library).toBeUndefined();
});
it('扫描全序列池保留分类；改名称不改执行修订；改目标保留歌曲快照', () => {
  const base = createEmptyLinkProject('分类'); const document = createLightingDocument(); document.templates = [{ id: entry.id, name: entry.name, track: entry.track }];
  base.rundown.push({ id: 'song', title: '歌', enabled: true, notes: '', visualLayers: [], referenceMediaClips: [], cues: [], lighting: document });
  const saved = setLightingLibraryCommand({ ...createLightingUserLibrary(), entries: [entry] }).execute(base);
  const scanned = saveMa2MaterialLibraryCommand('console', { directory: { show: 'show', generation: 'one', version: '3.7.0.5', entries: [] }, readAt: new Date().toISOString(), sequences: [], fixtureUsage: [], errors: [] }).execute(saved);
  expect(projectLightingLibrary(scanned).entries).toEqual([entry]);
  const renamed = updateLibraryTemplates(scanned, libraryTemplates({ ...createLightingUserLibrary(), entries: [{ ...entry, name: '新名字' }] }));
  expect(projectLightingLibrary(renamed).entries[0]?.revision).toBe(1);
  expect(scanned.rundown[0]?.lighting?.templates[0]?.name).toBe(entry.name);
  const moved = updateLibraryTemplates(renamed, [{ ...libraryTemplates(projectLightingLibrary(renamed))[0]!, track: { ...entry.track, cueStamp: { mode: 'fixed', sequence: 36, cue: '2.000', executor: '' } } }]);
  expect(projectLightingLibrary(moved).entries[0]?.revision).toBe(2);
  expect(moved.rundown[0]?.lighting?.templates[0]?.track.cueStamp).toEqual(entry.track.cueStamp);
});
it('历史同名不同目标不合并、旧模板不被读操作修改', () => {
  const project = createEmptyLinkProject('迁移');
  for (const sequence of [36, 37]) { const document = createLightingDocument(); document.templates = [{ id: 'old', name: '相同名称', sourceShow: '历史 Show', track: { ...entry.track, cueStamp: { mode: 'fixed', sequence, cue: '1.100', executor: '' } } }]; project.rundown.push({ id: `song${sequence}`, title: '歌', enabled: true, notes: '', visualLayers: [], referenceMediaClips: [], cues: [], lighting: document }); }
  const before = JSON.stringify(project); const library = projectLightingLibrary(project);
  expect(library.entries).toHaveLength(2); expect(new Set(library.entries.map(value => value.id)).size).toBe(2);
  expect(JSON.stringify(project)).toBe(before);
});
it('更换绑定只更新明确选中的歌曲，一次撤销还原；来源相同编号不能冒认', () => {
  const base = createEmptyLinkProject('更新');
  for (const id of ['a','b']) { const document = createLightingDocument(); document.version = 2; document.tracks = [{ ...entry.track, clips: [{ id:'clip', name:'灯光', start:0, duration:30000, timeLock:'time', muted:false, events:[{ id:`event-${id}`,kind:'ma2',at:1500,sequence:36,cue:'1.100',executor:'',action:'goto',label:'旧',librarySource:{id:entry.id,revision:1} }] }] }]; base.rundown.push({ id, title:id, enabled:true, notes:'', visualLayers:[],referenceMediaClips:[],cues:[],lighting:document }); }
  const revised = { ...entry, revision:2, track:{ ...entry.track, cueStamp:{mode:'fixed' as const,sequence:42,cue:'3.250',executor:''} } };
  const project = setLightingLibraryCommand({ ...createLightingUserLibrary(), entries:[revised] }).execute(base);
  const command = updateLibraryPlacementsCommand(entry.id, 2, ['a']); const updated = command.execute(project);
  expect(updated.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]).toMatchObject({at:1500,sequence:42,cue:'3.250',librarySource:{revision:2}});
  expect(updated.rundown[1]).toEqual(project.rundown[1]);
  // A point's effect speed stays with it when its material updates.
  const timed = { ...project, rundown: project.rundown.map((item, index) => index ? item : { ...item, lighting: setLightingEffectSpeed(item.lighting!, 'event-a', { mode: 'fixed', bpm: 90 }) }) };
  expect(updateLibraryPlacementsCommand(entry.id, 2, ['a']).execute(timed).rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[0]).toMatchObject({ cue: '3.250', effectSpeed: { mode: 'fixed', bpm: 90 } });
  expect(command.undo(project)).toEqual(project);
  expect(() => updateLibraryPlacementsCommand(entry.id,1,['a']).execute(project)).toThrow('重新生成');
  const baseline={a:project.rundown[0]!.lighting!};
  expect(() => updateLibraryPlacementsCommand(entry.id,2,['a'],baseline).execute(updated)).toThrow('重新生成');
  const otherShow = saveMa2MaterialLibraryCommand('console', {directory:{show:'another',generation:'g',version:'3.7.0.5',entries:[]},readAt:new Date().toISOString(),sequences:[],fixtureUsage:[],errors:[]}).execute(project);
  expect(libraryReferenceIssue(otherShow,entry)).toContain('另一份 Show');
  expect(projectLightingLibrary(otherShow).entries[0]).toEqual(revised);
});

it('adds the eight beat-lighting containers to existing libraries without changing or duplicating Cue content',()=>{
  const project=createEmptyLinkProject('旧分类'); const old=createLightingUserLibrary();
  old.categories=old.categories.filter(category=>category.view!=='beat');
  project.schemaVersion=2;project.ma2MaterialLibrary={version:2,source:'test',userLibrary:old};
  const next=projectLightingLibrary(project);
  expect(next.categories.filter(category=>category.view==='beat').map(category=>category.beats)).toEqual([.25,.5,1,2,4,8,16,32]);
  expect(next.categories.filter(category=>category.section==='front')).toHaveLength(24);
  expect(next.categories.filter(category=>category.section==='rim')).toHaveLength(12);
  expect(next.entries).toBe(old.entries);expect(old.categories.some(category=>category.view==='beat')).toBe(false);
  expect(projectLightingLibrary(project)).toBe(next);
  const saved=setLightingLibraryCommand(next).execute(project);
  expect(parseLinkProject(JSON.parse(JSON.stringify(saved))).ma2MaterialLibrary!.userLibrary!.categories.filter(category=>category.view==='beat')).toHaveLength(8);
});
