import { expect, it, vi } from 'vitest';
import { createLightingDocument, lightingDocumentSchema, type LightingEvent, type Ma2PlaybackRequest } from '@tb/schema';
import { compileLightingNetworkActions, compileLightingPackets, LightingScheduler } from './lighting-playback';
import { LightingNetworkOutput } from './lighting-network-output';

function cue(id: string, sequence: number, at: number, runMode?: 'independent' | 'follow', group?: string): LightingEvent {
  return { id, kind: 'ma2', at, sequence, cue: '1', executor: `1.${100 + sequence}`, action: 'goto', label: id, runMode, ...(group ? { effectGroupId: group } : {}) };
}
function document(events: LightingEvent[]) { return lightingDocumentSchema.parse({ ...createLightingDocument(), version: 2, outputMode: 'network', tracks: [{ id: 'track', name: '灯光', kind: 'ma2', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '曲', start: 0, duration: 10000, timeLock: 'time', muted: false, events }] }] }); }
it('单独运行先关闭此前组合，跟随保留，旧工程行为不改变', () => {
  const result = compileLightingNetworkActions(document([cue('a', 1, 0), cue('b', 2, 100, 'follow'), cue('c', 3, 200, 'independent')]));
  expect(result.map(value => [value.atMs, value.action.action, value.action.target === 'executor' ? value.action.executor : ''])).toEqual([[0,'goto','1.101'],[100,'goto','1.102'],[200,'off','1.101'],[200,'off','1.102'],[200,'goto','1.103']]);
  expect(result.slice(2,4).every(value => value.releaseOnlyIfStarted)).toBe(true);
  expect(compileLightingNetworkActions(document([cue('a',1,0),cue('b',2,100)])).map(value => value.action.action)).toEqual(['goto','goto']);
});
it('组合只切换一次、取消前组迟到素材，同一时间的独立 Cue 不互相关闭', () => {
  const values = compileLightingNetworkActions(document([cue('a',1,0,'independent','a'),cue('a-late',2,300,'independent','a'),cue('b',3,100,'independent','b'),cue('b-late',4,200,'independent','b'),cue('c',5,100,'independent')]));
  expect(values.map(value => value.action.target === 'executor' ? `${value.action.action}:${value.action.executor}` : '')).toEqual(['goto:1.101','off:1.101','goto:1.103','goto:1.105','goto:1.104']);
});
it('埋步切换整组，静音轨道不参与，原生时间码不能静默忽略单独运行', () => {
  const prepared = cue('b',2,2000,'independent'); if (prepared.kind !== 'ma2') throw new Error('fixture'); prepared.preparation = { cue: '0.5', leadMs: 500 };
  const value = document([cue('a',1,0), prepared]);
  expect(compileLightingNetworkActions(value).map(entry => [entry.atMs,entry.action.action])).toEqual([[0,'goto'],[1500,'off'],[1500,'goto'],[2000,'goto']]);
  expect(compileLightingNetworkActions({ ...value, tracks: value.tracks.map(track => ({ ...track, muted: true })) })).toEqual([]);
  expect(() => compileLightingPackets({ ...document([cue('a',1,0,'independent')]), outputMode: 'timecode' })).toThrow('单独运行');
});
it('MIDI 定位不会关闭本次没有启动的执行器，连续播放则先 Off 再 Go', () => {
  const packets = compileLightingPackets({ ...document([cue('a',1,0),cue('b',2,100,'independent')]), outputMode: 'direct' });
  const sent: number[] = []; const scheduler = new LightingScheduler(packets, value => sent.push(value.bytes[5]!));
  scheduler.locate(50); scheduler.tick(100); expect(sent).toEqual([1]);
  sent.length = 0; scheduler.locate(0); scheduler.tick(0); scheduler.tick(100); expect(sent).toEqual([1,11,1]);
});
it('网络定位只释放本会话成功触发的目标，关闭失败后不发送新 Cue', async () => {
  const playMa2Cue = vi.fn<(request: Ma2PlaybackRequest) => Promise<void>>().mockResolvedValue(undefined); const cancelMa2Playback = vi.fn().mockResolvedValue(undefined);
  const api = { playMa2Cue, cancelMa2Playback, getMa2NetworkStatus: vi.fn().mockResolvedValue({ state: 'connected', version: '3.7.0.5', passwordSaved: false, error: null, settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false } }) };
  const value = document([cue('a',1,0),cue('b',2,100,'independent')]);
  const output = new LightingNetworkOutput(api, error => { throw error; });
  await output.prepare(value, 50); await output.finish(101); expect(playMa2Cue.mock.calls.map(call => call[0].action.action)).toEqual(['goto']);
  playMa2Cue.mockClear(); await output.prepare(value, 0); playMa2Cue.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('off failed'));
  await expect(output.finish(101)).rejects.toThrow('off failed'); expect(playMa2Cue.mock.calls.map(call => call[0].action.action)).toEqual(['goto','off']); await output.close();
});

it('MIDI 循环回到单独运行 Cue 时关闭上轮实际启动的目标', () => {
  const packets = compileLightingPackets({ ...document([cue('a',1,0,'independent'),cue('b',2,100,'follow')]), outputMode: 'direct' });
  const sent: number[] = []; const scheduler = new LightingScheduler(packets, value => sent.push(value.bytes[5]!));
  scheduler.tick(0); scheduler.tick(100); scheduler.loop(0,200); scheduler.tick(0);
  expect(sent).toEqual([1,1,11,11,1]);
});
