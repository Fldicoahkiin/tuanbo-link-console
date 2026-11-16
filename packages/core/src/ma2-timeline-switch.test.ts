import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type LinkProject, type Ma2Catalog, type Ma2TimecodePreview } from '@tb/schema';
import { editMa2TimelinePropertiesCommand } from './ma2-timeline-properties';
import type { LinkCommand } from './link-command';
import { importMa2TimecodeCommand } from './ma2-import';
import { appendMa2TimelineCuesCommand, detachMa2BindingCommand, ma2SongPairs, pairSongWithMa2ShowCommand, reconcileMa2ReadState, refreshMa2BindingCommand, withMa2Pairings } from './ma2-pairing-state';
import { saveMa2ReadStateCommand } from './ma2-program-import';
import { matchMa2Programs } from './ma2-program-matching';

/** A console show starting at `startMs` with one Goto `atMs` after its start. */
function preview(target: number, startMs: number, atMs: number): Ma2TimecodePreview {
  const document = createLightingDocument();
  document.tracks.push({ id: `track-${target}`, kind: 'ma2', name: `序列 ${target}`, color: '#ba8fff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {},
    clips: [{ id: `clip-${target}`, name: 'MA2', start: 0, duration: atMs + 1, timeLock: 'time', muted: false, events: [{ id: `event-${target}`, kind: 'ma2', at: atMs, sequence: 600 + target, cue: '1', executor: '1.101', label: `Cue ${target}`, action: 'goto' }] }] });
  return { target, name: `灯光 ${target}`, readAt: '2026-11-04T00:00:00.000Z', document, sourceXml: `<MA><Timecode index="${target}"/></MA>`, timeOriginMs: startMs,
    mappings: [{ eventId: `event-${target}`, trackId: `track-${target}`, clipId: `clip-${target}`, path: `Timecode:${target}/Track:0/SubTrack:0/Event:0`, sequence: 600 + target, cueIndex: 1, executor: '1.101' }], warnings: [], unconverted: [] };
}

function entry(target: number, startMs: number, withPreview = true): Ma2Catalog['entries'][number] {
  return { target, name: `灯光 ${target}`, eventCount: 1, frameFormat: '30 FPS', offset: String(startMs * 30 / 1000), slot: 'TC Slot 2',
    events: [{ path: '0', time: '30', action: 'Goto', executor: '1.101', cue: '1', name: null }], error: null, warnings: [], ...withPreview ? { preview: preview(target, startMs, 1000) } : {} };
}

/** Song A holds the Cues of Timecode 112 (from 60 s); Timecode 121 starts at 70 s. */
function fixture(entries = [entry(112, 60_000), entry(121, 70_000)]): LinkProject {
  const project = createEmptyLinkProject('换时间线'); project.schemaVersion = 2;
  project.rundown = ['A', 'B'].map((id, index) => ({ id, title: `歌曲${id}`, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: id, relativePath: `${id}.wav`, sha256: 'a'.repeat(64), durationMs: 5_000 },
    playback: { volume: 100, endAction: 'stop' as const, startMs: 0, endMs: 0, mtcOffsetMs: 60_000 + index * 100_000, shortcut: '' } }));
  const catalog: Ma2Catalog = { directory: { show: 'show', generation: '1', version: '3.3.4', entries: entries.map(value => ({ target: value.target, name: value.name })) }, readAt: '2026-11-04T00:00:00.000Z', entries };
  const imported = importMa2TimecodeCommand('A', preview(112, 60_000, 1000)).execute(project);
  return { ...imported, ma2ReadState: reconcileMa2ReadState(imported, 'console', catalog) };
}

const edit = (change: (project: LinkProject) => void): LinkCommand => withMa2Pairings({ id: 'edit', label: '改动', execute: value => { const next = structuredClone(value); change(next); return next; }, undo: before => before });
const startA = (ms: number) => edit(next => { next.rundown[0]!.playback!.mtcOffsetMs = ms; });
const song = (project: LinkProject) => project.rundown[0]!.lighting!;

