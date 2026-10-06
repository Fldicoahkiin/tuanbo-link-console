import { afterEach, expect, it, vi } from 'vitest';
import { createLightingDocument, lightingTrackSchema, type Ma2NetworkStatus } from '@tb/schema';
import { compileLightingNetworkActions, compileLightingPackets, collectLightingOutputProfileIds } from '@tb/core/link';
import { LightingNetworkOutput } from './lighting-network-output';
import { LightingCueAudition } from './lighting-cue-audition';

afterEach(() => vi.unstubAllGlobals());
function setup() {
  const document = createLightingDocument(); document.outputMode = 'network';
  document.tracks = [lightingTrackSchema.parse({ id: 'pool', name: '序列池', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '开场', start: 0, duration: 5000, timeLock: 'time', muted: false, events: [100, 200].map((at, index) => ({ id: `cue-${index}`, at, kind: 'ma2', action: 'goto', sequence: 168, cue: `${index + 1}.250`, executor: '', label: '开场' })) }] })];
  const status: Ma2NetworkStatus = { state: 'connected', settings: { host: '192.168.0.10', port: 30000, monitorPort: 30001, username: 'operator', autoConnect: false }, passwordSaved: false, version: '3.9.60.74', error: null };
  const api = { requireOutputLicense: vi.fn(async () => {}), getMa2NetworkStatus: vi.fn(() => Promise.resolve(status)), playMa2Cue: vi.fn(async () => {}), cancelMa2Playback: vi.fn(async () => {}) };
  const midi = vi.fn(); vi.stubGlobal('navigator', { requestMIDIAccess: midi }); vi.stubGlobal('window', { tbLink: api });
  return { document, status, api, midi, output: new LightingNetworkOutput() };
}

it('序列池不依赖 MIDI，静音排除，时间码模式不伪造执行器也不阻断音乐', () => {
  const f = setup();
  expect(compileLightingNetworkActions(f.document)).toEqual([1, 2].map((value) => ({ atMs: value * 100, action: { target: 'sequence', sequence: 168, cue: `${value}.250`, action: 'goto' } })));
  expect(compileLightingPackets(f.document)).toEqual([]); expect(collectLightingOutputProfileIds(f.document)).toEqual([]);
  expect(() => compileLightingPackets({ ...f.document, outputMode: 'direct' })).toThrow('序列池');
  expect(compileLightingPackets({ ...f.document, outputMode: 'timecode' })).toEqual([]);
  f.document.tracks[0]!.muted = true; expect(compileLightingNetworkActions(f.document)).toEqual([]);
});

it('后台关闭必须等网络取消回执；取消失败不报告已经释放', async () => {
  const f = setup(); await f.output.prepare(f.document, 0);
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let reject: ((error: Error) => void) | undefined;
  f.api.cancelMa2Playback.mockImplementationOnce(() => new Promise<void>((_resolve, failed) => { reject = failed; }));
  let settled = false;
  const closing = f.output.close().finally(() => { settled = true; });
  const failed = expect(closing).rejects.toThrow('取消未完成');
  try {
    await Promise.resolve(); expect(settled).toBe(false); reject!(new Error('控台取消未确认')); await failed;
    expect(diagnostic).toHaveBeenCalledWith('取消灯光网络输出失败', expect.any(Error));
  } finally { diagnostic.mockRestore(); }
});

it('准备期间停止不会恢复输出，定位不会补发之前的 Cue，尾部等待回执', async () => {
  const f = setup();
  const preparing = f.output.prepare(f.document, 0); f.output.stop(); await preparing;
  f.output.tick(200); await Promise.resolve(); expect(f.api.playMa2Cue).not.toHaveBeenCalled();
  await f.output.prepare(f.document, 150); await f.output.finish(201);
  expect(f.api.playMa2Cue).toHaveBeenCalledOnce();
  expect(f.api.playMa2Cue.mock.calls[0]).toEqual([expect.objectContaining({ action: { target: 'sequence', sequence: 168, cue: '2.250', action: 'goto' } })]);
  expect(f.midi).not.toHaveBeenCalled(); f.output.stop();
});

