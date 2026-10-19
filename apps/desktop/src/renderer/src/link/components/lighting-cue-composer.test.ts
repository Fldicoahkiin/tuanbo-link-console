import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, lightingDocumentSchema, linkProjectSchema } from '@tb/schema';
import { cueEventEntries } from './cue-event-view';
import { cueIngredients, saveCueIngredients } from './LightingCueComposer';
import { compileLightingNetworkActions, compileLightingPackets, moveLightingEffect, removeLightingEffects, LightingScheduler } from '@tb/core/link';
import { ma2SequenceLibrary } from '../view-models/ma2-sequence-library';

it('空名称点位拖入控台素材，保存重开后仍从工程控台目录显示原名，组合名称与素材名称独立', () => {
  const project = createEmptyLinkProject('素材名称验收');
  project.schemaVersion = 2;
  project.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: {
    directory: { show: 'Show', generation: 'session', version: '3.7.0.5', entries: [] },
    readAt: new Date().toISOString(), fixtureUsage: [], errors: [], sequences: [
      { sequence: 294, name: 'bj 294', cues: [{ index: 1, number: '1.000', name: null }] },
      { sequence: 346, name: 'love shot 346', cues: [{ index: 1, number: '0.500', name: null }, { index: 2, number: '2.500', name: '  控台副歌  ' }] }
    ]
  } };
  const materials = [
    { name: 'bj 294', sequence: 294, cue: '1', executor: '', delayMs: 0 },
    { name: '控台副歌', sequence: 346, cue: '2.5', executor: '1.101', delayMs: 800 }
  ];
  const document = saveCueIngredients({ ...createLightingDocument(), outputMode: 'network' }, materials, '', 2000, 10000, 'point');
  project.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], lighting: document }];
  const reopened = linkProjectSchema.parse(JSON.parse(JSON.stringify(project)));
  const lighting = reopened.rundown[0]!.lighting!;
  const library = ma2SequenceLibrary(reopened, lighting);
  const entries = cueIngredients(lighting, 'point', library);
  expect(entries.map(value => [value.name, value.sequenceName, value.cue])).toEqual([
    ['bj 294', 'bj 294', '1'], ['  控台副歌  ', 'love shot 346', '2.5']
  ]);
  const renamed = saveCueIngredients(lighting, entries, '我的组合点位', 7000, 10000, 'point');
  expect(cueIngredients(renamed, 'point', library)).toEqual(entries);
  expect(compileLightingNetworkActions(renamed)).toEqual(compileLightingNetworkActions(lighting));
  expect(renamed.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).find(event => event.id === 'point')).toMatchObject({ label: '我的组合点位', at: 2000 });
  // A manually edited reference follows its actual Cue, rather than retaining the previous name.
  const changed = saveCueIngredients(renamed, [{ ...entries[1]!, cue: '0.5', delayMs: 0 }], '我的组合点位', 7000, 10000, 'point');
  expect(cueIngredients(changed, 'point', library)).toEqual([expect.objectContaining({ name: 'love shot 346', sequenceName: 'love shot 346', cue: '0.5' })]);
  const updatedLibrary = library.map(sequence => sequence.sequence === 294 ? { ...sequence, originalName: '控台更新名称' } : sequence);
  expect(cueIngredients(lighting, 'point', updatedLibrary)[0]?.name).toBe('控台更新名称');
});

it('移除所有素材保留空 Cue，重开后加新素材仅发送新目标并保留原时间和编号', () => {
  const original = saveCueIngredients({ ...createLightingDocument(), outputMode: 'network' }, ingredients, '点位', 2000, 10000, 'cue');
  const cleared = saveCueIngredients(original, [], '点位', 7000, 10000, 'cue');
  const reopened = lightingDocumentSchema.parse(JSON.parse(JSON.stringify(cleared)));
  expect(reopened.tracks.flatMap(track => track.clips.flatMap(clip => clip.events))).toEqual([{ id: 'cue', kind: 'empty-cue', at: 2000, label: '点位' }]);
  expect(cueIngredients(reopened, 'cue')).toEqual([]);
  expect(compileLightingNetworkActions(reopened)).toEqual([]);
  const filled = saveCueIngredients(reopened, [{ name: '新素材', sequence: 88, cue: '5.25', executor: '', delayMs: 0 }], '点位', 7000, 10000, 'cue');
  expect(cueIngredients(filled, 'cue')).toEqual([expect.objectContaining({ sequence: 88, cue: '5.25' })]);
  expect(compileLightingNetworkActions(filled)).toEqual([{ atMs: 2000, action: { target: 'sequence', action: 'goto', sequence: 88, cue: '5.25' } }]);
  expect(filled.tracks.flatMap(track => track.clips.flatMap(clip => clip.events))).toHaveLength(1);
});

