import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../registry/license-output', () => ({ requireOutputLicense: vi.fn().mockResolvedValue(undefined) }));
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, lightingTrackSchema } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../view-models/local-integration-profile';
import { InternalPlaybackController, emptyInternalPlayerState } from './internal-playback-controller';
import { MediaMtcOutput } from '../../registry/media-mtc-output';
import { PreflightBlockedError } from './preflight-blocked-error';
import { synchronizeP1ProjectCommand } from '@tb/core/link';

class FakeAudio extends EventTarget {
  paused = true; preload = ''; src = ''; currentTime = 0; volume = 1; error = null;
  onended: (() => void) | null = null; onerror: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve()); pause = vi.fn(); setSinkId = vi.fn(() => Promise.resolve());
  load(): void { queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
  removeAttribute(): void { this.src = ''; }
}
function fixture(grouped = false, nativeSeek = false, mtcInstance?: MediaMtcOutput) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const audio = new FakeAudio();
  const mtc = { connect: vi.fn((portName: string | null) => Promise.resolve(portName)), tick: vi.fn(), stop: vi.fn(), takeSchedulingNotice: vi.fn(() => null) };
  const deps = { prepare: vi.fn(() => Promise.resolve()), ingest: vi.fn(() => Promise.resolve()), pause: vi.fn(() => Promise.resolve()), stop: vi.fn(() => Promise.resolve()),
    started: vi.fn<(positionMs: number) => void>(), failed: vi.fn<(message: string, itemId: string | null) => void>(),
    scrub: nativeSeek ? vi.fn(() => Promise.resolve()) : undefined,
    resolveAudio: vi.fn(() => Promise.resolve('file:///original.wav')), configuration: (): { outputDeviceId: string; mtcPortName: string | null } => ({ outputDeviceId: 'default', mtcPortName: 'MA2' }),
    changed: vi.fn((next: typeof emptyInternalPlayerState) => { state = next; }) };
  let state = { ...emptyInternalPlayerState };
  const project = parseLinkProject({ ...createEmptyLinkProject('内部十首'), playbackSource: 'internal', rundown: Array.from({ length: 10 }, (_, index) => ({
    id: `song-${index}`, title: `歌曲 ${index}`, referenceAudio: { assetId: `audio-${index}`, relativePath: `${index}.wav`, sha256: 'a'.repeat(64), durationMs: 10_000 }
  })) });
  if (grouped) { project.playlists = [{ id: 'selected', name: '当前列表' }]; project.rundown[0]!.playlistId = 'selected'; project.rundown[2]!.playlistId = 'selected'; }
  const output = { prepare: vi.fn((): Promise<void | 'default-fallback'> => Promise.resolve()), captureMonitoringStream: vi.fn((): MediaStream | null => null), getAnalysis: () => null, dispose: () => Promise.resolve() };
  const controller = new InternalPlaybackController(project, deps, audio as unknown as HTMLAudioElement, mtcInstance ?? mtc as unknown as MediaMtcOutput, output);
  return { controller, deps, audio, mtc, project, output, state: () => state };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('播放失败把标题与原因交给失败回调，运行日志不再只剩 status:error', async () => {
  const f = fixture();
  f.deps.resolveAudio.mockRejectedValueOnce(new Error("ENOENT: no such file or directory, open 'D:\\show\\0.wav'"));
  await f.controller.play('song-0');
  expect(f.state()).toMatchObject({ status: 'error', errorTitle: '播放未开始：准备失败' });
  expect(f.deps.failed).toHaveBeenCalledWith('播放未开始：准备失败：所需文件或程序不存在：D:\\show\\0.wav。请重新选择有效路径后重试。', 'song-0');
});
it('浏览器播放器读取旧工程保留的 P1 起点，无需重新输入且不叠加源裁剪', async () => {
  const f = fixture();
  f.project.rundown[0]!.p1Media = { sourceKey: 'b'.repeat(64), playlistId: 'p1', sourceFileName: 'song.wav',
    playEndAction: 'stop', volume: 100, muted: false, shortcut: '', midiStartTime: '480.5',
    sourceTrim: { startMs: 3000, endMs: 13000, applied: true } };
  try {
    await f.controller.play('song-0');
    expect(f.state().mtcPositionMs).toBe(480500);
    f.audio.currentTime = 1; await vi.advanceTimersByTimeAsync(8);
    expect(f.mtc.tick).toHaveBeenCalledWith(481500, '30', expect.any(Number));
  } finally { f.controller.dispose(); }
});
it('异步准备期间保持已选音频线路，下一次明确播放才读取新配置', async () => {
  const f = fixture();
  let device = 'first-output';
  f.deps.configuration = () => ({ outputDeviceId: device, mtcPortName: 'MA2' });
  f.deps.stop.mockImplementationOnce(() => { device = 'second-output'; return Promise.resolve(); });
  await f.controller.play('song-0');
  expect(f.output.prepare).toHaveBeenLastCalledWith(f.audio, 'first-output', 48000);
  expect(f.state().status).toBe('playing');
  await f.controller.play('song-1');
  expect(f.output.prepare).toHaveBeenLastCalledWith(f.audio, 'second-output', 48000);
  f.controller.dispose();
});
it('MIDI 准备超出窗口后音频开始，迟到的端口结果不在歌中途补发', async () => {
  let resolveAccess: ((access: MIDIAccess) => void) | undefined;
  const access = new Promise<MIDIAccess>(resolve => { resolveAccess = resolve; });
  vi.stubGlobal('navigator', { requestMIDIAccess: () => access });
  const f = fixture(false, false, new MediaMtcOutput());
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
  const playing = f.controller.play('song-0');
  await vi.advanceTimersByTimeAsync(1001);
  await playing;
  expect(f.state().status).toBe('playing');
  expect(f.state().notice).toContain('准备窗口内未就绪');
  const send = vi.fn(), open = vi.fn();
  resolveAccess?.({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', connection: 'open', open, send }]]) } as unknown as MIDIAccess);
  await vi.advanceTimersByTimeAsync(8);
  expect(open).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(f.audio.play).toHaveBeenCalledOnce();
  f.controller.dispose();
});
it('原生保留绑定按实际音频位置加480秒起点发MTC，本地裁剪不重复计入，暂停停止发码', async () => {
  const f = fixture();
  f.project.rundown[0]!.playback = { volume: 100, endAction: 'stop', startMs: 1500, endMs: 9000, mtcOffsetMs: 480000, shortcut: '' };
  f.project.rundown[0]!.lighting = { ...createLightingDocument(), ma2Bindings: [{ id: 'native', timecode: 2, name: 'mei-nan', readAt: new Date().toISOString(), sourceXml: '<MA/>', mappings: [], baselineTracks: [], timeOriginMs: 480000, playback: 'native-timecode', nativeEvents: [{ path: 'learn', reason: '原生保留' }] }] };
  await f.controller.play('song-0');
  expect(f.audio.currentTime).toBe(1.5); expect(f.state().mtcPositionMs).toBe(481500);
  f.audio.currentTime = 2; await vi.advanceTimersByTimeAsync(8);
  expect(f.mtc.tick.mock.calls.at(-1)?.[0]).toBe(482000);
  await f.controller.pause(); const calls = f.mtc.tick.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000); expect(f.mtc.tick).toHaveBeenCalledTimes(calls);
  f.controller.dispose();
});
it('时间码模式遇到本地序列池 Cue 时照常播放音频并发原偏移时间码，但明确提示该 Cue 未单独发送', async () => {
  const f = fixture();
  const networkStatus = vi.fn(() => Promise.reject(new Error('MA2 网络未连接')));
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: networkStatus } });
  const item = f.project.rundown[0]!;
  item.playback = { volume: 100, endAction: 'stop', startMs: 1000, endMs: 9000, mtcOffsetMs: 480000, shortcut: '' };
  const lighting = createLightingDocument(); lighting.outputMode = 'timecode';
  lighting.tracks = [lightingTrackSchema.parse({ id: 'pool', name: '控台序列池', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '本地 Cue', start: 0, duration: 9000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', action: 'goto', sequence: 36, cue: '1.100', executor: '', label: 'Cue 1.1', at: 1000 }] }] })];
  lighting.ma2Bindings = [{ id: 'native', timecode: 2, name: 'mei-nan', readAt: new Date().toISOString(), sourceXml: '<MA/>', mappings: [], baselineTracks: [], timeOriginMs: 480000, playback: 'native-timecode', nativeEvents: [{ path: 'learn', reason: '原生保留' }] }];
  item.lighting = lighting;
  await f.controller.play(item.id);
  expect(f.audio.play).toHaveBeenCalledOnce();
  expect(networkStatus).not.toHaveBeenCalled();
  expect(f.state()).toMatchObject({ status: 'playing', error: null, mtcPositionMs: 481000 });
  expect(f.state().notice).toContain('本地序列池 Cue 不会单独发送');
  f.audio.currentTime = 2; await vi.advanceTimersByTimeAsync(8);
  expect(f.mtc.tick).toHaveBeenCalledWith(482000, '30', expect.any(Number));
  await f.controller.pause(); expect(f.state().status).toBe('paused');
  await f.controller.resume(); expect(f.state().status).toBe('playing');
  f.controller.dispose();
});
it('界面阻塞 200ms 后仅停止时间码，音乐继续且不自动重发', async () => {
  const send = vi.fn();
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', connection: 'open', open: () => Promise.resolve(), send }]]) }) });
  const f = fixture(false, false, new MediaMtcOutput());
  await f.controller.play('song-0');
  f.audio.currentTime = 0.008; await vi.advanceTimersByTimeAsync(8);
  const beforeStall = send.mock.calls.length;
  const clock = vi.spyOn(performance, 'now').mockReturnValue(208);
  f.audio.currentTime = 0.208; await vi.advanceTimersByTimeAsync(8);
  expect(f.state()).toMatchObject({ status: 'playing', error: null });
  expect(f.state().notice).toContain('超过一帧');
  expect(f.state().mtcConnectionFailed).toBe(true);
  expect(send).toHaveBeenCalledTimes(beforeStall);
  clock.mockReturnValue(224); f.audio.currentTime = 0.224;
  await vi.advanceTimersByTimeAsync(16);
  expect(f.state().status).toBe('playing');
  expect(send).toHaveBeenCalledTimes(beforeStall);
  await f.controller.pause(); const count = send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(100); expect(send).toHaveBeenCalledTimes(count);
  clock.mockRestore(); f.controller.dispose();
});
it('旧时间码配对失效不阻断网络 Cue；不发 MTC，曲尾等待最后一个 Cue 回执后停止', async () => {
  const f = fixture(); let acknowledge: (() => void) | undefined;
  const playMa2Cue = vi.fn(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  const cancelMa2Playback = vi.fn(async () => {});
  vi.stubGlobal('window', { tbLink: { playMa2Cue, cancelMa2Playback, getMa2NetworkStatus: () => Promise.resolve({ state: 'connected', settings: { host: '192.168.0.10', port: 30000, monitorPort: 30001, username: 'operator' }, passwordSaved: false, error: null, version: '3.9.60.74' }) } });
  const lighting = createLightingDocument(); lighting.outputMode = 'network';
  lighting.tracks = [lightingTrackSchema.parse({ id: 'pool', name: '池', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '尾部', start: 0, duration: 10000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', action: 'goto', sequence: 168, cue: '1', executor: '', label: '尾部', at: 9999 }] }] })];
  f.project.rundown[0]!.lighting = lighting;
  f.project.ma2ReadState = { source: 'console', catalog: { directory: { show: 'test', generation: 'session', version: '3.7.0.5', entries: [] }, readAt: '2026-10-08T00:00:00.000Z', entries: [] },
    pairs: {}, pairings: { '2': { itemId: 'song-0', status: 'stale', evidence: '', reason: '时间依据已变化' } }, failures: [], selectedTarget: null, query: '', filter: 'all', message: '' };
  await f.controller.play('song-0'); expect(f.mtc.connect).toHaveBeenCalledWith(null, false);
  f.audio.currentTime = 10; f.audio.onended?.(); await vi.advanceTimersByTimeAsync(0);
  expect(playMa2Cue).toHaveBeenCalledOnce(); expect(cancelMa2Playback).not.toHaveBeenCalled();
  acknowledge?.(); await vi.advanceTimersByTimeAsync(0);
  expect(f.state().status).toBe('paused'); expect(cancelMa2Playback).toHaveBeenCalledOnce();
  expect(f.state().notice).toBeNull();
  expect(f.project.ma2ReadState?.pairings?.['2']?.status).toBe('stale');
  f.controller.dispose();
});
it('OBS 准备和音频启动完成后才启用播放时钟，暂停继续重新确认起点', async () => {
  const f = fixture();
  f.deps.ingest.mockImplementationOnce(async () => { await vi.advanceTimersByTimeAsync(1200); expect(f.deps.started).not.toHaveBeenCalled(); });
  f.audio.play.mockImplementationOnce(async () => { await vi.advanceTimersByTimeAsync(800); expect(f.deps.started).not.toHaveBeenCalled(); });
  await f.controller.play('song-0', 500);
  expect(f.deps.started).toHaveBeenLastCalledWith(500);
  expect(f.state().status).toBe('playing');
  await vi.advanceTimersByTimeAsync(8);
  expect(f.state().status).toBe('playing');
  await f.controller.pause(); await vi.advanceTimersByTimeAsync(3000);
  await f.controller.resume();
  expect(f.deps.started).toHaveBeenCalledTimes(2);
  expect(f.state().status).toBe('playing');
  f.controller.dispose();
});
it('关闭 MTC 后不连接已保存的 MIDI 端口，系统 MIDI 故障不阻断无 MIDI 动作的音频', async () => {
  const request = vi.fn(() => Promise.reject(new Error('Windows MIDI 服务未响应')));
  vi.stubGlobal('navigator', { requestMIDIAccess: request });
  const f = fixture(false, false, new MediaMtcOutput());
  f.controller.toggleMtc();
  await f.controller.play('song-0');
  expect(request).not.toHaveBeenCalled();
  expect(f.deps.prepare).toHaveBeenCalledWith('song-0', 0, { reuseSession: false, mtcOutputEnabled: false });
  expect(f.audio.play).toHaveBeenCalledOnce();
  expect(f.state()).toMatchObject({ status: 'playing', mtcEnabled: false, mtcPortName: null, error: null });
  f.controller.dispose();
});
it('时间码连接失败时明确提示并继续播放音频', async () => {
  const request = vi.fn(() => Promise.reject(new Error('MIDI 设备检测未通过')));
  vi.stubGlobal('navigator', { requestMIDIAccess: request });
  const f = fixture(false, false, new MediaMtcOutput());
  await f.controller.play('song-0');
  expect(f.state()).toMatchObject({ status: 'playing', mtcEnabled: true, mtcConnectionFailed: true, mtcPortName: null });
  expect(f.state().notice).toContain('本次继续播放音频');
  expect(f.deps.prepare).toHaveBeenCalledWith('song-0', 0, { reuseSession: false, mtcOutputEnabled: false });
  expect(f.audio.play).toHaveBeenCalledOnce();
  await f.controller.stop();
  f.controller.toggleMtc(); await f.controller.play('song-0');
  expect(request).toHaveBeenCalledOnce();
  expect(f.state()).toMatchObject({ status: 'playing', mtcEnabled: false, mtcConnectionFailed: false, error: null });
  expect(f.audio.play).toHaveBeenCalledTimes(2);
  f.controller.dispose();
});
it('直接 MIDI 动作不可用也不阻断音频，并说明灯光未启动', async () => {
  const f = lightingFixture(5000);
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.reject(new Error('灯光 MIDI 设备未连接')) });
  f.controller.toggleMtc();
  await f.controller.play('song-0');
  expect(f.audio.play).toHaveBeenCalledOnce();
  expect(f.state()).toMatchObject({ status: 'playing', mtcConnectionFailed: false });
  expect(f.state().notice).toContain('灯光动作未启动');
  f.controller.dispose();
});
it('旧音频设备消失后改用 Windows 默认输出并在播放中显示明确提示', async () => {
  const f = fixture();
  f.output.prepare.mockResolvedValueOnce('default-fallback');
  await f.controller.play('song-0');
  expect(f.state()).toMatchObject({ status: 'playing', error: null });
  expect(f.state().notice).toContain('Windows 默认设备');
  expect(f.audio.play).toHaveBeenCalledOnce();
  await f.controller.stop();
  expect(f.state().notice).toBeNull();
  f.controller.dispose();
});
it('只导入 P1、不绑定 MA2 时间线，也从原歌曲起始时间码输出 MIDI', async () => {
  const f = fixture();
  const project = synchronizeP1ProjectCommand({
    sourceSha256: 'b'.repeat(64), playlists: [{ id: 'p1', name: '现场', sourceIndex: 0 }],
    items: [{ title: '原始时间码', referenceAudio: { assetId: 'trimmed', relativePath: 'trimmed.wav', sha256: 'c'.repeat(64), durationMs: 1250 },
      p1Media: { sourceKey: 'd'.repeat(64), playlistId: 'p1', sourceFileName: 'original.wav', playEndAction: 'stop', volume: 100, muted: false, shortcut: '', midiStartTime: '120' } }]
  }, () => 'imported').execute(f.project);
  f.project.rundown = project.rundown;
  await f.controller.play('imported');
  expect(f.audio.currentTime).toBe(0);
  expect(f.state().mtcPositionMs).toBe(120000);
  f.audio.currentTime = 0.5; await vi.advanceTimersByTimeAsync(8);
  expect(f.mtc.tick).toHaveBeenLastCalledWith(120500, '30', expect.any(Number));
  f.controller.dispose();
});
it('音频输出准备期间停止，迟到结果不得再申请 MIDI 或启动 OBS', async () => {
  const f = fixture();
  let finish = (): void => { throw new Error('音频输出尚未开始准备'); };
  f.output.prepare.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const preparing = f.controller.play('song-0');
  await vi.waitFor(() => expect(f.output.prepare).toHaveBeenCalledOnce());
  const stopping = f.controller.stop();
  finish(); await preparing; await stopping;
  expect(f.mtc.connect).not.toHaveBeenCalled();
  expect(f.deps.prepare).not.toHaveBeenCalled();
  expect(f.audio.play).not.toHaveBeenCalled();
  await f.controller.play('song-1');
  expect(f.state()).toMatchObject({ itemId: 'song-1', status: 'playing' });
  f.controller.dispose();
});
it('权限挂起时停止能够释放串行队列，随后可显式播放下一首', async () => {
  const request = vi.fn().mockReturnValueOnce(new Promise<never>(() => undefined)).mockResolvedValue({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', connection: 'open', open: () => Promise.resolve(), send: () => undefined }]]) });
  vi.stubGlobal('navigator', { requestMIDIAccess: request });
  const f = fixture(false, false, new MediaMtcOutput());
  const preparing = f.controller.play('song-0');
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  await f.controller.stop(); await preparing;
  expect(f.state().status).toBe('stopped');
  await f.controller.play('song-1');
  expect(f.state().status).toBe('playing'); expect(f.state().itemId).toBe('song-1');
  f.controller.dispose();
});
it('播放头反复吸附同一位置时复用在途定位，完成后不重复调用 OBS', async () => {
  const f = fixture(false, true);
  await f.controller.play('song-0', 0, true);
  let finish = (): void => { throw new Error('定位尚未开始'); };
  f.deps.scrub!.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const first = f.controller.scrub('song-0', 1000);
  await Promise.resolve();
  const duplicate = f.controller.scrub('song-0', 1000);
  expect(f.deps.scrub).toHaveBeenCalledOnce();
  finish(); await first; await duplicate;
  await f.controller.scrub('song-0', 1000);
  expect(f.deps.scrub).toHaveBeenCalledOnce();
  expect(f.audio.currentTime).toBe(1);
  await f.controller.scrub('song-0', 2000);
  expect(f.deps.scrub).toHaveBeenCalledTimes(2);
  expect(f.audio.currentTime).toBe(2);
  f.controller.dispose();
});
it('OBS 准备失败后音频仍可定位播放，后续定位不反复准备 OBS', async () => {
  const f = fixture(false, true);
  f.deps.prepare.mockRejectedValueOnce(new Error('OBS 无法唯一识别联动台音频窗口'));
  await f.controller.scrub('song-0', 1000);
  expect(f.state().status).toBe('paused');
  expect(f.state().notice).toContain('画面与联动未启动');
  for (const position of [1100, 1200, 1300, 1400]) await f.controller.scrub('song-0', position);
  expect(f.deps.prepare).toHaveBeenCalledOnce();
  expect(f.audio.play).not.toHaveBeenCalled();
  expect(f.mtc.tick).not.toHaveBeenCalled();
  await f.controller.play('song-0', 1400);
  expect(f.deps.prepare).toHaveBeenCalledTimes(2);
  expect(f.state()).toMatchObject({ status: 'playing', error: null });
  f.controller.dispose();
});
it('无 OBS 联动时拖动播放头同样暂停并重置 MTC，继续后从新位置发码', async () => {
  const send = vi.fn();
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['ma', { name: 'MA2', state: 'connected', connection: 'open', open: () => Promise.resolve(), send }]]) }) });
  const f = fixture(false, true, new MediaMtcOutput());
  f.project.rundown[0]!.playback = { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: 480000, shortcut: '' };
  f.deps.prepare.mockRejectedValue(new Error('OBS 未连接'));
  await f.controller.play('song-0');
  f.audio.currentTime = 0.016; await vi.advanceTimersByTimeAsync(16);
  await f.controller.scrub('song-0', 4000);
  expect(f.state().status).toBe('paused');
  const sent = send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(100);
  expect(send).toHaveBeenCalledTimes(sent);
  await f.controller.resume();
  f.audio.currentTime = 4.016; await vi.advanceTimersByTimeAsync(8);
  expect(f.state()).toMatchObject({ status: 'playing', mtcConnectionFailed: false, mtcPortName: 'MA2' });
  expect(send.mock.calls.filter(call => call[0][0] === 0xf0).at(-1)?.[0].slice(5, 9)).toEqual([0x60, 8, 4, 0]);
  expect(f.deps.prepare).toHaveBeenCalledOnce(); f.controller.dispose();
});
it('连续点击继续只启动一个音频播放和一个输出计时器', async () => {
  const f = fixture(); await f.controller.play('song-0'); await f.controller.pause();
  await Promise.all([f.controller.resume(), f.controller.resume()]);
  expect(f.audio.play).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1); f.controller.dispose();
});
it('旧歌曲继续播放的迟到结果不能暂停新歌曲', async () => {
  const f = fixture(); await f.controller.play('song-0'); await f.controller.pause();
  let finish: (() => void) | undefined;
  f.audio.play.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const resuming = f.controller.resume();
  await vi.waitFor(() => expect(finish).toBeDefined());
  await f.controller.play('song-1');
  const pauses = f.audio.pause.mock.calls.length;
  finish?.(); await resuming;
  expect(f.state()).toMatchObject({ status: 'playing', itemId: 'song-1' });
  expect(f.audio.pause).toHaveBeenCalledTimes(pauses); f.controller.dispose();
});
it('旧歌曲继续准备的迟到失败不能关闭新歌曲联动', async () => {
  const f = fixture(); await f.controller.play('song-0'); await f.controller.pause();
  let rejectOld: ((error: Error) => void) | undefined;
  f.deps.ingest.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
  const old = f.controller.resume();
  await f.controller.play('song-1');
  const before = f.deps.ingest.mock.calls.length;
  rejectOld?.(new Error('旧歌曲超时')); await old;
  expect(f.state().notice).toBeNull();
  f.audio.currentTime = 0.1; await vi.advanceTimersByTimeAsync(8);
  expect(f.deps.ingest.mock.calls.length).toBeGreaterThan(before); f.controller.dispose();
});
it.each(['manual', 'end'] as const)('旧歌曲暂停的迟到失败不能关闭新歌曲联动：%s', async kind => {
  const f = fixture(); await f.controller.play('song-0');
  let rejectOld: ((error: Error) => void) | undefined;
  f.deps.pause.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
  let pausing: Promise<void> | undefined;
  if (kind === 'manual') pausing = f.controller.pause();
  else { f.controller.setEndAction('pause'); f.audio.currentTime = 10; f.audio.onended?.(); }
  expect(rejectOld).toBeDefined();
  await f.controller.play('song-1');
  rejectOld?.(new Error('旧歌曲暂停超时')); await pausing;
  await Promise.resolve();
  expect(f.state()).toMatchObject({ itemId: 'song-1', status: 'playing', notice: null });
  const before = f.deps.ingest.mock.calls.length;
  f.audio.currentTime = 0.1; await vi.advanceTimersByTimeAsync(8);
  expect(f.deps.ingest.mock.calls.length).toBeGreaterThan(before);
  f.controller.dispose();
});
it('停止操作迟到失败不能取消随后点击的新歌曲', async () => {
  const f = fixture(); await f.controller.play('song-0');
  let rejectOld: ((error: Error) => void) | undefined;
  f.deps.stop.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
  const stopping = f.controller.stop();
  await Promise.resolve();
  expect(rejectOld).toBeDefined();
  const playing = f.controller.play('song-1');
  rejectOld?.(new Error('旧歌曲停止超时'));
  await stopping; await playing;
  expect(f.state()).toMatchObject({ itemId: 'song-1', status: 'playing', error: null });
  expect(f.audio.play).toHaveBeenCalledTimes(2);
  f.controller.dispose();
});
it('播放错误的清理结果迟到时不覆盖已恢复歌曲的状态', async () => {
  const f = fixture();
  let rejectCleanup: ((error: Error) => void) | undefined;
  f.deps.stop.mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectCleanup = reject; }));
  f.deps.resolveAudio.mockRejectedValueOnce(new Error('音频路径失效'));
  await f.controller.play('song-0');
  expect(f.state().status).toBe('error');
  expect(rejectCleanup).toBeDefined();
  await f.controller.play('song-1');
  rejectCleanup?.(new Error('旧清理超时')); await Promise.resolve();
  expect(f.state()).toMatchObject({ itemId: 'song-1', status: 'playing', error: null });
  f.controller.dispose();
});
it('MA2 绑定起点驱动内部音乐时间码，直接输出模式不再发送重复 MTC', async () => {
  const f = fixture();
  const item = f.project.rundown[0]!;
  item.lighting = createLightingDocument();
  item.lighting.ma2Bindings = [{ id: 'binding', timecode: 1, name: 'TC', readAt: new Date().toISOString(), sourceXml: '<MA/>', baselineTracks: [], mappings: [], timeOriginMs: 3600000 }];
  await f.controller.play(item.id);
  f.audio.currentTime = 1; await vi.advanceTimersByTimeAsync(8);
  expect(f.mtc.tick).toHaveBeenCalledWith(3601000, '30', expect.any(Number));
  await f.controller.stop(); item.lighting.outputMode = 'direct'; f.mtc.tick.mockClear();
  await f.controller.play(item.id); f.audio.currentTime = 2; await vi.advanceTimersByTimeAsync(8);
  expect(f.mtc.connect).toHaveBeenLastCalledWith(null, false); expect(f.mtc.tick).not.toHaveBeenCalled();
  f.controller.dispose();
});
it('音频真正启动后才连接监测音轨', async () => {
  const f = fixture();
  let checked = false;
  f.deps.ingest.mockImplementationOnce(() => {
    expect(f.state().status).toBe('preparing');
    expect(f.audio.paused).toBe(true);
    expect(f.controller.captureMonitoringStream()).toBeNull();
    expect(f.output.captureMonitoringStream).not.toHaveBeenCalled();
    checked = true;
    return Promise.resolve();
  });
  await f.controller.play('song-0');
  expect(checked).toBe(true);
  expect(f.state().status).toBe('playing');
  f.controller.captureMonitoringStream();
  expect(f.output.captureMonitoringStream).toHaveBeenCalledOnce();
  f.controller.dispose();
});

