import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type LinkProject, type Ma2Catalog, type Ma2TimecodePreview } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { importMa2TimecodeCommand } from './ma2-import';
import { ma2SongPairs, pairSongWithMa2ShowCommand, reconcileMa2ReadState, refreshMa2BindingCommand, withMa2Pairings } from './ma2-pairing-state';
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
    const sameStart = edit(next => { next.rundown[1]!.playback!.mtcOffsetMs = 70_000; }).execute(project);
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
