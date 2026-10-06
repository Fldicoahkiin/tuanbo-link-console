import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type Ma2Catalog } from '@tb/schema';
import { confirmMa2PairingCommand, reconcileMa2ReadState, detachMa2BindingCommand, restoreMa2BindingCommand, withMa2PairingValidation } from './ma2-pairing-state';

function fixture() {
  const project = createEmptyLinkProject('配对生命周期');
  project.rundown = ['歌曲甲', '歌曲乙'].map((title, index) => ({ id: title, title, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: title, relativePath: `${index}.wav`, sha256: 'a'.repeat(64), durationMs: 40000 }, playback: { volume: 100, endAction: 'stop' as const, startMs: 5000, endMs: 0, mtcOffsetMs: 480000 + index * 100000, shortcut: '' } }));
  const catalog: Ma2Catalog = { directory: { show: '测试 Show', generation: 'session', version: '3.7.0.5', entries: [{ target: 2, name: 'mei-nan' }] }, readAt: '2026-10-05T00:00:00.000Z', entries: [{ target: 2, name: 'mei-nan', eventCount: 2, frameFormat: '30 FPS', offset: '14400', slot: 'TC Slot 2', events: [0, 955].map(time => ({ path: String(time), time: String(time), action: time ? 'Goto' : 'Master', executor: '51.101', cue: null, name: null })), error: null, warnings: [] }] };
  return { project, catalog };
}

it('旧建议重新匹配，不冒充确认；名称与播放裁剪不改变原始起点', () => {
  const { project, catalog } = fixture();
  project.ma2ReadState = { source: 'console', catalog, pairs: { 2: '歌曲乙' }, failures: [], selectedTarget: 2, query: '', filter: 'all', message: '' };
  const state = reconcileMa2ReadState(project, 'console', catalog);
  expect(state.pairs).toEqual({ 2: '歌曲甲' });
  expect(state.pairings?.[2]?.status).toBe('suggested');
});

it('确认保持；时间依据变化后保留人选但失效，不静默换歌', () => {
  const { project, catalog } = fixture();
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
  const confirmed = confirmMa2PairingCommand(2, '歌曲甲').execute(project);
  expect(reconcileMa2ReadState(confirmed, 'console', catalog).pairings?.[2]?.status).toBe('confirmed');
  confirmed.rundown[0]!.playback!.mtcOffsetMs = 580000;
  const changed = reconcileMa2ReadState(confirmed, 'console', catalog);
  expect(changed.pairs).toEqual({});
  expect(changed.pairings?.[2]).toMatchObject({ itemId: '歌曲甲', status: 'stale' });
  expect(() => confirmMa2PairingCommand(2, '歌曲甲').execute(confirmed)).toThrow('歌曲范围');
});

it('切换控台、同名 Show 新会话也必须重新核对', () => {
  const { project, catalog } = fixture();
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
  const confirmed = confirmMa2PairingCommand(2, '歌曲甲').execute(project);
  expect(reconcileMa2ReadState(confirmed, 'other-console', catalog).pairings?.[2]?.status).toBe('stale');
  catalog.directory.generation = 'another-session';
  expect(reconcileMa2ReadState(confirmed, 'console', catalog).pairings?.[2]?.status).toBe('stale');
});

it('拒绝缺起点、未知帧率和错误歌曲的人工确认', () => {
  const { project, catalog } = fixture();
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
  expect(() => confirmMa2PairingCommand(2, '歌曲乙').execute(project)).toThrow('歌曲范围');
  catalog.entries[0]!.frameFormat = '25 FPS';
  expect(() => confirmMa2PairingCommand(2, '歌曲甲').execute(project)).toThrow('时间格式');
});

it('目录复核失败不能确认；换 Show 不继承另一份读取异常', () => {
  const { project, catalog } = fixture();
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
  project.ma2ReadState.failures = [{ target: 2, message: '旧 Show 异常' }];
  const changed = structuredClone(catalog); changed.directory.show = '其他 Show';
  expect(reconcileMa2ReadState(project, 'console', changed).failures).toEqual([]);
  project.ma2ReadState.catalog.sourceUnverified = true;
  expect(() => confirmMa2PairingCommand(2, '歌曲甲').execute(project)).toThrow('来源尚未核对');
});

it('修改歌曲起点立即使确认失效，撤销同时恢复确认', () => {
  const { project, catalog } = fixture();
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
  const confirmed = confirmMa2PairingCommand(2, '歌曲甲').execute(project);
  const command = withMa2PairingValidation({ id: 'change', label: '改起点', execute: value => { const next = structuredClone(value); next.rundown[0]!.playback!.mtcOffsetMs += 1000; return next; }, undo: before => before });
  expect(command.execute(confirmed).ma2ReadState?.pairings?.[2]?.status).toBe('stale');
  expect(command.undo(confirmed).ma2ReadState?.pairings?.[2]?.status).toBe('confirmed');
});

it('解除与恢复完整保留未知原生数据，不把部分 Cue 变成独立重放', () => {
  const { project, catalog } = fixture();
  project.schemaVersion = 2;
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
  project.rundown[0]!.lighting = { ...createLightingDocument(), ma2Bindings: [{ id: 'binding', name: 'mei-nan', timecode: 2, readAt: catalog.readAt, sourceXml: '<MA><unknown value="preserve"/></MA>', baselineTracks: [], mappings: [], nativeEvents: [{ path: 'unknown', reason: '未知参数' }], playback: 'native-timecode', timeOriginMs: 480000 }] };
  const detached = detachMa2BindingCommand('歌曲甲', 2).execute(project);
  expect(detached.rundown[0]?.lighting?.ma2Bindings).toEqual([]);
  expect(detached.ma2ReadState?.detachedBindings?.[0]?.binding.sourceXml).toContain('unknown');
  const restored = restoreMa2BindingCommand('歌曲甲', 2).execute(detached);
  expect(restored.rundown[0]?.lighting).toEqual(project.rundown[0]?.lighting);
  expect(restored.ma2ReadState?.pairings?.[2]?.status).toBe('stale');
  expect(reconcileMa2ReadState(project, 'console', { ...catalog, entries: [], directory: { ...catalog.directory, entries: [] } }).pairings?.[2]).toMatchObject({ itemId: '歌曲甲', status: 'stale' });
});
