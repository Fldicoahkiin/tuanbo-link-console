import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { emptyInternalPlayerState, type InternalPlayerState } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject } from '@tb/schema';
import { NativeAudioCache } from './native-audio-cache';
import { NativePlayerService } from './native-player-service';
import { probeWindowsMidi } from './windows-midi-health';
import { NativeProgramHost } from './native-program-host';
import { LightingOffService } from './lighting-off-service';

const windowsTest = it.skipIf(process.platform !== 'win32' || process.env.TBLINK_NATIVE_ENGINE_TEST !== '1');

// Actual native audio and the production program/MIDI/lighting hosts. The MIDI
// and lighting documents are empty, OBS is absent, and audio is silent. This
// verifies host ownership and transport, not physical lighting or OBS output.
windowsTest('正式后台宿主使用真实 WASAPI 换歌、暂停恢复；空灯光通道不会把播放确认当成过期设备时钟', async () => {
  if (!ffmpeg) throw new Error('测试缺少 FFmpeg');
  const directory = await mkdtemp(join(tmpdir(), 'tblink-complete-host-'));
  const wav = Buffer.alloc(44 + 48000 * 4 * 4);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const path = join(directory, 'silence.wav'); await writeFile(path, wav);
  const project = parseLinkProject({ ...createEmptyLinkProject('完整后台宿主隔离测试'), schemaVersion: 2, playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [0, 1].map(index => ({ id: `song-${index}`, title: `静音 ${index}`, referenceAudio: { assetId: `audio-${index}`,
      relativePath: 'silence.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 4000 }, lighting: createLightingDocument(),
      playback: { startMs: 500, endMs: index ? 3500 : 1200, mtcOffsetMs: 480000 + index * 60000, volume: 0, endAction: index ? 'pause' : 'next', shortcut: '' } })) });
  let host: NativeProgramHost | null = null, state: InternalPlayerState = { ...emptyInternalPlayerState };
  const errors: string[] = [], notices: string[] = [];
  const executable = resolve(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? 'tools/playback-engine/bin/tblink-playback.exe');
  const service = new NativePlayerService({ executable, cache: new NativeAudioCache(join(directory, 'cache'), ffmpeg), resolveAudio: () => path,
    checkDeviceHealth: async () => { expect(await probeWindowsMidi(resolve('tools/midi-probe/bin/tblink-midi-probe.exe'))).toBe('ready'); },
    changed: (status, qpc) => host?.observe(status, qpc), beforeControl: request => host?.interrupt(request), error: message => errors.push(message),
    preloadError: message => errors.push(message) });
  host = new NativeProgramHost(project, join(directory, 'project.tblink'), 1, {
    executable, audio: () => service.status, midiOutputs: async () => (await service.devices('all', true)).midiOutputs, authorize: () => Promise.resolve(), preciseSeeking: () => false,
    configuration: () => ({ outputDeviceId: 'default', audioSampleRate: 48000, mtcPortName: null, preload: false }),
    changed: value => { state = value; }, midiChanged: () => undefined, midiRecovered: () => undefined, notice: message => notices.push(message),
    closedFault: message => errors.push(message),
    api: { prepareNativePlayback: request => service.prepare(request), controlNativePlayback: request => service.control(request),
      getNativePlaybackDevices: () => service.devices(), prepareNativeObs: () => Promise.reject(new Error('隔离测试没有 OBS')),
      stopNativeObs: () => Promise.resolve(), onNativeObsStatus: () => () => undefined,
      preloadNativeObs: () => Promise.reject(new Error('隔离测试没有 OBS')), cancelNativeObsPreload: () => Promise.resolve() },
    lighting: new LightingOffService({ console: { getMa2NetworkStatus: () => Promise.reject(new Error('空灯光不应访问控台')),
      playMa2Cue: () => Promise.reject(new Error('隔离测试禁止网络灯光输出')) }, resending: () => undefined, failed: message => errors.push(message) })
  });
  host.controller.toggleMtc();
  try {
    await host.controller.play('song-0');
    await expect.poll(() => state.itemId, { timeout: 4000 }).toBe('song-1');
    await expect.poll(() => service.status?.positionMs).toBeGreaterThan(650);
    await host.controller.pause(); expect(state.status).toBe('paused'); const paused = service.status!.positionMs;
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(service.status!.positionMs).toBe(paused);
    await host.controller.resume(); await expect.poll(() => service.status!.positionMs).toBeGreaterThan(paused + 100);
    expect(service.status).toMatchObject({ itemId: 'song-1', offsetMs: 540000, underruns: 0, audioError: null, status: 'playing' });
    expect(errors).toEqual([]);
    expect(notices.filter(message => /灯光|MIDI Cue/.test(message))).toEqual([]);
  } finally { await host.close(); await service.close(); }
}, 15000);

// Item 10 end to end: at 44.1 kHz a song end of 1203 ms is 53052.3 samples; the
// engine ends on sample 53052 (1202.993 ms) and lighting must finish there.
windowsTest('44.1kHz 真实引擎曲尾不在整采样上时，灯光按引擎实际结束位置收尾，不报曲尾灯光未完成', async () => {
  if (!ffmpeg) throw new Error('测试缺少 FFmpeg');
  const directory = await mkdtemp(join(tmpdir(), 'tblink-441-tail-'));
  const wav = Buffer.alloc(44 + 44100 * 4 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(176400, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const path = join(directory, 'silence.wav'); await writeFile(path, wav);
  const project = parseLinkProject({ ...createEmptyLinkProject('44.1kHz 曲尾'), schemaVersion: 2, playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '静音', referenceAudio: { assetId: 'audio', relativePath: 'silence.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 2000 },
      lighting: createLightingDocument(), playback: { startMs: 500, endMs: 1203, mtcOffsetMs: 480000, volume: 0, endAction: 'pause', shortcut: '' } }] });
  let host: NativeProgramHost | null = null, state: InternalPlayerState = { ...emptyInternalPlayerState };
  const errors: string[] = [], notices: string[] = [];
  const executable = resolve(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? 'tools/playback-engine/bin/tblink-playback.exe');
  const service = new NativePlayerService({ executable, cache: new NativeAudioCache(join(directory, 'cache'), ffmpeg), resolveAudio: () => path,
    checkDeviceHealth: () => Promise.resolve(),
    changed: (status, qpc) => host?.observe(status, qpc), beforeControl: request => host?.interrupt(request), error: message => errors.push(message),
    preloadError: message => errors.push(message) });
  host = new NativeProgramHost(project, join(directory, 'project.tblink'), 1, {
    executable, audio: () => service.status, midiOutputs: async () => (await service.devices('all', true)).midiOutputs, authorize: () => Promise.resolve(), preciseSeeking: () => false,
    configuration: () => ({ outputDeviceId: 'default', audioSampleRate: 44100, mtcPortName: null, preload: false }),
    changed: value => { state = value; }, midiChanged: () => undefined, midiRecovered: () => undefined, notice: message => notices.push(message),
    closedFault: message => errors.push(message),
    api: { prepareNativePlayback: request => service.prepare(request), controlNativePlayback: request => service.control(request),
      getNativePlaybackDevices: () => service.devices(), prepareNativeObs: () => Promise.reject(new Error('隔离测试没有 OBS')),
      stopNativeObs: () => Promise.resolve(), onNativeObsStatus: () => () => undefined,
      preloadNativeObs: () => Promise.reject(new Error('隔离测试没有 OBS')), cancelNativeObsPreload: () => Promise.resolve() },
    lighting: new LightingOffService({ console: { getMa2NetworkStatus: () => Promise.reject(new Error('空灯光不应访问控台')),
      playMa2Cue: () => Promise.reject(new Error('隔离测试禁止网络灯光输出')) }, resending: () => undefined, failed: message => errors.push(message) })
  });
  host.controller.toggleMtc();
  try {
    await host.controller.play('song');
    await expect.poll(() => state.status, { timeout: 4000 }).toBe('paused');
    expect(service.status?.positionMs).not.toBe(1203);
    expect(Math.abs((service.status?.positionMs ?? 0) - 1203)).toBeLessThan(1);
    expect(errors).toEqual([]);
    expect(notices.filter(message => /灯光/.test(message))).toEqual([]);
  } finally { await host.close(); await service.close(); }
}, 15000);
