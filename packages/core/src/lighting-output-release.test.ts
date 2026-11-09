import { expect, it, vi } from 'vitest';
import { createLightingDocument, lightingMa2BindingSchema, lightingTrackSchema, type Ma2NetworkStatus, type Ma2PlaybackRequest } from '@tb/schema';
import { LightingOutputRelease, LightingReleaseFailure, lightingReleaseActions } from './lighting-output-release';

const song = { endpoint: 'console', show: '现场', layout: null, executor: '51.101', sequence: 36, name: '歌曲', baselineXml: '<MA/>', points: [] };
/** The rundown song the lighting belongs to, as the player prepares it. */
const opening = { itemId: 'opening', title: '开场' };
function fixture() {
  const document = { ...createLightingDocument(), consoleSong: song };
  document.tracks = [lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '歌曲', start: 0, duration: 180000, timeLock: 'time', muted: false, events: [100, 70000, 160000].map((at, index) => ({ id: `cue-${index}`, at, kind: 'ma2', action: 'goto', sequence: 36, cue: `${index + 1}.100`, executor: '1.105', label: '原灯光' })) }] })];
  const status: Ma2NetworkStatus = { state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false }, passwordSaved: false, version: '3.7.0.5', error: null };
  const api = { getMa2NetworkStatus: vi.fn(() => Promise.resolve(status)), playMa2Cue: vi.fn<(request: Ma2PlaybackRequest) => Promise<void>>(() => Promise.resolve()) };
  return { document, status, api, release: new LightingOutputRelease(api) };
}
it('只关闭本节目去重后的执行器，单独停止不会输出全局 Off 或停用 Timecode', async () => {
  const f = fixture(); await f.release.prepare(f.document, opening);
  expect(f.api.playMa2Cue).not.toHaveBeenCalled();
  await f.release.release(); await f.release.release();
  expect(f.api.playMa2Cue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: { target: 'executor', executor: '51.101', action: 'off' } }));
});
it('断线和目标变化不会把旧歌曲关闭指令发给另一台控台，也不自动重发', async () => {
  const f = fixture(); await f.release.prepare(f.document, opening);
  f.status.settings!.host = '192.0.2.2';
  await expect(f.release.release()).rejects.toThrow('控台连接变了');
  await f.release.release(); expect(f.api.playMa2Cue).not.toHaveBeenCalled();
});
it('准备期间取消，迟到结果不能恢复旧关闭计划', async () => {
  const f = fixture(); const preparing = f.release.prepare(f.document, opening); f.release.cancelPreparation();
  await preparing; await f.release.release(); expect(f.api.playMa2Cue).not.toHaveBeenCalled();
});
it('播放只发时间码：停止只关时间码绑定的执行器和本曲控台序列的执行器，本地时间线上的 Cue 不发 Off', async () => {
  const f = fixture();
  expect(lightingReleaseActions(f.document)).toEqual([{ target: 'executor', executor: '51.101', action: 'off' }]);
  const local = { ...f.document, consoleSong: undefined };
  expect(lightingReleaseActions(local)).toEqual([]);
  await f.release.prepare(local, opening); expect(f.api.getMa2NetworkStatus).not.toHaveBeenCalled();
  await f.release.release(); expect(f.api.playMa2Cue).not.toHaveBeenCalled();
});
// 修复前：失败只带原因，播放器只能拿关闭那一刻正在放的歌来写红字；不带灯光的歌不换掉关灯计划，写出来的就成了别的歌。
it('关灯没发全时，失败说出这份关灯计划是哪首歌的：Off 被拒、控台连接变了、准备时没连上控台', async () => {
  const f = fixture(); await f.release.prepare(f.document, opening);
  f.api.playMa2Cue.mockRejectedValueOnce(new Error('MA2 没有回应'));
  const refused = await f.release.release().catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(LightingReleaseFailure);
  expect(refused).toMatchObject({ song: opening, message: 'MA2 没有回应' });
  await f.release.prepare(f.document, opening); f.status.settings!.host = '192.0.2.2';
  await expect(f.release.release()).rejects.toMatchObject({ song: opening, message: '关灯指令没有发送：控台连接变了' });
  f.status.state = 'disconnected';
  const encore = { itemId: 'encore', title: '返场' };
  await f.release.prepare(f.document, encore);
  const offline = await f.release.release().catch((error: unknown) => error);
  expect(offline).toBeInstanceOf(LightingReleaseFailure);
  expect(offline).toMatchObject({ song: encore, message: '时间码已停止；没有连接 MA2 网络，无法发送这个节目的执行器关闭指令' });
  expect(f.api.playMa2Cue).toHaveBeenCalledOnce();
});
it('编辑器试听不指定歌（use-lighting-preview.ts）：关灯失败照旧只带原因', async () => {
  const f = fixture(); await f.release.prepare(f.document);
  f.api.playMa2Cue.mockRejectedValueOnce(new Error('MA2 没有回应'));
  await expect(f.release.release()).rejects.toMatchObject({ song: null, message: 'MA2 没有回应' });
});
it('几个执行器的关灯指令一起排进去，同一个期限，一个失败也不耽误其他的', async () => {
  const f = fixture();
  const binding = lightingMa2BindingSchema.parse({ id: 'binding', timecode: 1, name: '歌曲', readAt: '2026-11-09T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [], mappings: [],
    trackMappings: ['1.101', '1.102'].map((executor, index) => ({ trackId: `track-${index}`, path: `Track ${index}`, executor, subtracks: [] })) });
  const document = { ...f.document, ma2Bindings: [binding] };
  const started: string[] = []; const deadlines = new Set<number>();
  f.api.playMa2Cue.mockImplementation(request => {
    const executor = request.action.target === 'executor' ? request.action.executor : '';
    started.push(executor); deadlines.add(request.deadlineAt);
    return executor === '1.101' ? Promise.reject(new Error('控台正忙')) : Promise.resolve();
  });
  await f.release.prepare(document, opening);
  const before = Date.now();
  await expect(f.release.release()).rejects.toMatchObject({ song: opening, message: '控台正忙' });
  expect(started).toEqual(['1.101', '1.102', '51.101']);
  expect(deadlines.size).toBe(1); expect([...deadlines][0]).toBeGreaterThanOrEqual(before + 7000);
});
