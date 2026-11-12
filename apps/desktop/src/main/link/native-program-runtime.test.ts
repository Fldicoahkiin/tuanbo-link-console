import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { NativeProgramPlayer, emptyInternalPlayerState, type InternalPlayerState } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type NativePlayerStatus } from '@tb/schema';
import { NativeAudioCache } from './native-audio-cache';
import { NativePlayerService } from './native-player-service';
import { probeWindowsMidi } from './windows-midi-health';

const windowsTest = it.skipIf(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1');

// This host test deliberately has no renderer, OBS, MIDI or lighting devices.
// It verifies the shared transport against real WASAPI, not full-chain output.
async function fixture(gateNext = false) {
  if (!ffmpeg) throw new Error('测试缺少 FFmpeg');
  const directory = await mkdtemp(join(tmpdir(), 'tblink-program-runtime-'));
  const wav = Buffer.alloc(44 + 48000 * 4 * 4);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const path = join(directory, 'silence.wav'); await writeFile(path, wav);
  const project = parseLinkProject({ ...createEmptyLinkProject('后台换歌隔离验收'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [0, 1, 2].map(index => ({ id: `song-${index}`, title: `静音 ${index}`, referenceAudio: {
      assetId: `audio-${index}`, relativePath: 'silence.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 4000 },
    playback: { startMs: index ? 500 : 100, endMs: index === 2 ? 3500 : 1200,
      mtcOffsetMs: 480000 + index * 60000, volume: 0, endAction: index === 2 ? 'pause' : 'next', shortcut: '' } })) });
  const listeners = new Set<(status: NativePlayerStatus) => void>();
  const states: Pick<NativePlayerStatus, 'itemId' | 'generation' | 'status' | 'positionMs' | 'offsetMs' | 'underruns' | 'audioError'>[] = [];
  const failures: string[] = [], notices: string[] = [];
  let state: InternalPlayerState = { ...emptyInternalPlayerState }, nextPreparing = false;
  let release: (() => void) | undefined;
  const nextGate = new Promise<void>(resolve => { release = resolve; });
  const cache = new NativeAudioCache(join(directory, 'cache'), ffmpeg);
  let preparedCount = 0;
  const service = new NativePlayerService({ executable: resolve(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? 'tools/playback-engine/bin/tblink-playback.exe'),
    checkDeviceHealth: async () => { expect(await probeWindowsMidi(resolve('tools/midi-probe/bin/tblink-midi-probe.exe'))).toBe('ready'); },
    cache: { prepare: async (input, signal) => {
      if (++preparedCount === 2 && gateNext) { nextPreparing = true; await nextGate; }
      return cache.prepare(input, signal);
    } }, resolveAudio: () => path, error: message => { failures.push(message); }, preloadError: message => { failures.push(message); }, changed: status => {
      const { itemId, generation, positionMs, offsetMs, underruns, audioError } = status;
      states.push({ itemId, generation, status: status.status, positionMs, offsetMs, underruns, audioError });
      for (const listener of listeners) listener(status);
    } });
  const runtime = new NativeProgramPlayer(project, join(directory, 'project.tblink'), 1, {
    prepare: itemId => {
      const item = project.rundown.find(item => item.id === itemId);
      if (!item || item.cues.length || item.lighting) return Promise.reject(new Error('此验收宿主未提供 MIDI 或灯光适配器'));
      return Promise.resolve();
    }, ingest: () => Promise.resolve(), pause: () => Promise.resolve(), stop: () => Promise.resolve(),
    resolveAudio: () => Promise.reject(new Error('原生宿主不使用浏览器音源地址')),
    configuration: () => ({ outputDeviceId: 'default', mtcPortName: null, audioSampleRate: 48000, preload: !gateNext }),
    changed: next => { state = next; }, notice: message => { notices.push(message); }, closedFault: message => { failures.push(message); }
  }, {
    prepareNativePlayback: request => service.prepare(request), controlNativePlayback: request => service.control(request),
    getNativePlaybackDevices: () => service.devices(),
    onNativePlaybackStatus: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    prepareNativeObs: () => Promise.reject(new Error('隔离验收未连接 OBS')),
    stopNativeObs: () => Promise.resolve(), onNativeObsStatus: () => () => undefined,
    preloadNativeObs: () => Promise.reject(new Error('隔离验收未连接 OBS')), prepareNextNativePlayback: () => Promise.resolve(), prepareNextNativeObs: () => Promise.resolve(), cancelNativeObsPreload: () => Promise.resolve()
  }, {
    change: () => Promise.reject(new Error('隔离验收未提供灯光适配器')), stop: () => Promise.resolve({ failed: [] }), widen: () => undefined
  });
  runtime.toggleMtc();
  return { runtime, service, failures, notices, states, state: () => state, nextPreparing: () => nextPreparing,
    release: () => release!(), close: async () => { release!(); await runtime.stop(); await runtime.dispose(); await service.close(); } };
}

windowsTest('无界面宿主用真实设备时钟连续换三首，下一首保留独立偏移与裁剪', async () => {
  const f = await fixture();
  try {
    await f.runtime.play('song-0');
    const pid = f.service.status!.enginePid;
    // The first two actual audio ranges last 1.8 seconds; Vitest's default
    // one-second polling deadline cannot contain the requested playback.
    await expect.poll(() => f.state().itemId, { timeout: 3000 }).toBe('song-2');
    await expect.poll(() => f.service.status?.positionMs).toBeGreaterThan(700);
    expect(f.service.status).toMatchObject({ itemId: 'song-2', status: 'playing', enginePid: pid, offsetMs: 600000, underruns: 0, audioError: null });
    expect(f.state().playedItemIds).toEqual(['song-0', 'song-1']);
    const firstPlaying = [0, 1, 2].map(index => f.states.find(status => status.itemId === `song-${index}` && status.status === 'playing'));
    expect(firstPlaying.map(status => status?.offsetMs)).toEqual([480000, 540000, 600000]);
    expect(firstPlaying[1]!.positionMs).toBeGreaterThanOrEqual(500);
    expect(firstPlaying[1]!.positionMs).toBeLessThan(700);
    expect(f.failures).toEqual([]);
    expect(f.notices.filter(message => message.includes('OBS'))).toHaveLength(3);
  } finally { await f.close(); }
}, 12000);

windowsTest('后台换歌准备中停止，迟到的下一首解码不得恢复播放', async () => {
  const f = await fixture(true);
  try {
    await f.runtime.play('song-0');
    await expect.poll(f.nextPreparing, { timeout: 2500 }).toBe(true);
    const stopped = f.runtime.stop(); f.release(); await stopped;
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(f.state().status).toBe('stopped');
    expect(f.service.status?.status).toBe('stopped');
    expect(f.states.filter(status => status.itemId === 'song-1' && status.status === 'playing')).toEqual([]);
    expect(f.failures).toEqual([]);
  } finally { await f.close(); }
}, 12000);