it('连续拖动保留已准备的音频与 OBS 会话，松手后从最后位置继续', async () => {
  const f = fixture(false, true);
  const load = vi.spyOn(f.audio, 'load');
  await f.controller.play('song-0', 0, true);
  f.deps.prepare.mockClear(); f.deps.stop.mockClear(); load.mockClear();
  await f.controller.scrub('song-0', 1000); await f.controller.scrub('song-0', 4000); await f.controller.scrub('song-0', 2000);
  expect(f.deps.scrub?.mock.calls).toEqual([[1000], [4000], [2000]]);
  expect(f.deps.prepare).not.toHaveBeenCalled(); expect(f.deps.stop).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
  expect(f.state()).toMatchObject({ status: 'paused', positionMs: 2000 });
  await f.controller.resume(); expect(f.audio.currentTime).toBe(2); expect(f.state().status).toBe('playing');
  f.controller.dispose();
});

it('停止后立即播放必须等待旧 OBS 会话清理完成', async () => {
  const f = fixture();
  await f.controller.play('song-0');
  f.deps.prepare.mockClear();
  let finishStop: () => void = () => { throw new Error('停止尚未开始'); };
  const cleanup = new Promise<void>((resolve) => { finishStop = resolve; });
  f.deps.stop.mockImplementationOnce(() => cleanup);
  const stopping = f.controller.stop();
  const playing = f.controller.play('song-1', 2000);
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  expect(f.deps.stop).toHaveBeenCalledTimes(2);
  expect(f.deps.prepare).not.toHaveBeenCalled();
  finishStop();
  await Promise.all([stopping, playing]);
  expect(f.state()).toMatchObject({ status: 'playing', itemId: 'song-1', positionMs: 2000 });
  f.controller.dispose();
});