it('来源未确认时替换和追加都保留原编排', () => {
  const before = fixture(); before.ma2ReadState!.catalog.sourceUnverified = true;
  const original = structuredClone(before);
  expect(() => pairSongWithMa2ShowCommand('A', 121).execute(before)).toThrow('来源尚未确认');
  expect(() => appendMa2TimelineCuesCommand('A', 121).execute(before)).toThrow('来源尚未确认');
  expect(before).toEqual(original);
});

describe('首次按起始码配对就放进控台 Cue', () => {
  it('先读控台后改歌曲起始码：首次匹配也导入 Cue，同一步撤销，后续编辑不重复导入', () => {
    const before = fixture();
    const command = edit(next => { next.rundown[1]!.playback!.mtcOffsetMs = 70_000; });
    const paired = command.execute(before);
    expect(ma2SongPairs(paired).pairs[121]).toBe('B');
    expect(paired.rundown[1]!.lighting?.ma2Bindings?.map(binding => binding.timecode)).toEqual([121]);
    expect(paired.rundown[1]!.lighting?.tracks.flatMap(track => track.clips.flatMap(clip => clip.events))).toMatchObject([{ label: 'Cue 121', at: 1000 }]);
    expect(command.undo(before)).toEqual(before);
    const renamed = edit(next => { next.rundown[1]!.title = '改名'; }).execute(paired);
    expect(renamed.rundown[1]!.lighting).toEqual(paired.rundown[1]!.lighting);
  });

  it('歌曲先有起始码：完整读取结果进工程时放入 Cue，不需要再连接或点一次导入', () => {
    const before = fixture(); before.rundown[1]!.playback!.mtcOffsetMs = 70_000;
    const read = before.ma2ReadState!; delete before.ma2ReadState;
    const paired = withMa2Pairings(saveMa2ReadStateCommand(read)).execute(before);
    expect(paired.rundown[1]!.lighting?.ma2Bindings?.map(binding => binding.timecode)).toEqual([121]);
  });

  it('目录未读完整、时间线未转换成功、起点重复或用户已解除关联时不自动导入', () => {
    const incomplete = fixture(); incomplete.ma2ReadState!.catalog.incomplete = '读取中';
    const unverified = fixture(); unverified.ma2ReadState!.catalog.sourceUnverified = true;
    const unread = fixture([entry(112, 60_000), entry(121, 70_000, false)]);
    const broken = fixture(); broken.ma2ReadState!.catalog.entries[1]!.conversionError = '转换未完成';
    const duplicate = fixture([entry(112, 60_000), entry(121, 70_000), entry(130, 70_000)]);
    for (const before of [incomplete, unverified, unread, broken, duplicate]) {
      const after = edit(next => { next.rundown[1]!.playback!.mtcOffsetMs = 70_000; }).execute(before);
      expect(after.rundown[1]!.lighting).toBeUndefined();
    }
    const detached = withMa2Pairings(detachMa2BindingCommand('A', 112)).execute(fixture());
    expect(song(detached).ma2Bindings).toEqual([]);
    expect(song(edit(next => { next.rundown[0]!.title = '改名'; }).execute(detached)).ma2Bindings).toEqual([]);
  });

  it('首次导入失败保留原有编排和起始码，记下原因，不因其他编辑重试', () => {
    const before = fixture();
    const remote = before.ma2ReadState!.catalog.entries[1]!.preview!;
    remote.timeOriginMs = 69_000; remote.document.tracks[0]!.clips[0]!.timeLock = 'beat';
    const after = edit(next => { next.rundown[1]!.playback!.mtcOffsetMs = 70_000; }).execute(before);
    expect(after.rundown[1]!.playback!.mtcOffsetMs).toBe(70_000);
    expect(after.rundown[1]!.lighting).toBeUndefined();
    expect(song(after)).toEqual(song(before));
    expect(after.ma2ReadState!.failures).toEqual([{ target: 121, message: 'MA2 导入必须使用绝对时间片段' }]);
    // Even after its cached data is repaired, an unrelated edit does not retry the failed import.
    const later = edit(next => {
      next.rundown[1]!.title = '改名';
      next.ma2ReadState!.catalog.entries[1]!.preview!.document.tracks[0]!.clips[0]!.timeLock = 'time';
    }).execute(after);
    expect(later.rundown[1]!.lighting).toBeUndefined();
    expect(later.ma2ReadState!.failures).toEqual(after.ma2ReadState!.failures);
  });
});