it('埋步随工程保存重开及整体移动，网络调用先准备后正式，删除不残留', () => {
  const ingredients = [{ name: '蓝光', sequence: 168, cue: '2', executor: '', delayMs: 0, preparation: { cue: '1', leadMs: 1500 } }];
  const saved = saveCueIngredients({ ...createLightingDocument(), outputMode: 'network' }, ingredients, '副歌', 30000, 60000, 'cue');
  const reopened = lightingDocumentSchema.parse(JSON.parse(JSON.stringify(saved)));
  expect(cueIngredients(reopened, 'cue')).toEqual([expect.objectContaining({ preparation: { cue: '1', leadMs: 1500 } })]);
  expect(compileLightingNetworkActions(reopened)).toEqual([
    { atMs: 28500, action: { target: 'sequence', action: 'goto', sequence: 168, cue: '1' } },
    { atMs: 30000, action: { target: 'sequence', action: 'goto', sequence: 168, cue: '2' } }
  ]);
  expect(compileLightingNetworkActions(moveLightingEffect(reopened, 'cue', 20000, 60000)).map(entry => entry.atMs)).toEqual([18500, 20000]);
  expect(() => moveLightingEffect(reopened, 'cue', 1000, 60000)).toThrow('埋步');
  expect(compileLightingNetworkActions(removeLightingEffects(reopened, ['cue']))).toEqual([]);
  expect(() => saveCueIngredients(saved, ingredients, '太早', 500, 60000)).toThrow('埋步');
  expect(() => saveCueIngredients(saved, [{ ...ingredients[0]!, preparation: { cue: '2', leadMs: 1000 } }], '', 2000, 60000)).toThrow('准备 Cue');
  expect(() => compileLightingPackets({ ...reopened, outputMode: 'timecode' })).toThrow('埋步');
});

it('多素材可各自埋步、关闭后不残留；MIDI 定位不补发之前的准备 Cue', () => {
  const source = saveCueIngredients({ ...createLightingDocument(), outputMode: 'direct' }, ingredients.map(entry => ({ ...entry, preparation: { cue: '1', leadMs: 500 } })), '组合', 2000, 10000, 'cue');
  const packets = compileLightingPackets(source);
  expect(packets.map(entry => entry.atMs)).toEqual([1500, 1500, 2000, 2000]);
  const sent: number[] = [];
  const scheduler = new LightingScheduler(packets, packet => sent.push(packet.atMs));
  scheduler.locate(1700); scheduler.tick(2000);
  expect(sent).toEqual([2000, 2000]);
  const disabled = saveCueIngredients(source, ingredients, '组合', 2000, 10000, 'cue');
  expect(compileLightingPackets(disabled).map(entry => entry.atMs)).toEqual([2000, 2000]);
});

const ingredients = [
  { name: '光束', sequence: 1, cue: '2', executor: '1.101', delayMs: 0 },
  { name: '染色', sequence: 2, cue: '3', executor: '1.102', delayMs: 0 }
];
it('顺序组合保留各步延迟，保存与再次编辑不会压到同一时间', () => {
  const steps=[{...ingredients[0]!,executor:'',delayMs:0},{...ingredients[0]!,executor:'',cue:'3.25',delayMs:800}];
  const saved=saveCueIngredients(createLightingDocument(),steps,'顺序组合',1000,10000,'sequential');
  expect(cueIngredients(saved,'sequential').map(value=>value.delayMs)).toEqual([0,800]);
  const changed=saveCueIngredients(saved,[steps[0]!,{...steps[1]!,delayMs:1200}],'更新',1000,10000,'sequential');
  expect(cueIngredients(changed,'sequential').map(value=>value.delayMs)).toEqual([0,1200]);
});

