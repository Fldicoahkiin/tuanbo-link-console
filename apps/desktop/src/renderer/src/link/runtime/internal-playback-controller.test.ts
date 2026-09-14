import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../view-models/local-integration-profile';
import { InternalPlaybackController, emptyInternalPlayerState } from './internal-playback-controller';
import type { MediaMtcOutput } from '../../registry/media-mtc-output';
import { PreflightBlockedError } from './preflight-blocked-error';

class FakeAudio extends EventTarget {
  paused = true; preload = ''; src = ''; currentTime = 0; volume = 1; error = null;
  onended: (() => void) | null = null; onerror: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve()); pause = vi.fn(); setSinkId = vi.fn(() => Promise.resolve());
  load(): void { queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
  removeAttribute(): void { this.src = ''; }
}
function fixture(grouped = false, nativeSeek = false) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const audio = new FakeAudio();
  const mtc = { connect: vi.fn(() => Promise.resolve()), tick: vi.fn(), stop: vi.fn() };
  const deps = { prepare: vi.fn(() => Promise.resolve()), ingest: vi.fn(() => Promise.resolve()), pause: vi.fn(() => Promise.resolve()), stop: vi.fn(() => Promise.resolve()),
    scrub: nativeSeek ? vi.fn(() => Promise.resolve()) : undefined,
    resolveAudio: vi.fn(() => Promise.resolve('file:///original.wav')), configuration: () => ({ outputDeviceId: 'default', mtcPortName: 'MA2' }),
    changed: vi.fn((next: typeof emptyInternalPlayerState) => { state = next; }) };
  let state = { ...emptyInternalPlayerState };
  const project = parseLinkProject({ ...createEmptyLinkProject('内部十首'), playbackSource: 'internal', rundown: Array.from({ length: 10 }, (_, index) => ({
    id: `song-${index}`, title: `歌曲 ${index}`, referenceAudio: { assetId: `audio-${index}`, relativePath: `${index}.wav`, sha256: 'a'.repeat(64), durationMs: 10_000 }
  })) });
  if (grouped) { project.playlists = [{ id: 'selected', name: '当前列表' }]; project.rundown[0]!.playlistId = 'selected'; project.rundown[2]!.playlistId = 'selected'; }
  const output = { prepare: vi.fn(() => Promise.resolve()), captureMonitoringStream: vi.fn((): MediaStream | null => null), dispose: () => Promise.resolve() };
  const controller = new InternalPlaybackController(project, deps, audio as unknown as HTMLAudioElement, mtc as unknown as MediaMtcOutput, output);
  return { controller, deps, audio, mtc, project, output, state: () => state };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
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
    expect(f.deps.prepare).toHaveBeenLastCalledWith('song-0', 2000, true);
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
    await vi.advanceTimersByTimeAsync(8); expect(f.state()).toMatchObject({ status: 'error', error: 'MIDI 已断开' }); f.controller.dispose();
  });
  it('暂停时定位保持暂停，循环只重播当前歌', async () => {
    const f = fixture(); await f.controller.play('song-1'); await f.controller.pause(); await f.controller.seek(3000);
    expect(f.state().status).toBe('paused'); expect(f.audio.currentTime).toBe(3); expect(f.deps.prepare).toHaveBeenLastCalledWith('song-1', 3000, true);
    await f.controller.resume(); f.controller.setEndAction('loop'); f.audio.onended?.(); await vi.advanceTimersByTimeAsync(0);
    expect(f.state()).toMatchObject({ status: 'playing', itemId: 'song-1', positionMs: 0 }); f.controller.dispose();
  });
});