describe('换了 MTC 起始码，灯光时间线跟着换（2026-11-04）', () => {
  it('起始码改成另一条控台时间线的起点：自动换用它，原来的 Cue 归档；改回来时恢复原来的和本地改动', () => {
    const project = fixture();
    expect(project.ma2ReadState?.pairs).toEqual({ 112: 'A' });
    // A local edit on Timecode 112 that was never written to the console.
    const edited = edit(next => { song(next).tracks[0]!.clips[0]!.events[0]!.at = 800; }).execute(project);
    const moved = startA(70_000).execute(edited);
    expect(song(moved).ma2Bindings?.map(binding => binding.timecode)).toEqual([121]);
    expect(song(moved).tracks.map(track => track.id)).toEqual(['track-121']);
    expect(moved.ma2ReadState?.detachedBindings?.map(value => [value.itemId, value.binding.timecode])).toEqual([['A', 112]]);
    expect(moved.ma2ReadState?.pairs).toEqual({ 121: 'A' });
    expect(ma2SongPairs(moved).unresolved).toEqual([]);
    const back = startA(60_000).execute(moved);
    expect(song(back).ma2Bindings?.map(binding => binding.timecode)).toEqual([112]);
    expect(song(back).tracks).toEqual(song(edited).tracks);
    expect(back.ma2ReadState?.detachedBindings?.map(value => value.binding.timecode)).toEqual([121]);
    expect(back.ma2ReadState?.pairs).toEqual({ 112: 'A' });
  });

  it('原来那条在控台上已经删了，新的从歌曲起点开始：也换过去', () => {
    const moved = startA(70_000).execute({ ...fixture(), ma2ReadState: reconcileMa2ReadState(fixture(), 'console', { ...fixture().ma2ReadState!.catalog, entries: [entry(121, 70_000)] }) });
    expect(song(moved).ma2Bindings?.map(binding => binding.timecode)).toEqual([121]);
  });

  it('不猜：新的那条没读完整、原来那条还在这个起点、或新起点有两条时间线，都不换，Cue 保留并说明', () => {
    const unread = startA(70_000).execute(fixture([entry(112, 60_000), entry(121, 70_000, false)]));
    expect(song(unread).ma2Bindings?.map(binding => binding.timecode)).toEqual([112]);
    expect(ma2SongPairs(unread).unresolved.find(value => value.target === 121)?.reason).toContain('读完后自动换过去');
    const twice = startA(70_000).execute(fixture([entry(112, 60_000), entry(121, 70_000), entry(130, 70_000)]));
    expect(song(twice).ma2Bindings?.map(binding => binding.timecode)).toEqual([112]);
    expect(ma2SongPairs(twice).switches).toEqual([]);
    const reading = fixture();
    const incomplete = { ...reading, ma2ReadState: { ...reading.ma2ReadState!, catalog: { ...reading.ma2ReadState!.catalog, incomplete: '读取中' } } };
    expect(song(startA(70_000).execute(incomplete)).ma2Bindings?.map(binding => binding.timecode)).toEqual([112]);
  });

  it('换不过去时起始码照改，原因记在那条时间线上，不挡别的编辑', () => {
    const broken = fixture();
    const target = broken.ma2ReadState!.catalog.entries[1]!;
    target.preview = { ...target.preview!, timeOriginMs: 69_000, document: { ...target.preview!.document, tracks: [{ ...target.preview!.document.tracks[0]!, clips: [{ ...target.preview!.document.tracks[0]!.clips[0]!, timeLock: 'beat' }] }] } };
    const moved = startA(70_000).execute(broken);
    expect(moved.rundown[0]!.playback!.mtcOffsetMs).toBe(70_000);
    expect(song(moved).ma2Bindings?.map(binding => binding.timecode)).toEqual([112]);
    expect(moved.ma2ReadState?.failures).toEqual([{ target: 121, message: 'MA2 导入必须使用绝对时间片段' }]);
    expect(ma2SongPairs(moved).unresolved.find(value => value.target === 121)?.reason).toContain('没能换过去');
    const later = edit(next => { next.rundown[1]!.title = '改名'; }).execute(moved);
    expect(later.rundown[1]!.title).toBe('改名');
  });

  it('只看起始码：没换的歌、其他歌都不受影响', () => {
    const project = fixture();
    const match = matchMa2Programs(startA(60_000).execute(project), project.ma2ReadState!.catalog);
    expect(match.switches).toEqual([]);
    expect(match.pairs).toEqual({ 112: 'A' });
  });
});