it('停止取消未发送队列；首条失败阻止后续，不重试也不改走 MIDI', async () => {
  const f = setup(); await f.output.prepare(f.document, 0); f.output.tick(200); f.output.stop();
  await Promise.resolve(); expect(f.api.playMa2Cue).not.toHaveBeenCalled();
  await f.output.prepare(f.document, 0); f.api.playMa2Cue.mockRejectedValueOnce(new Error('网络已断开'));
  await expect(f.output.finish(201)).rejects.toThrow('网络已断开');
  expect(f.api.playMa2Cue).toHaveBeenCalledOnce(); expect(f.api.cancelMa2Playback).toHaveBeenCalled();
  expect(f.midi).not.toHaveBeenCalled();
});

it('上一首的取消回执迟到失败不能污染新歌曲，错误仍保留诊断', async () => {
  const f = setup();
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let rejectCancel: ((error: Error) => void) | undefined;
  try {
    await f.output.prepare(f.document, 0);
    f.api.cancelMa2Playback.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectCancel = reject; }));
    f.output.stop();
    await f.output.prepare(f.document, 150);
    rejectCancel!(new Error('上一首取消回执超时'));
    await Promise.resolve();
    await expect(f.output.finish(201)).resolves.toBeUndefined();
    expect(f.api.playMa2Cue).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith('取消灯光网络输出失败', expect.any(Error));
    f.output.stop();
  } finally { diagnostic.mockRestore(); }
});

it('选中池 Cue 直接试听，连接未建立时显示错误而不请求 MIDI', async () => {
  const f = setup(); const audition = new LightingCueAudition();
  expect(await audition.play(f.document, 'cue-0', null)).toBe(1);
  expect(f.api.playMa2Cue).toHaveBeenCalledWith(expect.objectContaining({ action: { target: 'sequence', sequence: 168, cue: '1.250', action: 'goto' } }));
  f.status.state = 'disconnected';
  await expect(audition.play(f.document, 'cue-1', null)).rejects.toThrow('先连接 MA2 网络');
  expect(f.api.playMa2Cue).toHaveBeenCalledOnce(); expect(f.midi).not.toHaveBeenCalled();
});

it('网络埋步按播放位置触发，停播取消，直接预览只发送正式 Cue', async () => {
  const f = setup();
  const clip = f.document.tracks[0]!.clips[0]!;
  clip.events = [{ id: 'prepared', at: 3000, kind: 'ma2', sequence: 168, executor: '', action: 'goto', cue: '2', label: '副歌', preparation: { cue: '1', leadMs: 1500 } }];
  await f.output.prepare(f.document, 0);
  await f.output.finish(1499); expect(f.api.playMa2Cue).not.toHaveBeenCalled();
  await f.output.finish(1501); expect(f.api.playMa2Cue).toHaveBeenLastCalledWith(expect.objectContaining({ action: { target: 'sequence', sequence: 168, cue: '1', action: 'goto' } }));
  f.output.stop(); f.output.tick(3000); expect(f.api.playMa2Cue).toHaveBeenCalledOnce();
  await f.output.prepare(f.document, 2000); await f.output.finish(3001);
  expect(f.api.playMa2Cue).toHaveBeenCalledTimes(2);
  expect(f.api.playMa2Cue).toHaveBeenLastCalledWith(expect.objectContaining({ action: { target: 'sequence', sequence: 168, cue: '2', action: 'goto' } }));
  f.output.stop(); f.api.playMa2Cue.mockClear();
  expect(await new LightingCueAudition().play(f.document, 'prepared', null)).toBe(1);
  expect(f.api.playMa2Cue).toHaveBeenCalledOnce();
  expect(f.api.playMa2Cue).toHaveBeenLastCalledWith(expect.objectContaining({ action: { target: 'sequence', sequence: 168, cue: '2', action: 'goto' } }));
});
