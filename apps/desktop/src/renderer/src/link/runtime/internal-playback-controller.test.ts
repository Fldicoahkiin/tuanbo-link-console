import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject } from '@tb/schema';
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
  const mtc = { connect: vi.fn(() => Promise.resolve()), tick: vi.fn(), stop: vi.fn() };
  const deps = { prepare: vi.fn(() => Promise.resolve()), ingest: vi.fn(() => Promise.resolve()), pause: vi.fn(() => Promise.resolve()), stop: vi.fn(() => Promise.resolve()),
    started: vi.fn<(positionMs: number) => void>(),
    scrub: nativeSeek ? vi.fn(() => Promise.resolve()) : undefined,
    resolveAudio: vi.fn(() => Promise.resolve('file:///original.wav')), configuration: (): { outputDeviceId: string; mtcPortName: string | null } => ({ outputDeviceId: 'default', mtcPortName: 'MA2' }),
    changed: vi.fn((next: typeof emptyInternalPlayerState) => { state = next; }) };
  let state = { ...emptyInternalPlayerState };
  const project = parseLinkProject({ ...createEmptyLinkProject('内部十首'), playbackSource: 'internal', rundown: Array.from({ length: 10 }, (_, index) => ({
    id: `song-${index}`, title: `歌曲 ${index}`, referenceAudio: { assetId: `audio-${index}`, relativePath: `${index}.wav`, sha256: 'a'.repeat(64), durationMs: 10_000 }
  })) });
  if (grouped) { project.playlists = [{ id: 'selected', name: '当前列表' }]; project.rundown[0]!.playlistId = 'selected'; project.rundown[2]!.playlistId = 'selected'; }
  const output = { prepare: vi.fn((): Promise<void | 'default-fallback'> => Promise.resolve()), captureMonitoringStream: vi.fn((): MediaStream | null => null), dispose: () => Promise.resolve() };
  const controller = new InternalPlaybackController(project, deps, audio as unknown as HTMLAudioElement, mtcInstance ?? mtc as unknown as MediaMtcOutput, output);
  return { controller, deps, audio, mtc, project, output, state: () => state };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
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
it('时间码连接失败不悄悄跳过灯光；操作者明确关闭后才能重试音频', async () => {
  const request = vi.fn(() => Promise.reject(new Error('MIDI 设备检测未通过')));
  vi.stubGlobal('navigator', { requestMIDIAccess: request });
  const f = fixture(false, false, new MediaMtcOutput());
  await f.controller.play('song-0');
  expect(f.state()).toMatchObject({ status: 'error', mtcEnabled: true, mtcConnectionFailed: true, errorTitle: '播放未开始：时间码输出不可用' });
  expect(f.audio.play).not.toHaveBeenCalled();
  expect(f.deps.prepare).not.toHaveBeenCalled();
  f.controller.toggleMtc();
  await f.controller.play('song-0');
  expect(request).toHaveBeenCalledOnce();
  expect(f.state()).toMatchObject({ status: 'playing', mtcEnabled: false, mtcConnectionFailed: false, error: null });
  expect(f.audio.play).toHaveBeenCalledOnce();
  f.controller.dispose();
});
it('关闭 MTC 也不能绕过节目实际包含的直接 MIDI 动作', async () => {
  const f = lightingFixture(5000);
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.reject(new Error('灯光 MIDI 设备未连接')) });
  f.controller.toggleMtc();
  await f.controller.play('song-0');
  expect(f.audio.play).not.toHaveBeenCalled();
  expect(f.state()).toMatchObject({ status: 'error', mtcConnectionFailed: false });
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
it('OBS 准备失败后连续拖动不重试，明确播放才重新准备', async () => {
  const f = fixture(false, true);
  f.deps.prepare.mockRejectedValueOnce(new Error('OBS 无法唯一识别联动台音频窗口'));
  await f.controller.scrub('song-0', 1000);
  expect(f.state().status).toBe('error');
  const notifications = f.deps.changed.mock.calls.length;
  for (const position of [1100, 1200, 1300, 1400]) await f.controller.scrub('song-0', position);
  expect(f.deps.prepare).toHaveBeenCalledOnce();
  expect(f.deps.changed).toHaveBeenCalledTimes(notifications);
  expect(f.audio.play).not.toHaveBeenCalled();
  expect(f.mtc.tick).not.toHaveBeenCalled();
  await f.controller.play('song-0', 1400);
  expect(f.deps.prepare).toHaveBeenCalledTimes(2);
  expect(f.state()).toMatchObject({ status: 'playing', error: null });
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
it('发布播放状态后、audio.play 启动前即可连接监测音轨', async () => {
  const f = fixture();
  let checked = false;
  f.deps.ingest.mockImplementationOnce(() => {
    expect(f.state().status).toBe('playing');
    expect(f.audio.paused).toBe(true);
    f.controller.captureMonitoringStream();
    expect(f.output.captureMonitoringStream).toHaveBeenCalledOnce();
    checked = true;
    return Promise.resolve();
  });
  await f.controller.play('song-0');
  expect(checked).toBe(true);
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
  it('预检阻断保留节目和全部原因，不启动音频，手动重播后清除旧提示', async () => {
    const f = fixture();
    f.deps.prepare.mockRejectedValueOnce(new PreflightBlockedError({
      checkedAt: new Date().toISOString(), mode: 'live', passed: false, checks: [
        { id: 'scene', label: '完整场景模式：歌曲 0', status: 'blocking', detail: '显示来源与完整场景模式冲突，请在 Cue 编排中移除此动作。' },
        { id: 'audio', label: '参考音频：歌曲 1', status: 'blocking', detail: '文件不可读，请重新导入。' },
        { id: 'obs', label: 'OBS', status: 'passed', detail: '已连接' }
      ]
    }));
    await f.controller.play('song-0');
    expect(f.state().errorTitle).toBe('播放未开始：预检未通过');
    expect(f.state().error).toBe('完整场景模式：歌曲 0：显示来源与完整场景模式冲突，请在 Cue 编排中移除此动作。\n参考音频：歌曲 1：文件不可读，请重新导入。');
    expect(f.audio.play).not.toHaveBeenCalled();
    expect(f.deps.ingest).not.toHaveBeenCalled();
    await f.controller.play('song-0');
    expect(f.state()).toMatchObject({ status: 'playing', error: null, errorTitle: null });
    f.controller.dispose();
  });
  it('灯光循环使用同一音频重新定位 OBS 和 MTC，并释放上一轮音符', async () => {
    const f = lightingFixture(5000);
    f.project.rundown[0]!.lighting!.loop = { enabled: true, startMs: 2000, endMs: 5000 };
    await f.controller.play('song-0');
    expect(f.controller.mediaElement).toBe(f.audio);
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
  it('结尾输出失败时释放已发音符并进入错误状态，不继续下一首', async () => {
    const f = lightingFixture(); await f.controller.play('song-0');
    f.audio.currentTime = 9.995; await vi.advanceTimersByTimeAsync(8);
    f.send.mockImplementation((bytes) => { if (bytes[0] === 0xf0) throw new Error('末尾 Cue 发送失败'); f.sent.push([...bytes]); });
    f.audio.currentTime = 10; f.audio.onended?.(); await vi.advanceTimersByTimeAsync(0);
    expect(f.state()).toMatchObject({ status: 'error', itemId: 'song-0', error: '末尾 Cue 发送失败' });
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
  it('MIDI 断开不继续空跑', async () => {
    const f = fixture(); await f.controller.play('song-0'); f.mtc.tick.mockImplementation(() => { throw new Error('MIDI 已断开'); });
    await vi.advanceTimersByTimeAsync(8); expect(f.state()).toMatchObject({ status: 'error', error: 'MIDI 已断开' });
    const ticks = f.mtc.tick.mock.calls.length; const connections = f.mtc.connect.mock.calls.length;
    const ingested = f.deps.ingest.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.mtc.tick).toHaveBeenCalledTimes(ticks); expect(f.mtc.connect).toHaveBeenCalledTimes(connections);
    expect(f.deps.ingest).toHaveBeenCalledTimes(ingested); expect(f.audio.pause).toHaveBeenCalled();
    expect(f.state().status).toBe('error'); f.controller.dispose();
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
it('需要灯光时间码但无 MIDI 输出时阻断音乐，不出现假同步', async () => {
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map() }) });
  const f = fixture(false, false, new MediaMtcOutput());
  f.deps.configuration = () => ({ outputDeviceId: 'default', mtcPortName: null });
  f.project.rundown[0]!.lighting = { ...createLightingDocument(), ma2Bindings: [{ id: 'binding', timecode: 1, name: 'TC', readAt: new Date().toISOString(), sourceXml: '<MA/>', baselineTracks: [], mappings: [], timeOriginMs: 120000 }] };
  await f.controller.play('song-0');
  expect(f.state().error).toContain('未检测到灯光 MIDI 输出');
  expect(f.audio.play).not.toHaveBeenCalled(); expect(f.deps.prepare).not.toHaveBeenCalled();
  f.controller.dispose();
});