describe('控台时间线页面里选「给哪首歌用」', () => {
  it('替换移走原来的未绑定点和自建序列，保留音乐、画面和节拍；整步可以撤销', () => {
    const before = fixture();
    const lighting = song(before);
    lighting.consoleSong = { endpoint: 'console', show: 'show', name: '自建', sequence: 9000, layout: null, executor: '1000.101', baselineXml: '<MA/>', points: [] };
    const loose = structuredClone(lighting.tracks[0]!); loose.id = 'loose'; loose.clips[0]!.id = 'loose-clip'; loose.clips[0]!.events[0]!.id = 'loose-event';
    lighting.tracks.push(loose);
    const command = withMa2Pairings(pairSongWithMa2ShowCommand('A', 121));
    const after = command.execute(before);
    expect(song(after).tracks).toHaveLength(1);
    expect(song(after).ma2Bindings?.map(binding => binding.timecode)).toEqual([121]);
    expect(song(after).consoleSong).toBeUndefined();
    expect(song(after).tempos).toEqual(lighting.tempos);
    expect(after.rundown[0]!.referenceAudio).toEqual(before.rundown[0]!.referenceAudio);
    expect(after.rundown[0]!.visualLayers).toEqual(before.rundown[0]!.visualLayers);
    expect(command.undo(before)).toEqual(before);
  });

  it('同起点多条时间线时，明确选择只使用选中的编号，不自动叠加其他时间线', () => {
    const before = fixture([entry(112, 60_000), entry(121, 60_000)]);
    const after = withMa2Pairings(pairSongWithMa2ShowCommand('A', 121)).execute(before);
    expect(ma2SongPairs(after).pairs).toEqual({ 121: 'A' });
    expect(song(after).ma2Bindings?.map(binding => binding.timecode)).toEqual([121]);
    expect(song(after).tracks).toHaveLength(1);
  });

  it('追加保留当前目标和起始码，复制为新轨道并登记到当前时间线；原时间线不被接管', () => {
    const before = fixture();
    const after = withMa2Pairings(appendMa2TimelineCuesCommand('A', 121)).execute(before);
    expect(after.rundown[0]!.playback!.mtcOffsetMs).toBe(60_000);
    expect(song(after).ma2Bindings?.map(binding => binding.timecode)).toEqual([112]);
    expect(song(after).tracks).toHaveLength(2);
    const added = song(after).tracks[1]!;
    expect(added.id).not.toBe('track-121');
    expect(added.clips[0]!.events[0]!.at).toBe(1000);
    expect(song(after).ma2Bindings![0]!.pendingTracks).toEqual([{ trackId: added.id, executor: '1.101', executorName: added.name }]);
    expect(song(before).tracks).toHaveLength(1);
  });

  it('新歌追加 Cue 不关联素材的时间线，交给歌曲同步创建自己的时间线', () => {
    const before = fixture(); delete before.rundown[1]!.playback;
    const after = withMa2Pairings(appendMa2TimelineCuesCommand('B', 121)).execute(before);
    expect(after.rundown[1]!.playback).toBeUndefined();
    expect(after.rundown[1]!.lighting?.ma2Bindings).toBeUndefined();
    expect(after.rundown[1]!.lighting?.tracks[0]!.clips[0]!.events[0]).toMatchObject({ kind: 'ma2', at: 1000, sequence: 721 });
  });

  it('选了就把歌曲起始码改成这条时间线的起点；放过别的时间线 Cue 的歌换过去，没放过的直接放进这条的 Cue', () => {
    const project = fixture();
    const switched = withMa2Pairings(pairSongWithMa2ShowCommand('A', 121)).execute(project);
    expect(switched.rundown[0]!.playback!.mtcOffsetMs).toBe(70_000);
    expect(song(switched).ma2Bindings?.map(binding => binding.timecode)).toEqual([121]);
    const fresh = withMa2Pairings(pairSongWithMa2ShowCommand('B', 121)).execute(withMa2Pairings(pairSongWithMa2ShowCommand('A', 112)).execute(project));
    expect(fresh.rundown[1]!.playback!.mtcOffsetMs).toBe(70_000);
    expect(fresh.rundown[1]!.lighting?.ma2Bindings?.map(binding => binding.timecode)).toEqual([121]);
    expect(fresh.ma2ReadState?.pairs).toEqual({ 112: 'A', 121: 'B' });
  });

  it('另一首歌已经从这个起点开始，或这条的 Cue 已经在别的歌里：不改，说明原因', () => {
    const project = fixture();
    const shared = withMa2Pairings(pairSongWithMa2ShowCommand('B', 121)).execute(project);
    expect(() => pairSongWithMa2ShowCommand('A', 121).execute(shared)).toThrow('请先在那首歌上解除关联');
    // A file whose starts already match, before its Cues have been imported.
    const sameStart = structuredClone(project); sameStart.rundown[1]!.playback!.mtcOffsetMs = 70_000;
    expect(() => pairSongWithMa2ShowCommand('A', 121).execute(sameStart)).toThrow('两首歌同一个起点分不清');
  });
});

