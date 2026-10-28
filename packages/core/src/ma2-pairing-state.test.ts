import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type LinkProject, type Ma2Catalog } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { detachMa2BindingCommand, ma2SongPairs, reconcileMa2ReadState, restoreMa2BindingCommand, withMa2Pairings } from './ma2-pairing-state';

function fixture() {
  const project = createEmptyLinkProject('配对生命周期'); project.schemaVersion = 2;
  project.rundown = ['歌曲甲', '歌曲乙'].map((title, index) => ({ id: title, title, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: title, relativePath: `${index}.wav`, sha256: 'a'.repeat(64), durationMs: 40000 }, playback: { volume: 100, endAction: 'stop' as const, startMs: 5000, endMs: 0, mtcOffsetMs: 480000 + index * 100000, shortcut: '' } }));
  const catalog: Ma2Catalog = { directory: { show: '测试 Show', generation: 'session', version: '3.7.0.5', entries: [{ target: 2, name: 'mei-nan' }] }, readAt: '2026-10-05T00:00:00.000Z', entries: [{ target: 2, name: 'mei-nan', eventCount: 2, frameFormat: '30 FPS', offset: '14400', slot: 'TC Slot 2', events: [0, 955].map(time => ({ path: String(time), time: String(time), action: time ? 'Goto' : 'Master', executor: '51.101', cue: null, name: null })), error: null, warnings: [] }] };
  return { project, catalog };
}
const edit = (change: (project: LinkProject) => void): LinkCommand => withMa2Pairings({ id: 'edit', label: '改动', execute: value => { const next = structuredClone(value); change(next); return next; }, undo: before => before });

it('读取控台后按 MTC 起始码对上，直接算已确认；旧文件里的建议不参与，名字和播放裁剪不影响起点（2026-10-26）', () => {
  const { project, catalog } = fixture();
  project.ma2ReadState = { source: 'console', catalog, pairs: { 2: '歌曲乙' }, pairings: { 2: { itemId: '歌曲乙', status: 'stale', evidence: '{}' } }, failures: [], selectedTarget: 2, query: '', filter: 'all', message: '' };
  expect(ma2SongPairs(project).pairs).toEqual({ 2: '歌曲甲' });
  const state = reconcileMa2ReadState(project, 'console', catalog);
  expect(state.pairs).toEqual({ 2: '歌曲甲' });
  expect(state.pairings?.[2]).toMatchObject({ itemId: '歌曲甲', status: 'confirmed' });
  expect(state.message).toBe('1 条已读取 · 1 条按起始码对上歌曲');
});

it('改歌曲起点时配对跟着变，撤销后回来；改名、换 Show 名、换控台会话都不影响', () => {
  const { project, catalog } = fixture();
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
  const moved = edit(next => { next.rundown[0]!.playback!.mtcOffsetMs += 1000; }).execute(project);
  expect(moved.ma2ReadState?.pairs).toEqual({});
  expect(ma2SongPairs(moved).pairs).toEqual({});
  const back = edit(next => { next.rundown[1]!.playback!.mtcOffsetMs = 480000; }).execute(moved);
  expect(back.ma2ReadState?.pairs).toEqual({ 2: '歌曲乙' });
  expect(ma2SongPairs(project).pairs).toEqual({ 2: '歌曲甲' });
  const renamed = edit(next => { next.rundown[0]!.title = '歌曲甲（新）'; }).execute(project);
  expect(renamed.ma2ReadState?.pairings).toEqual(project.ma2ReadState.pairings);
  const reread = structuredClone(catalog); reread.directory.show = '另一个 Show 名'; reread.directory.generation = 'another-session'; reread.directory.version = '3.7.0.6';
  expect(reconcileMa2ReadState(project, 'other-console', reread).pairs).toEqual({ 2: '歌曲甲' });
});

it('控台或软件挪了 Cue 时间也仍然对上；只有控台节目起点变了才对不上', () => {
  const { project, catalog } = fixture();
  const moved = structuredClone(catalog); moved.entries[0]!.events[1]!.time = '1200';
  moved.entries[0]!.events.push({ path: '2', time: '9000', action: 'Goto', executor: '51.101', cue: null, name: null });
  expect(reconcileMa2ReadState(project, 'console', moved).pairs).toEqual({ 2: '歌曲甲' });
  const restarted = structuredClone(moved); restarted.entries[0]!.offset = '14430';
  expect(reconcileMa2ReadState(project, 'console', restarted).pairs).toEqual({});
});

it('同一 Show 同一会话保留读取异常；换 Show 不继承另一份读取异常', () => {
  const { project, catalog } = fixture();
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
  project.ma2ReadState.failures = [{ target: 2, message: '旧 Show 异常' }];
  expect(reconcileMa2ReadState(project, 'console', catalog).failures).toEqual([{ target: 2, message: '旧 Show 异常' }]);
  const changed = structuredClone(catalog); changed.directory.show = '其他 Show';
  expect(reconcileMa2ReadState(project, 'console', changed).failures).toEqual([]);
});

it('切换灯光输出模式不改变配对', () => {
  const { project, catalog } = fixture();
  project.rundown[0]!.lighting = createLightingDocument();
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
  let current = project;
  for (const mode of ['network', 'timecode', 'direct', 'timecode'] as const) {
    current = edit(next => { next.rundown[0]!.lighting!.outputMode = mode; }).execute(current);
    expect(current.ma2ReadState?.pairings).toEqual(project.ma2ReadState.pairings);
  }
});

it('解除与恢复完整保留未知原生数据，起点没变就一直对上', () => {
  const { project, catalog } = fixture();
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
  project.rundown[0]!.lighting = { ...createLightingDocument(), ma2Bindings: [{ id: 'binding', name: 'mei-nan', timecode: 2, readAt: catalog.readAt, sourceXml: '<MA><unknown value="preserve"/></MA>', baselineTracks: [], mappings: [], nativeEvents: [{ path: 'unknown', reason: '未知参数' }], playback: 'native-timecode', timeOriginMs: 480000 }] };
  const detached = detachMa2BindingCommand('歌曲甲', 2).execute(project);
  expect(detached.rundown[0]?.lighting?.ma2Bindings).toEqual([]);
  expect(detached.ma2ReadState?.detachedBindings?.[0]?.binding.sourceXml).toContain('unknown');
  expect(detached.ma2ReadState?.pairs).toEqual({ 2: '歌曲甲' });
  const restored = restoreMa2BindingCommand('歌曲甲', 2).execute(detached);
  expect(restored.rundown[0]?.lighting).toEqual(project.rundown[0]?.lighting);
  expect(restored.ma2ReadState?.pairings?.[2]).toMatchObject({ itemId: '歌曲甲', status: 'confirmed' });
  const gone = reconcileMa2ReadState(project, 'console', { ...catalog, entries: [], directory: { ...catalog.directory, entries: [] } });
  expect(gone.pairs).toEqual({});
});
