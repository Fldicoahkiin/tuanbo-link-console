import { expect, it, vi } from 'vitest';
import { createObsProgramSnapshot, type LinkDesktopApi } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type LinkAction, type NativePlayerStatus, type NativeObsPrepare } from '@tb/schema';
import { NativeObsHost } from './native-obs-host';

// setImmediate, not setTimeout: Windows timers tick about every 16 ms, and some 280 of them took a test past its 5 s limit on CI.
const tick = async (count = 6): Promise<void> => { for (let index = 0; index < count; index++) await new Promise(resolve => setImmediate(resolve)); };

/** NativeObsHost with the real picture session. Two cameras, 机位0 at 0 s and 机位1 at 1 s.
 * The owned scenes are prepared again the way preloadResources does it: the host's
 * check before and after every step, so a pause refuses the next step. */
function setup() {
  const project = parseLinkProject({ ...createEmptyLinkProject('重连'), playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '歌曲', cues: [0, 1].map(seconds => ({ id: `cue-${seconds}`, name: `机位${seconds}`,
      timecode: { hours: 0, minutes: 0, seconds, frames: 0 }, actions: [{ id: `scene-${seconds}`, kind: 'obs.setProgramScene', label: '切机位', sceneName: `机位${seconds}` }] })) }] });
  let audio: NativePlayerStatus = { version: 1, sessionId: '64f37673-7a65-4c81-b5b4-09c1b9f94cb3', generation: 1, itemId: 'song', status: 'ready',
    positionMs: 0, offsetMs: 480000, sampleRate: 48000, enginePid: 1, engineTitle: '测试', mtcPortName: null, mtcSent: 0,
    audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: 1, analysis: null };
  let now = 0, connected = true;
  const scenes: { scene: string; ok: boolean }[] = [];
  // While OBS is disconnected the request scheduler refuses every request at once.
  const execute = vi.fn<(action: LinkAction) => Promise<void>>(action => {
    scenes.push({ scene: action.kind === 'obs.setProgramScene' ? action.sceneName : action.kind, ok: connected });
    return connected ? Promise.resolve() : Promise.reject(new Error('OBS 连接已断开'));
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const restoreScenes = vi.fn(async (assertCurrent: () => void) => { assertCurrent(); await gate; assertCurrent(); });
  const request: NativeObsPrepare = { version: 1, sessionId: audio.sessionId, generation: 1, preciseSeeking: false, projectPath: 'C:/shows/test.tblink', snapshot: createObsProgramSnapshot(project, 'song', 4) };
  const host = new NativeObsHost({ audio: () => audio, changed: () => undefined, error: () => undefined,
    outputs: () => ({ executor: { id: 'test', supports: () => true, execute },
      guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(),
      prepareOutputs: () => Promise.resolve(), releaseOutputs: () => Promise.resolve(), restoreScenes,
      now: () => now, seekMedia: () => Promise.resolve(), executeManagedMediaEvent: () => Promise.resolve(),
      recordLog: (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-10-06T00:00:00Z', monotonicMs: now }) }) });
  const observe = (patch: Partial<NativePlayerStatus>, time: number): void => {
    now = time; audio = { ...audio, ...patch }; host.observe(audio, (process.hrtime.bigint() / 100n).toString());
  };
  const control = (kind: 'play' | 'pause', generation: number): void => host.interrupt({ version: 1, sessionId: audio.sessionId, generation, kind });
  /** Plays 0 → 1450 ms; OBS drops at 500 ms, so the 1 s switch to 机位1 fails in red. */
  const playIntoOutage = async (): Promise<void> => {
    await host.prepare(request);
    observe({ status: 'playing', generation: 2, positionMs: 0 }, 0); await tick();
    for (let time = 50; time <= 450; time += 50) { observe({ positionMs: time }, time); await tick(); }
    connected = false; host.disconnect('OBS 网络断开');
    for (let time = 500; time <= 1450; time += 50) { observe({ positionMs: time }, time); await tick(); }
    connected = true;
  };
  /** Resumes 1500 → 2000 ms of music, 5000 → 5500 ms later. */
  const resume = async (generation: number): Promise<void> => {
    control('play', generation);
    for (let time = 1500; time <= 2000; time += 50) { observe({ status: 'playing', generation, positionMs: time }, 5000 + time - 1500); await tick(); }
  };
  const shown = (): string | undefined => scenes.filter(entry => entry.ok && entry.scene.startsWith('机位')).at(-1)?.scene;
  return { host, observe, control, playIntoOutage, resume, release, restoreScenes, scenes, shown, fault: () => host.status?.fault };
}

it('OBS 重连时没有暂停：场景重新准备好后，补上断线期间没切成的机位', async () => {
  const test = setup();
  await test.playIntoOutage();
  expect(test.scenes.filter(entry => !entry.ok).map(entry => entry.scene)).toEqual(['机位1']);
  const reconnecting = test.host.reconnected(); await tick();
  test.observe({ positionMs: 1500 }, 1500); await tick();
  test.release(); await reconnecting; await tick();
  expect(test.shown()).toBe('机位1'); expect(test.fault()).toBe('OBS 已重新连接，画面已按当前位置恢复（1 项）');
});

it('OBS 重连后重新准备场景时按了暂停：不算恢复失败，继续时先重新准备场景，再按继续的位置补上当前机位', async () => {
  const test = setup();
  await test.playIntoOutage();
  const reconnecting = test.host.reconnected(); await tick();
  test.observe({ positionMs: 1500 }, 1500); await tick();
  test.control('pause', 3); test.observe({ status: 'paused', generation: 3, positionMs: 1500 }, 1510); await tick();
  test.release(); await reconnecting; await tick();
  expect(test.fault()).toBe('OBS 已重新连接；节目暂停了，继续播放时按当前位置恢复画面');
  await test.resume(4); await tick();
  expect(test.restoreScenes).toHaveBeenCalledTimes(2);
  expect(test.shown()).toBe('机位1'); expect(test.fault()).toBe('画面已按继续播放的位置恢复（1 项）');
  expect(test.host.status?.state).toBe('running');
});

// R7（设计 01 §4.7）：暂停中重连不再等继续，马上补回自有场景、按暂停的位置恢复画面。
it('OBS 重连恰好在按下暂停之后、音频报告暂停之前完成：马上补回场景、按暂停的位置补上当前机位，继续时不再重复', async () => {
  const test = setup();
  await test.playIntoOutage();
  test.observe({ positionMs: 1500 }, 1500); await tick();
  test.control('pause', 3);
  const reconnecting = test.host.reconnected(); await tick();
  test.observe({ status: 'paused', generation: 3, positionMs: 1500 }, 1510); await tick();
  test.release(); await reconnecting; await tick();
  expect(test.fault()).toBe('OBS 已重新连接，画面已按当前位置恢复（1 项）');
  expect(test.restoreScenes).toHaveBeenCalledOnce(); expect(test.shown()).toBe('机位1');
  await test.resume(4); await tick();
  expect(test.restoreScenes).toHaveBeenCalledOnce();
  expect(test.shown()).toBe('机位1'); expect(test.fault()).toBe('OBS 已重新连接，画面已按当前位置恢复（1 项）');
  expect(test.host.status?.state).toBe('running');
});