// 2026-11-11 现场：控台上改了 Cue，联动台对不上又读不到最新的；“用已读取的内容刷新”只拿上次读的（那次读出错了）。
// 用控台上的：刚从控台读到的这条时间线进歌曲，本地没写到控台的改动先归档。
describe('用控台上的灯光（2026-11-11）', () => {
  const at = (project: LinkProject) => song(project).tracks.flatMap(track => track.clips.flatMap(clip => clip.events.map(event => clip.start + event.at)));
  it('刚读到的内容进歌曲，没写到控台的本地改动归档；上次读取出错也不挡', () => {
    const failed = fixture([{ ...entry(112, 60_000, false), error: '扫描期间时间线发生变化，请重新扫描' }, entry(121, 70_000)]);
    const edited = edit(next => { song(next).tracks[0]!.clips[0]!.events[0]!.at = 800; }).execute(failed);
    expect(() => refreshMa2BindingCommand('A', 112, true).execute(edited)).toThrow('此时间线没有完整的已读内容');
    expect(() => refreshMa2BindingCommand('A', 112, false, preview(112, 60_000, 1500)).execute(edited)).toThrow('本地编排已有修改');
    const taken = refreshMa2BindingCommand('A', 112, true, preview(112, 60_000, 1500)).execute(edited);
    expect(song(taken).ma2Bindings?.map(binding => binding.timecode)).toEqual([112]);
    expect(at(taken)).toEqual([1500]);
    expect(taken.ma2ReadState?.detachedBindings?.map(value => [value.itemId, value.binding.timecode, value.tracks[0]!.clips[0]!.events[0]!.at])).toEqual([['A', 112, 800]]);
  });
  it('手动关联、工程里没有控台读取结果的歌：也能换成控台上的', () => {
    const bare = fixture(); delete bare.ma2ReadState;
    const taken = refreshMa2BindingCommand('A', 112, true, preview(112, 60_000, 2000)).execute(bare);
    expect(song(taken).ma2Bindings?.map(binding => binding.timecode)).toEqual([112]);
    expect(at(taken)).toEqual([2000]);
  });
  it('读到的不是这条时间线：不换', () => {
    expect(() => refreshMa2BindingCommand('A', 112, true, preview(121, 70_000, 1000))).toThrow('不是 Timecode 112');
  });
});


it('手动同步控台时间线后清除新建目标，后续修改仍匹配所选编号且可撤销', () => {
  const before = fixture();
  song(before).timelineDestination = { name: '新建计划', timecode: 9000, sequence: 9000, executor: '1000.101' };
  const command = withMa2Pairings(pairSongWithMa2ShowCommand('A', 121));
  const after = command.execute(before);
  expect(song(after).timelineDestination).toBeUndefined();
  expect(song(after).ma2Bindings?.map(binding => binding.timecode)).toEqual([121]);
  expect(ma2SongPairs(after).pairs[121]).toBe('A');
  expect(after.rundown[0]!.playback!.mtcOffsetMs).toBe(70_000);
  const edited = edit(next => { song(next).tracks[0]!.clips[0]!.events[0]!.at = 2000; }).execute(after);
  expect(ma2SongPairs(edited).pairs[121]).toBe('A');
  expect(song(edited).tracks[0]!.clips[0]!.events[0]!.at).toBe(2000);
  expect(command.undo(before)).toEqual(before);
});