it('序列池组合可保存、重新读取及编辑，不强制添加执行器', () => {
  const pool = ingredients.map(entry => ({ ...entry, executor: '' }));
  const first = saveCueIngredients(createLightingDocument(), pool, '序列池组合', 1000, 10000, 'pool-cue');
  const reopened = lightingDocumentSchema.parse(JSON.parse(JSON.stringify(first)));
  expect(cueIngredients(reopened, 'pool-cue').map(entry => entry.executor)).toEqual(['', '']);
  const edited = saveCueIngredients(reopened, [{ ...pool[0]!, cue: '8.25' }], '改过的 Cue', 5000, 10000, 'pool-cue');
  expect(cueIngredients(edited, 'pool-cue')).toEqual([expect.objectContaining({ sequence: 1, cue: '8.25', executor: '' })]);
  expect(() => saveCueIngredients(reopened, [pool[0]!, { ...pool[0]!, cue: '9' }], '冲突', 0, 10000)).toThrow('同一序列池');
});

it('素材库为空时，已有 Cue 仍能读取、编辑，组合保持一个点位且不重复添加', () => {
  const source = saveCueIngredients(createLightingDocument(), ingredients, '副歌', 2000, 10000, 'cue');
  expect(source.templates).toEqual([]);
  expect(cueIngredients(source, 'cue')).toHaveLength(2);
  const edited = saveCueIngredients(source, ingredients.slice(0, 1), '副歌修改', 7000, 10000, 'cue');
  const events = edited.tracks.flatMap(track => track.clips.flatMap(clip => clip.events));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ id: 'cue', at: 2000, label: '副歌修改' });
  expect(() => lightingDocumentSchema.parse(edited)).not.toThrow();
});

it('组合在同一时刻生成同组事件，拒绝冲突执行器和音频范围外的新 Cue', () => {
  const document = createLightingDocument();
  const result = saveCueIngredients(document, ingredients, '开场组合', 1000, 10000, 'group');
  expect(result.tracks.flatMap(track => track.clips.flatMap(clip => clip.events))).toEqual([
    expect.objectContaining({ id: 'group', effectGroupId: 'group', at: 1000 }),
    expect.objectContaining({ effectGroupId: 'group', at: 1000 })
  ]);
  expect(() => saveCueIngredients(document, [ingredients[0]!, ingredients[0]!], '冲突', 0, 10000)).toThrow('同一执行器');
  expect(() => saveCueIngredients(document, ingredients, '结尾', 10000, 10000)).toThrow('音频范围');
});

it('编辑原有 Cue 和扩展组合保留轨道输出、静音、片段及原事件编号', () => {
  const source = saveCueIngredients(createLightingDocument(), ingredients.slice(0, 1), '已有', 2000, 10000, 'original');
  const originalTrack = source.tracks[0]!;
  originalTrack.group = ''; originalTrack.muted = true; originalTrack.portProfileId = 'original-output'; originalTrack.channel = 5;
  const originalClip = originalTrack.clips[0]!; originalClip.start = 1000; originalClip.events[0]!.at = 1000;
  const edited = saveCueIngredients(source, ingredients, '加入染色', 0, 10000, 'original');
  const retained = edited.tracks.find(track => track.id === originalTrack.id)!;
  expect(retained).toMatchObject({ group: '', muted: true, channel: 5, portProfileId: 'original-output' });
  expect(retained.clips.find(clip => clip.id === originalClip.id)?.events).toEqual([expect.objectContaining({ id: 'original', at: 1000, label: '加入染色' })]);
  expect(edited.tracks.flatMap(track => track.clips.flatMap(clip => clip.events))).toHaveLength(2);
  const again = saveCueIngredients(edited, [{ ...ingredients[0]!, cue: '7' }, ingredients[1]!], '修改编号', 0, 10000, 'original');
  expect(again.tracks.map(track => track.id)).toEqual(edited.tracks.map(track => track.id));
});

it('时间线编号独立于素材编号和名称，换成控台 Cue 26 后仍显示第 1 点', () => {
  const blank = saveCueIngredients({ ...createLightingDocument(), outputMode: 'network' }, [], '', 0, 10000, 'point');
  const filled = saveCueIngredients(blank, [{ name: '001 暖场', sequence: 9001, cue: '26.000', executor: '', delayMs: 0 }], '', 0, 10000, 'point');
  expect(cueEventEntries(filled).map(entry => entry.cue)).toEqual(['1']);
  expect(filled.tracks.flatMap(track => track.clips.flatMap(clip => clip.events))).toEqual([expect.objectContaining({ id: 'point', label: '', cue: '26.000' })]);
  const moved = moveLightingEffect(filled, 'point', 2000, 10000);
  expect(cueEventEntries(moved).map(entry => entry.cue)).toEqual(['1']);
  expect(compileLightingNetworkActions(moved)).toEqual([{ atMs: 2000, action: { target: 'sequence', action: 'goto', sequence: 9001, cue: '26.000' } }]);
});
