import { expect, it, vi } from 'vitest';
import { createLightingDocument, lightingTrackSchema, type Ma2NetworkStatus } from '@tb/schema';
import { LightingOutputRelease, lightingReleaseActions } from './lighting-output-release';

const song = { endpoint: 'console', show: '现场', layout: null, executor: '51.101', sequence: 36, name: '歌曲', baselineXml: '<MA/>', points: [] };
function fixture() {
  const document = { ...createLightingDocument(), consoleSong: song };
  document.tracks = [lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '歌曲', start: 0, duration: 180000, timeLock: 'time', muted: false, events: [100, 70000, 160000].map((at, index) => ({ id: `cue-${index}`, at, kind: 'ma2', action: 'goto', sequence: 36, cue: `${index + 1}.100`, executor: '1.105', label: '原灯光' })) }] })];
  const status: Ma2NetworkStatus = { state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false }, passwordSaved: false, version: '3.7.0.5', error: null };
  const api = { getMa2NetworkStatus: vi.fn(() => Promise.resolve(status)), playMa2Cue: vi.fn(() => Promise.resolve()) };
  return { document, status, api, release: new LightingOutputRelease(api) };
}
it('只关闭本节目去重后的执行器，单独停止不会输出全局 Off 或停用 Timecode', async () => {
  const f = fixture(); await f.release.prepare(f.document);
  expect(f.api.playMa2Cue).not.toHaveBeenCalled();
  await f.release.release(); await f.release.release();
  expect(f.api.playMa2Cue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: { target: 'executor', executor: '51.101', action: 'off' } }));
});
it('断线和目标变化不会把旧歌曲关闭指令发给另一台控台，也不自动重发', async () => {
  const f = fixture(); await f.release.prepare(f.document);
  f.status.settings!.host = '192.0.2.2';
  await expect(f.release.release()).rejects.toThrow('控台连接变了');
  await f.release.release(); expect(f.api.playMa2Cue).not.toHaveBeenCalled();
});
it('准备期间取消，迟到结果不能恢复旧关闭计划', async () => {
  const f = fixture(); const preparing = f.release.prepare(f.document); f.release.cancelPreparation();
  await preparing; await f.release.release(); expect(f.api.playMa2Cue).not.toHaveBeenCalled();
});
it('播放只发时间码：停止只关时间码绑定的执行器和本曲控台序列的执行器，本地时间线上的 Cue 不发 Off', async () => {
  const f = fixture();
  expect(lightingReleaseActions(f.document)).toEqual([{ target: 'executor', executor: '51.101', action: 'off' }]);
  const local = { ...f.document, consoleSong: undefined };
  expect(lightingReleaseActions(local)).toEqual([]);
  await f.release.prepare(local); expect(f.api.getMa2NetworkStatus).not.toHaveBeenCalled();
  await f.release.release(); expect(f.api.playMa2Cue).not.toHaveBeenCalled();
});