it('手动同步不能接管其他歌曲已创建或已预留的时间线', () => {
  for (const created of [false, true]) {
    const before = fixture();
    const lighting = createLightingDocument();
    if (created) lighting.consoleSong = { endpoint: 'console', show: 'show', name: '歌曲B', sequence: 9000, layout: null, executor: '1000.101', baselineXml: '<MA/>', points: [], timecode: { number: 121, offset: 2100, slot: 'TC Slot 2', revision: 'b'.repeat(64) } };
    else lighting.timelineDestination = { name: '歌曲B', timecode: 121, sequence: 9000, executor: '1000.101' };
    before.rundown[1]!.lighting = lighting;
    const original = structuredClone(before);
    expect(() => pairSongWithMa2ShowCommand('A', 121).execute(before)).toThrow('歌曲B');
    expect(before).toEqual(original);
  }
});


it('手动重新读取采用新鲜 Cue 和 MTC，不恢复旧的空编排', () => {
  const before = fixture();
  const read = preview(112, 80_000, 2500);
  read.timing = { frameFormat: '30 FPS', unit: 'frames-30', offsetNative: '2400', absoluteEventTimesMs: [82500] };
  const command = withMa2Pairings(pairSongWithMa2ShowCommand('A', 112, read));
  const after = command.execute(before);
  expect(after.rundown[0]!.playback!.mtcOffsetMs).toBe(80_000);
  expect(song(after).tracks[0]!.clips[0]!.events[0]!.at).toBe(2500);
  expect(after.ma2ReadState!.catalog.entries.find(entry => entry.target === 112)?.offset).toBe('2400');
  expect(ma2SongPairs(after).pairs[112]).toBe('A');
  expect(command.undo(before)).toEqual(before);
});

it('修改导入时间线名称和 MTC 后保留相对 Cue 位置，并仍关联同一编号', () => {
  const before = fixture(); const fresh = preview(112, 90000, 1000); fresh.name = 'Updated';
  const command = editMa2TimelinePropertiesCommand(112, 'Updated', 90000, fresh);
  const after = withMa2Pairings(command).execute(before);
  expect(after.rundown[0]!.playback!.mtcOffsetMs).toBe(90000);
  expect(song(after).ma2Bindings?.[0]).toMatchObject({ timecode: 112, name: 'Updated', timeOriginMs: 90000 });
  expect(song(after).tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).map(event => event.at)).toEqual([1000]);
  expect(ma2SongPairs(after).pairs[112]).toBe('A');
  expect(command.undo(before)).toEqual(before);
});
it('属性编辑预检拒绝与其他节目相同的起始码，原 Cue 和关联保持', () => {
  const before = fixture();
  expect(() => editMa2TimelinePropertiesCommand(112, 'Updated', 160000, preview(112, 160000, 1000)).execute(before)).toThrow('重复');
  expect(song(before).ma2Bindings?.[0]?.timecode).toBe(112);
});

it('只有控台目录的时间线，手动选择现读后补入完整条目和 Cue', () => {
  const before = fixture();
  before.ma2ReadState!.catalog.entries = before.ma2ReadState!.catalog.entries.filter(entry => entry.target !== 121);
  const fresh = preview(121, 70000, 2500);
  fresh.timing = { frameFormat: '30 FPS', unit: 'frames-30', offsetNative: '2100', absoluteEventTimesMs: [72500] };
  const after = withMa2Pairings(pairSongWithMa2ShowCommand('A', 121, fresh)).execute(before);
  expect(after.ma2ReadState!.catalog.entries.find(entry => entry.target === 121)).toMatchObject({ offset: '2100', eventCount: 1, preview: fresh });
  expect(song(after).ma2Bindings?.[0]).toMatchObject({ timecode: 121, timeOriginMs: 70000 });
  expect(song(after).tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).map(event => event.at)).toEqual([2500]);
  expect(ma2SongPairs(after).pairs[121]).toBe('A');
});