function lightingFixture(endMs = 10000) {
  const f = fixture();
  const profile = createDefaultIntegrationProfile();
  profile.midiPortProfiles.push({ id: 'lighting-out', direction: 'output', portName: 'Lighting Test' });
  const sent: number[][] = [];
  const send = vi.fn((bytes: number[]) => { sent.push([...bytes]); });
  const port = { name: 'Lighting Test', state: 'connected', open: () => Promise.resolve(), send };
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['out', port]]) }) });
  const config = f.deps.configuration();
  f.deps.configuration = () => ({ ...config, lightingProfile: profile });
  const document = createLightingDocument(); document.outputMode = 'direct';
  document.tracks = [{ id: 'light', name: '灯光', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: 'lighting-out', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 11000, timeLock: 'time', muted: false, events: [
    { id: 'held', kind: 'note', at: endMs - 10, note: 60, velocity: 100, duration: 100 },
    { id: 'last', kind: 'ma2', at: endMs - 1, cue: '1.25', action: 'goto', executor: '1.5', sequence: 1, label: '最后一个 Cue' },
    { id: 'outside', kind: 'cc', at: endMs, controller: 7, value: 99 }
  ] }] }];
  f.project.schemaVersion = 2; f.project.rundown[0]!.lighting = document;
  return { ...f, sent, send };
}
describe('内部正式音乐主控', () => {
  it('各曲独立音量用于切歌、重播和定位，未配置的歌曲不继承上一首临时音量', async () => {
    const f = fixture();
    f.project.rundown[0]!.playback = { volume: 35, startMs: 0, endMs: 0, mtcOffsetMs: 0, endAction: 'stop', shortcut: '' };
    f.project.rundown[2]!.playback = { volume: 0, startMs: 0, endMs: 0, mtcOffsetMs: 0, endAction: 'stop', shortcut: '' };
    await f.controller.play('song-0'); expect(f.audio.volume).toBe(.35);
    f.controller.setVolume(12);
    await f.controller.play('song-1'); expect(f.audio.volume).toBe(1);
    await f.controller.play('song-2'); expect(f.audio.volume).toBe(0);
    await f.controller.play('song-0'); expect(f.audio.volume).toBe(.35);
    await f.controller.seek(3000); expect(f.audio.volume).toBe(.35);
    expect(f.audio.currentTime).toBe(3);
    f.controller.fade(true); await vi.advanceTimersByTimeAsync(600); expect(f.audio.volume).toBe(0);
    f.controller.fade(false); await vi.advanceTimersByTimeAsync(600); expect(f.audio.volume).toBe(.35);
    f.controller.dispose();
  });
  it('联动预检阻断保留原因，但不阻断已有音频', async () => {
    const f = fixture();
    f.deps.prepare.mockRejectedValueOnce(new PreflightBlockedError({
      checkedAt: new Date().toISOString(), mode: 'live', passed: false, checks: [
        { id: 'scene', label: '完整场景模式：歌曲 0', status: 'blocking', detail: '显示来源与完整场景模式冲突，请在 Cue 编排中移除此动作。' },
        { id: 'audio', label: '参考音频：歌曲 1', status: 'blocking', detail: '文件不可读，请重新导入。' },
        { id: 'obs', label: 'OBS', status: 'passed', detail: '已连接' }
      ]
    }));
    await f.controller.play('song-0');
    expect(f.state().status).toBe('playing');
    expect(f.state().notice).toContain('显示来源与完整场景模式冲突');
    expect(f.audio.play).toHaveBeenCalledOnce();
    expect(f.deps.ingest).not.toHaveBeenCalled();
    await f.controller.play('song-0');
    expect(f.state()).toMatchObject({ status: 'playing', error: null, errorTitle: null });
    f.controller.dispose();
  });
  it('灯光循环使用同一音频重新定位 OBS 和 MTC，并释放上一轮音符', async () => {
    const f = lightingFixture(5000);
    f.project.rundown[0]!.lighting!.loop = { enabled: true, startMs: 2000, endMs: 5000 };
    await f.controller.play('song-0');
    expect(f.controller.clock.read().positionMs).toBe(f.audio.currentTime * 1000);
    f.audio.currentTime = 4.995; await vi.advanceTimersByTimeAsync(8);
    f.audio.currentTime = 5; await vi.advanceTimersByTimeAsync(8);
    expect(f.sent.map((bytes) => bytes[0])).toEqual([0x90, 0xf0, 0x80]);
    expect(f.deps.prepare).toHaveBeenLastCalledWith('song-0', 2000, { reuseSession: true, mtcOutputEnabled: false });
    expect(f.audio.currentTime).toBe(2);
    expect(f.state().status).toBe('playing');
    f.controller.dispose();
  });
  it.each(['natural', 'crop'] as const)('结束前最后一个 Cue 不漏发，音符释放且不发送结束边界之后的点：%s', async (mode) => {
    const endMs = mode === 'crop' ? 5000 : 10000;
    const f = lightingFixture(endMs);
    f.project.rundown[0]!.playback = { volume: 100, startMs: 0, endMs, mtcOffsetMs: 0, endAction: 'pause', shortcut: '' };
    await f.controller.play('song-0');
    f.audio.currentTime = (endMs - 5) / 1000; await vi.advanceTimersByTimeAsync(8);
    expect(f.sent).toEqual([[0x90, 60, 100]]);
    f.audio.currentTime = endMs / 1000;
    if (mode === 'natural') f.audio.onended?.(); else await vi.advanceTimersByTimeAsync(8);
    expect(f.sent.map((bytes) => bytes[0])).toEqual([0x90, 0xf0, 0x80]);
    expect(f.state().status).toBe('paused');
    f.audio.onended?.(); await f.controller.stop();
    expect(f.sent).toHaveLength(3); f.controller.dispose();
  });
  it('结尾输出失败时释放已发音符并保留音频结束状态', async () => {
    const f = lightingFixture(); await f.controller.play('song-0');
    f.audio.currentTime = 9.995; await vi.advanceTimersByTimeAsync(8);
    f.send.mockImplementation((bytes) => { if (bytes[0] === 0xf0) throw new Error('末尾 Cue 发送失败'); f.sent.push([...bytes]); });
    f.audio.currentTime = 10; f.audio.onended?.(); await vi.advanceTimersByTimeAsync(0);
    expect(f.state()).toMatchObject({ status: 'paused', itemId: 'song-0', error: null });
    expect(f.state().notice).toContain('末尾 Cue 发送失败');
    expect(f.audio.play).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([[0x90, 60, 100], [0x80, 60, 0]]); f.controller.dispose();
  });
  it('逐曲裁剪和偏移使用真实媒体位置，播完暂停且继续从裁剪起点重播', async () => {
    const f = fixture(); f.project.rundown[0]!.playback = { volume: 35, startMs: 2000, endMs: 4000, mtcOffsetMs: 60000, endAction: 'pause', shortcut: '' };
    await f.controller.play('song-0'); expect(f.audio.currentTime).toBe(2); expect(f.audio.volume).toBe(.35);
    expect(f.state().mtcPositionMs).toBe(62000);
    await vi.advanceTimersByTimeAsync(8); expect(f.mtc.tick).toHaveBeenLastCalledWith(62000, '30', expect.any(Number));
    f.audio.currentTime = 4; await vi.advanceTimersByTimeAsync(8); expect(f.state().status).toBe('paused');
    expect(f.state().mtcPositionMs).toBe(64000);
    await f.controller.resume(); expect(f.audio.currentTime).toBe(2); expect(f.state().status).toBe('playing'); f.controller.dispose();
  });
  it('IBC MIDI Note Off 不触发，Note60 启动第一首，CC7 控音量，Note2 停止', async () => {
    const f = fixture(); f.controller.receiveMidi(new Uint8Array([0x90, 60, 0])); await vi.advanceTimersByTimeAsync(0); expect(f.audio.play).not.toHaveBeenCalled();
    f.controller.receiveMidi(new Uint8Array([0x90, 60, 127])); await vi.advanceTimersByTimeAsync(0); expect(f.state().itemId).toBe('song-0');
    f.controller.receiveMidi(new Uint8Array([0xb0, 7, 0])); expect(f.audio.volume).toBe(0);
    f.controller.receiveMidi(new Uint8Array([0x90, 2, 127])); await vi.advanceTimersByTimeAsync(0); expect(f.state().status).toBe('stopped'); f.controller.dispose();
  });
  it('当前列表连播跳过其他列表，列表结束停止', async () => {
    const f = fixture(true); f.controller.setEndAction('next'); f.controller.setPlaylist('selected'); await f.controller.play('song-0');
    f.audio.onended?.(); await vi.advanceTimersByTimeAsync(0);
    expect(f.state().itemId).toBe('song-2');
    f.audio.onended?.(); await vi.advanceTimersByTimeAsync(0);
    expect(f.state().status).toBe('stopped'); expect(f.audio.play).toHaveBeenCalledTimes(2); f.controller.dispose();
  });
  it('默认播完暂停在结尾，不自动播放下一首', async () => {
    const f = fixture(); await f.controller.play('song-0');
    expect(f.state().endAction).toBe('pause');
    f.audio.currentTime = 10; f.audio.onended?.(); await vi.advanceTimersByTimeAsync(0);
    expect(f.state()).toMatchObject({ status: 'paused', itemId: 'song-0', positionMs: 10000 });
    expect(f.audio.play).toHaveBeenCalledTimes(1); f.controller.dispose();
  });
  it('使用实际解码位置，暂停不空跑，继续不重置位置', async () => {
    const f = fixture(); await f.controller.play('song-0');
    f.audio.currentTime = 1.25; await vi.advanceTimersByTimeAsync(8);
    expect(f.deps.ingest).toHaveBeenLastCalledWith(1250);
    await f.controller.pause(); const count = f.deps.ingest.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000); expect(f.deps.ingest).toHaveBeenCalledTimes(count);
    await f.controller.resume(); expect(f.deps.ingest).toHaveBeenLastCalledWith(1250);
    expect(f.state().status).toBe('playing'); f.controller.dispose();
  });
  it('十首连续播放，最后停止并清理，不回到第一首', async () => {
    const f = fixture(); f.controller.setEndAction('next'); await f.controller.play('song-0');
    for (let index = 0; index < 10; index += 1) {
      expect(f.state().itemId).toBe(`song-${index}`);
      f.audio.onended?.(); await vi.advanceTimersByTimeAsync(0);
    }
    expect(f.state().status).toBe('stopped'); expect(f.audio.play).toHaveBeenCalledTimes(10);
    expect(f.deps.stop).toHaveBeenCalledTimes(11); f.controller.dispose();
  });
  it('快速点击只播放最后选择，准备中停止不得晚到启动', async () => {
    const f = fixture();
    await Promise.all([f.controller.play('song-0'), f.controller.play('song-1'), f.controller.play('song-2')]);
    expect(f.audio.play).toHaveBeenCalledTimes(1); expect(f.state().itemId).toBe('song-2');
    const pending = f.controller.play('song-3'); await f.controller.stop(); await pending;
    expect(f.audio.play).toHaveBeenCalledTimes(1); expect(f.state().status).toBe('stopped'); f.controller.dispose();
  });
  it('音频停止推进超过 500ms，停止输出并显示错误', async () => {
    const f = fixture(); await f.controller.play('song-0');
    await vi.advanceTimersByTimeAsync(520);
    expect(f.state().status).toBe('error'); expect(f.state().error).toContain('停止更新');
    const count = f.mtc.tick.mock.calls.length; await vi.advanceTimersByTimeAsync(1000);
    expect(f.mtc.tick).toHaveBeenCalledTimes(count); f.controller.dispose();
  });
  it('MIDI 断开停止发码但音频继续，且不自动重连', async () => {
    const f = fixture(); await f.controller.play('song-0'); f.mtc.tick.mockImplementation(() => { throw new Error('MIDI 已断开'); });
    await vi.advanceTimersByTimeAsync(8); expect(f.state()).toMatchObject({ status: 'playing', error: null, mtcPortName: null });
    expect(f.state().notice).toContain('MIDI 已断开');
    const ticks = f.mtc.tick.mock.calls.length; const connections = f.mtc.connect.mock.calls.length;
    const ingested = f.deps.ingest.mock.calls.length;
    f.audio.currentTime = 0.1; await vi.advanceTimersByTimeAsync(100);
    expect(f.mtc.tick).toHaveBeenCalledTimes(ticks); expect(f.mtc.connect).toHaveBeenCalledTimes(connections);
    expect(f.deps.ingest.mock.calls.length).toBeGreaterThanOrEqual(ingested);
    expect(f.state().status).toBe('playing'); f.controller.dispose();
  });
  it('暂停时定位保持暂停，循环只重播当前歌', async () => {
    const f = fixture(); await f.controller.play('song-1'); await f.controller.pause(); await f.controller.seek(3000);
    expect(f.state().status).toBe('paused'); expect(f.audio.currentTime).toBe(3); expect(f.deps.prepare).toHaveBeenLastCalledWith('song-1', 3000, { reuseSession: true, mtcOutputEnabled: true });
    await f.controller.resume(); f.controller.setEndAction('loop'); f.audio.onended?.(); await vi.advanceTimersByTimeAsync(0);
    expect(f.state()).toMatchObject({ status: 'playing', itemId: 'song-1', positionMs: 0 }); f.controller.dispose();
  });
});

