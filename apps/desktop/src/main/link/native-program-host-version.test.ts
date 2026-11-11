import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkProject, type NativePlayerPrepare, type NativePlayerStatus } from '@tb/schema';
import { NativeProgramHost } from './native-program-host';

/** The projects action MIDI was prepared with (NativeMidiHost.prepare), in order. */
const prepared = vi.hoisted(() => [] as LinkProject[]);
vi.mock('./native-midi-host', () => ({
  NativeMidiHost: class {
    prepare(project: LinkProject): Promise<void> { prepared.push(project); return Promise.resolve(); }
    stop(): Promise<void> { return Promise.resolve(); }
    observe(): void { /* no MIDI device in this test */ }
    interrupt(): void { /* no MIDI device in this test */ }
  }
}));

// 0.5.9 S7：节目不再随修改重建，动作 MIDI 准备时读的是播放器现在的那一版，不是建宿主时的那一版。
it('动作 MIDI 按播放器现在的那一版工程准备：停着时换上的新一版，下一首就用它', async () => {
  const project = parseLinkProject({ ...createEmptyLinkProject('动作 MIDI 版本'), playbackSource: 'internal',
    rundown: [{ id: 'song', title: '歌', referenceAudio: { assetId: 'a', relativePath: 'a.wav', sha256: 'a'.repeat(64), durationMs: 10000 },
      playback: { startMs: 0, endMs: 9000, mtcOffsetMs: 0, volume: 80, endAction: 'pause', shortcut: '' } }] });
  let status: NativePlayerStatus | null = null;
  const prepare = (request: NativePlayerPrepare): Promise<NativePlayerStatus> => {
    const s = request.snapshot;
    status = { version: 1, sessionId: request.sessionId, generation: request.generation, itemId: s.itemId, status: 'ready', positionMs: s.positionMs,
      offsetMs: s.offsetMs, sampleRate: s.sampleRate, enginePid: 1, engineTitle: 'engine', mtcPortName: null, mtcSent: 0, audioError: null, mtcError: null,
      underruns: 0, mtcInterruptions: 0, gain: s.volume, analysis: null };
    return Promise.resolve(status);
  };
  const host = new NativeProgramHost(project, 'C:/test/show.tblink', 1, {
    executable: 'engine.exe', audio: () => status, midiOutputs: () => Promise.resolve([]), authorize: () => Promise.resolve(), preciseSeeking: () => false,
    configuration: () => ({ outputDeviceId: 'default', audioSampleRate: 48000, mtcPortName: null, preload: false }),
    changed: () => undefined, midiChanged: () => undefined, midiRecovered: () => undefined, notice: () => undefined, closedFault: () => undefined,
    api: { prepareNativePlayback: prepare, controlNativePlayback: request => Promise.resolve({ ...status!, generation: request.generation,
      status: request.kind === 'play' ? 'playing' : request.kind === 'stop' ? 'stopped' : status!.status }),
    getNativePlaybackDevices: () => Promise.resolve({ protocol: 4 as const, audio: [], midiOutputs: [], midiInputs: [] }),
    prepareNativeObs: () => Promise.reject(new Error('没有 OBS')), stopNativeObs: () => Promise.resolve(), onNativeObsStatus: () => () => undefined,
    preloadNativeObs: () => Promise.reject(new Error('没有 OBS')), cancelNativeObsPreload: () => Promise.resolve() },
    lighting: { change: () => Promise.resolve({ failed: [] }), stop: () => Promise.resolve({ failed: [] }) }
  });
  try {
    await host.controller.play('song');
    expect(prepared).toEqual([project]);
    await host.controller.stop();
    const next = { ...structuredClone(project), name: '新的一版' };
    host.controller.updateProject(next, 2, 'C:/test/show.tblink');
    await host.controller.play('song');
    expect(prepared.at(-1)).toBe(next);
  } finally { await host.close(); }
});
