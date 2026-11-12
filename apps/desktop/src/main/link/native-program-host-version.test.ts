import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkProject, type NativeObsPrepare, type NativeObsRetarget, type NativeObsStatus, type NativePlayerPrepare, type NativePlayerStatus } from '@tb/schema';
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
    preloadNativeObs: () => Promise.reject(new Error('没有 OBS')), prepareNextNativePlayback: () => Promise.resolve(), prepareNextNativeObs: () => Promise.resolve(), cancelNativeObsPreload: () => Promise.resolve() },
    lighting: { change: () => Promise.resolve({ failed: [] }), stop: () => Promise.resolve({ failed: [] }), widen: () => undefined }
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

// 0.5.9 R9：画面那边拒绝了这一版，播放器要知道（不能一直等着回音），下一次改照常交过去。
it('画面拒绝了送去的一版：播放器听到原因、不再等它；下一次改照常交给画面', async () => {
  const camera = (sceneName: string) => ({ id: 'cam', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 2, frames: 0 },
    actions: [{ id: 'cam-scene', kind: 'obs.setProgramScene' as const, label: '切机位', sceneName }] });
  const song = (sceneName: string): LinkProject => parseLinkProject({ ...createEmptyLinkProject('画面版本'), projectId: '0f2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5f',
    playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌', cues: [camera(sceneName)], referenceAudio: { assetId: 'a', relativePath: 'a.wav', sha256: 'a'.repeat(64), durationMs: 10000 },
      playback: { startMs: 0, endMs: 9000, mtcOffsetMs: 0, volume: 80, endAction: 'pause', shortcut: '' } }] });
  let status: NativePlayerStatus | null = null;
  const prepare = (request: NativePlayerPrepare): Promise<NativePlayerStatus> => {
    const s = request.snapshot;
    status = { version: 1, sessionId: request.sessionId, generation: request.generation, itemId: s.itemId, status: 'ready', positionMs: s.positionMs,
      offsetMs: s.offsetMs, sampleRate: s.sampleRate, enginePid: 1, engineTitle: 'engine', mtcPortName: null, mtcSent: 0, audioError: null, mtcError: null,
      underruns: 0, mtcInterruptions: 0, gain: s.volume, analysis: null };
    return Promise.resolve(status);
  };
  const ready = (request: NativeObsPrepare): Promise<NativeObsStatus> => Promise.resolve({ version: 1, sessionId: request.sessionId, generation: request.generation,
    itemId: request.snapshot.item.id, revision: request.snapshot.revision, state: 'ready', reason: null, currentCueId: null, nextCueId: null, pendingCount: 0, positionMs: 0 });
  const sent: number[] = [], notices: string[] = [];
  const retargetPicture = vi.fn((request: NativeObsRetarget) => { sent.push(request.revision); if (sent.length === 1) throw new Error('这一版画面来晚了，这首歌的画面已经换了或停了，没有用上'); });
  const opened = song('机位一');
  const host = new NativeProgramHost(opened, 'C:/test/show.tblink', 1, {
    executable: 'engine.exe', audio: () => status, midiOutputs: () => Promise.resolve([]), authorize: () => Promise.resolve(), preciseSeeking: () => false,
    configuration: () => ({ outputDeviceId: 'default', audioSampleRate: 48000, mtcPortName: null, preload: false }),
    changed: state => { if (state.notice) notices.push(state.notice); }, midiChanged: () => undefined, midiRecovered: () => undefined, notice: () => undefined, closedFault: () => undefined,
    retargetPicture,
    api: { prepareNativePlayback: prepare, controlNativePlayback: request => Promise.resolve({ ...status!, generation: request.generation,
      status: request.kind === 'play' ? 'playing' : request.kind === 'stop' ? 'stopped' : status!.status }),
    getNativePlaybackDevices: () => Promise.resolve({ protocol: 4 as const, audio: [], midiOutputs: [], midiInputs: [] }),
    prepareNativeObs: ready, stopNativeObs: () => Promise.resolve(), onNativeObsStatus: () => () => undefined,
    preloadNativeObs: () => Promise.reject(new Error('没有 OBS')), prepareNextNativePlayback: () => Promise.resolve(), prepareNextNativeObs: () => Promise.resolve(), cancelNativeObsPreload: () => Promise.resolve() },
    lighting: { change: () => Promise.resolve({ failed: [] }), stop: () => Promise.resolve({ failed: [] }), widen: () => undefined }
  });
  try {
    await host.controller.play('song');
    host.controller.updateProject(song('机位二'), 2, 'C:/test/show.tblink');
    expect(sent).toEqual([2]);
    expect(notices.at(-1)).toBe('这次修改的画面没能用上，画面照原来的播：这一版画面来晚了，这首歌的画面已经换了或停了，没有用上');
    host.controller.updateProject(song('机位三'), 3, 'C:/test/show.tblink');
    expect(sent).toEqual([2, 3]);
  } finally { await host.close(); }
});

