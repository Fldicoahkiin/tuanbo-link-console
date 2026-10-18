import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument } from '@tb/schema';
import { ma2ConsoleCueName, ma2ConsoleCuePoolName, ma2ConsoleSequenceName, ma2SequenceLibrary, type LibrarySequence } from './ma2-sequence-library';
import { confirmMa2RenameCommand, pendingMa2Renames, renameConsoleCueCommand } from '@tb/core/link';

it('控台池显示原始名称：未命名的单步使用所属序列名称，本地别名不覆盖控台名', () => {
  const sequence: LibrarySequence = { sequence: 170, name: '本地分类名称', originalName: 'xws man 170', complete: true, cues: [] };
  expect(ma2ConsoleSequenceName(sequence)).toBe('xws man 170');
  expect(ma2ConsoleCuePoolName(sequence, { number: '1.000', name: null })).toBe('xws man 170');
  expect(ma2ConsoleCuePoolName(sequence, { number: '1.000', name: '本地改名', originalName: null })).toBe('xws man 170');
  expect(ma2ConsoleCuePoolName(sequence, { number: '2.500', name: '本地改名', originalName: '  控台副歌  ' })).toBe('  控台副歌  ');
  expect(ma2ConsoleCuePoolName({ ...sequence, name: null, originalName: null }, { number: '0.500', name: null })).toBe('Cue 0.5');
});

it('序列内部显示各步的控台 Cue 名称或实际编号，不重复使用序列 346 的名字', () => {
  const cues = [
    { number: '1.000', name: null },
    { number: '2.000', name: '本地别名', originalName: null },
    { number: '2.500', name: '  控台副歌  ' },
    { number: '10.100', name: null }
  ];
  expect(cues.map(ma2ConsoleCueName)).toEqual(['Cue 1', 'Cue 2', '  控台副歌  ', 'Cue 10.1']);
});

it('全控台目录覆盖歌曲旧目录，保留小数编号与原生顺序', () => {
  const project = createEmptyLinkProject('库范围验收');
  const document = createLightingDocument();
  const old = { sequence: 36, name: '旧名', cues: [{ index: 0, number: '1.000', name: '开场' }] };
  document.ma2Library = { show: 'Show', readAt: new Date().toISOString(), sequences: [old] };
  project.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: { directory: { show: 'Show', generation: 'session', version: '3.7.0.5', entries: [] }, readAt: new Date().toISOString(), fixtureDetails: 'unavailable', fixtureUsage: [], errors: [], sequences: [
    { ...old, name: '原名称', cues: [...old.cues, { index: 2, number: '2.000', name: '结束' }, { index: 1, number: '1.100', name: '副歌' }] },
    { sequence: 37, name: '未在此歌曲使用', cues: [{ index: 0, number: '5.200', name: '蓝光' }] }
  ] } };
  const pool = ma2SequenceLibrary(project, document);
  expect(pool.map(value => value.name)).toEqual(['原名称', '未在此歌曲使用']);
  expect(pool[0]?.cues.map(value => value.number)).toEqual(['1.000', '1.100', '2.000']);
  const renamed=renameConsoleCueCommand({sequence:36,cue:'1.100',kind:'single'},'我的副歌',{endpoint:'192.0.2.1:30000',show:'Show'}).execute(project);
  expect(ma2SequenceLibrary(renamed,document)[0]?.cues[1]).toMatchObject({name:'我的副歌',originalName:'副歌',number:'1.100'});
  const renamedPool = ma2SequenceLibrary(renamed, document);
  expect(ma2ConsoleCuePoolName(renamedPool[0]!, renamedPool[0]!.cues[1]!)).toBe('我的副歌');
  expect(ma2ConsoleCueName(renamedPool[0]!.cues[1]!)).toBe('我的副歌');
  const confirmed = confirmMa2RenameCommand(pendingMa2Renames(renamed)[0]!).execute(renamed);
  expect(ma2ConsoleCueName(ma2SequenceLibrary(confirmed, document)[0]!.cues[1]!)).toBe('我的副歌');
  const sequenceRename = renameConsoleCueCommand({ sequence: 36, cue: '1.000', kind: 'sequence' }, '灯光 2026', { endpoint: '192.0.2.1:30000', show: 'Show' });
  expect(ma2ConsoleSequenceName(ma2SequenceLibrary(sequenceRename.execute(confirmed), document)[0]!)).toBe('灯光 2026');
  expect(ma2ConsoleSequenceName(ma2SequenceLibrary(sequenceRename.undo(confirmed), document)[0]!)).toBe('原名称');
  project.ma2ReadState = { source: '192.0.2.2:30000', catalog: { directory: { show: 'Other', generation: 'different', version: '3.7.0.5', entries: [] }, entries: [], readAt: new Date().toISOString() }, pairs: {}, failures: [], message: '', selectedTarget: null, query: '', filter: 'all' };
  expect(ma2SequenceLibrary(project, document)).toEqual([]);
  expect(ma2SequenceLibrary({...renamed,ma2ReadState:project.ma2ReadState},document)).toEqual([]);
});

it('读取过的控台池不混入旧歌曲和模板中的失效对象，空池和部分读取也不回退', () => {
  const project = createEmptyLinkProject('切换 Show');
  const document = createLightingDocument();
  const old = { sequence: 14, name: '旧控台', cues: [{ index: 0, number: '3.000', name: '旧 Cue' }] };
  document.ma2Library = { show: 'Old', readAt: new Date().toISOString(), sequences: [old] };
  document.templates.push({ id: 'old', name: '旧灯光', sourceShow: 'Old', track: {
    id: 'track', name: '旧灯光', kind: 'ma2', color: '#abcdef', group: '', muted: false,
    solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [],
    cueStamp: { mode: 'fixed', sequence: 15, cue: '9.000', executor: '' }
  } });
  const original = structuredClone(document);
  project.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: {
    directory: { show: 'Current', generation: 'session', version: '3.7.0.5', entries: [] },
    readAt: new Date().toISOString(), fixtureUsage: [], errors: [],
    sequences: [{ sequence: 9907, name: '当前测试', cues: [{ index: 0, number: '1.000', name: '暖场' }] }]
  } };
  expect(ma2SequenceLibrary(project, document).map(value => value.sequence)).toEqual([9907]);
  const current = project.ma2MaterialLibrary.library;
  if (!current) throw new Error('测试素材库缺失');
  current.incomplete = '读取尚未完成';
  expect(ma2SequenceLibrary(project, document).map(value => value.sequence)).toEqual([9907]);
  current.sequences = [];
  expect(ma2SequenceLibrary(project, document)).toEqual([]);
  expect(document).toEqual(original);
});