it('歌曲播放自动识别未配置的唯一 MIDI 输出，并公布实际发送时间码', async () => {
  const send = vi.fn();
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['usb', { name: 'USB MIDI', state: 'connected', connection: 'open', open: () => Promise.resolve(), send }]]) }) });
  const f = fixture(false, false, new MediaMtcOutput());
  f.deps.configuration = () => ({ outputDeviceId: 'default', mtcPortName: null });
  f.project.rundown[0]!.lighting = { ...createLightingDocument(), ma2Bindings: [{ id: 'binding', timecode: 1, name: 'TC', readAt: new Date().toISOString(), sourceXml: '<MA/>', baselineTracks: [], mappings: [], timeOriginMs: 120000 }] };
  await f.controller.play('song-0');
  expect(f.state()).toMatchObject({ status: 'playing', mtcPortName: 'USB MIDI', mtcSentPositionMs: null });
  for (let i = 1; i <= 8; i++) { f.audio.currentTime = i * 0.008; await vi.advanceTimersByTimeAsync(8); }
  expect(f.state().mtcSentPositionMs).toBeGreaterThan(0);
  expect(send.mock.calls.some(call => call[0][0] === 0xf1)).toBe(true);
  await f.controller.pause(); const count = send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(100); expect(send).toHaveBeenCalledTimes(count);
  f.controller.dispose();
});
it('无 MIDI 输出时继续音频且不显示为时间码已发送', async () => {
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map() }) });
  const f = fixture(false, false, new MediaMtcOutput());
  f.deps.configuration = () => ({ outputDeviceId: 'default', mtcPortName: null });
  f.project.rundown[0]!.lighting = { ...createLightingDocument(), ma2Bindings: [{ id: 'binding', timecode: 1, name: 'TC', readAt: new Date().toISOString(), sourceXml: '<MA/>', baselineTracks: [], mappings: [], timeOriginMs: 120000 }] };
  await f.controller.play('song-0');
  expect(f.state()).toMatchObject({ status: 'playing', mtcPortName: null, mtcSentPositionMs: null });
  expect(f.state().notice).toContain('未检测到灯光 MIDI 输出');
  expect(f.audio.play).toHaveBeenCalledOnce();
  f.controller.dispose();
});
