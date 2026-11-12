import { describe, expect, it, vi } from 'vitest';
import { clockFromNativeStatus, createObsProgramSnapshot, frameNumberToTimecode, type LinkDesktopApi, type ProgramClock } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type LinkAction, type LinkProject, type NativeObsPrepare, type NativeObsStatus, type NativePlayerStatus } from '@tb/schema';
import { NativeObsHost } from './native-obs-host';
import { pictureReadBack, type NativeObsOutputs } from './native-obs-outputs';
import { P1PictureOutput } from './p1-picture-output';

/*
 * The picture of a P1 follow on the one picture host (0.5.9): the real NativeObsHost and ObsProgramSession, fake OBS
 * outputs that write down every request, and P1's clocks as P1FollowSession sends them.
 */

const P1 = '0f6a4c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
const NEXT = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const PROGRAM = '64f37673-7a65-4c81-b5b4-09c1b9f94cb3';

/** Camera A 0–1 s and B 2–3 s on the top track (B with a filter, a point action at 2 s), a video under them for 10 s. */
function showProject(playbackSource: 'p1' | 'internal' = 'p1', name = 'P1 画面'): LinkProject {
  const at = (ms: number) => frameNumberToTimecode(Math.round(ms * 30 / 1000), '30');
  const camera = (id: string, fromMs: number, extra: LinkAction[] = []) => ({ id, name: id, layerId: 'cams', timecode: at(fromMs), durationMs: 1000,
    actions: [{ id: `${id}-scene`, kind: 'obs.setProgramScene' as const, label: '切机位', sceneName: `机位${id}` }, ...extra] });
  return parseLinkProject({ ...createEmptyLinkProject(name), playbackSource, obsOutputMode: 'scenes',
    mediaAssets: [{ id: 'video', name: '舞蹈', kind: 'video', folderId: null, relativePath: 'assets/dance.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 600_000, width: 1080, height: 1920 }],
    rundown: [{ id: 'song', title: '歌', visualLayers: [{ id: 'cams', name: '机位' }, { id: 'clips', name: '素材' }],
      cues: [camera('A', 0), camera('B', 2000, [{ id: 'B-filter', kind: 'obs.setSourceFilterEnabled', label: '滤镜', sourceName: '机位B', filterName: '调色', enabled: true }])],
      referenceMediaClips: [{ id: 'dance', assetId: 'video', label: '舞蹈', layerId: 'clips', startTimecode: at(0), durationMs: 10_000, sourceOffsetMs: 0 }],
      referenceAudio: { assetId: 'song-audio', relativePath: 'assets/song.wav', sha256: 'e'.repeat(64), durationMs: 20_000 } },
    { id: 'plain', title: '没有画面', cues: [], referenceAudio: { assetId: 'plain-audio', relativePath: 'assets/plain.wav', sha256: 'f'.repeat(64), durationMs: 20_000 } }] });
}

/** One OBS request as the tests compare them. */
function named(action: LinkAction): string {
  switch (action.kind) {
    case 'obs.setProgramScene': return `切到${action.sceneName}`;
    case 'obs.setSourceFilterEnabled': return `滤镜${action.filterName}`;
    case 'obs.mediaAction': return `素材${action.action}`;
    default: return action.kind;
  }
}

/** Lets the host's and the session's queued steps run (everything they wait for is a resolved promise here). */
async function settle(): Promise<void> { for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve)); }

function fixture(options: { mode?: 'manual' | 'auto'; refuse?: (action: LinkAction) => boolean; prepare?: () => Promise<void>; project?: LinkProject } = {}) {
  const project = options.project ?? showProject();
  let now = 0, audio: NativePlayerStatus | null = null;
  /** Every OBS request in order: cue actions, clip steps, seeks; `outputs` counts the outputs made for a song. */
  const sent: string[] = [], made: { request: NativeObsPrepare; music: boolean }[] = [], held: string[] = [], released: string[] = [], logs: string[] = [], programStates: NativeObsStatus[] = [];
  const outputs = (request: NativeObsPrepare, music: boolean): NativeObsOutputs => {
    const item = request.snapshot.item.id;
    return {
      executor: { id: 'obs', supports: () => true, execute: action => { sent.push(named(action));
        return options.refuse?.(action) ? Promise.reject(new Error('OBS 拒绝了')) : Promise.resolve(); } },
      guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(),
      prepareOutputs: () => options.prepare?.() ?? Promise.resolve(), preloadResources: () => Promise.resolve(), restoreScenes: () => Promise.resolve(),
      holdOutputs: clips => { held.push(`${item}:${clips.map(clip => clip.clipId).join(',')}`); return Promise.resolve(); },
      releaseOutputs: () => { released.push(item); return Promise.resolve(); },
      heldDecoders: () => new Map<string, string>(), handOver: () => Promise.resolve(),
      now: () => now, seekMedia: event => { sent.push(`seek:${event.clipId}@${Math.round(event.sourceOffsetMs / 100) * 100}`); return Promise.resolve(); },
      executeManagedMediaEvent: ({ event }) => { sent.push(`media:${event.phase}:${event.clipId}`); return Promise.resolve(); },
      recordLog: (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-12T00:00:00Z', monotonicMs: now })
    } as NativeObsOutputs;
  };
  const host = new NativeObsHost({ audio: () => audio, changed: state => programStates.push(state), error: message => logs.push(`host:${message}`),
    outputs: (request, _positionMs, _assertCurrent, source) => { made.push({ request, music: source === null }); return outputs(request, source === null); } });
  const changed = vi.fn();
  const authorize = vi.fn(() => Promise.resolve());
  const picture = new P1PictureOutput({ host, project, projectPath: 'C:/shows/p1.tblink', mode: options.mode ?? 'manual', preciseSeeking: true, authorize, changed,
    log: (level, message) => logs.push(`${level}:${message}`) });
  /** P1's clock of `itemId`, as P1FollowSession sends it; `positionMs` is also the time on the outputs' clock. */
  const clock = (state: ProgramClock['state'], positionMs: number, generation = 1, sessionId = P1, itemId = 'song'): ProgramClock => {
    if (state === 'running') now = positionMs;
    return { source: 'p1', sessionId, generation, itemId, state, positionMs, observedAtMs: state === 'running' ? Number(process.hrtime.bigint()) / 1e6 : null, reason: null };
  };
  /** P1 plays on from `fromMs` to `toMs` (inclusive), a position every 50 ms. */
  const play = async (fromMs: number, toMs: number, generation = 1, sessionId = P1, itemId = 'song'): Promise<void> => {
    for (let ms = fromMs; ms <= toMs; ms += 50) { picture.observe(clock('running', ms, generation, sessionId, itemId)); await settle(); }
  };
  /** The internal player's song (another project's program), for the one host. */
  const program = (patch: Partial<NativePlayerStatus>): NativePlayerStatus => {
    audio = { version: 1, sessionId: PROGRAM, generation: 1, itemId: 'song', status: 'ready', positionMs: 0, offsetMs: 0, sampleRate: 48000, enginePid: 1, engineTitle: '测试',
      mtcPortName: null, mtcSent: 0, audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: 1, analysis: null, ...audio, ...patch };
    return audio;
  };
  const programClock = (patch: Partial<NativePlayerStatus>) => { const status = program(patch); now = status.positionMs; host.observe(clockFromNativeStatus(status, String(Math.round(Number(process.hrtime.bigint()) / 100)))); };
  const programRequest = (programProject: LinkProject): NativeObsPrepare => ({ version: 1, sessionId: PROGRAM, generation: 1, preciseSeeking: false, projectPath: 'C:/shows/program.tblink',
    snapshot: createObsProgramSnapshot(programProject, 'song', 1) });
  return { project, host, picture, sent, made, held, released, logs, programStates, changed, authorize, clock, play, program, programClock, programRequest, settle };
}

/** A gate a preparation waits at until the test opens it. */
function gate() {
  let open: () => void = () => undefined;
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { wait: () => wait, open: () => open() };
}

describe('跟随 P1 时的画面：同一个画面宿主（0.5.9）', () => {
  it('开始跟歌：不等画面；画面准备好了按 P1 那时的位置接上，过去的不补；晚到不标红，OBS 不加联动台的音乐', async () => {
    const preparing = gate();
    const f = fixture({ prepare: preparing.wait });
    f.picture.observe(f.clock('ready', 0));
    // P1 plays on while the picture is prepared: nothing waits for it, nothing of it goes out yet.
    await f.play(0, 1500);
    expect(f.picture.state).toMatchObject({ itemId: 'song', state: 'preparing' });
    expect(f.sent).toEqual([]);
    preparing.open(); await settle();
    await f.play(1550, 2500);
    // Where P1 was once it was ready (1.5 s: the video, no camera), not camera A at 0 s; then on as the timeline goes.
    expect(f.sent).toEqual(['seek:dance@1500', '素材start', '滤镜调色', '切到机位B']);
    expect(f.picture.state).toMatchObject({ itemId: 'song', state: 'running', fault: null, reason: null });
    expect(f.logs).toEqual([]);
    expect(f.made.map(entry => entry.music)).toEqual([false]);
    expect(f.authorize).toHaveBeenCalledOnce();
  });

  it('冻结：手动模式素材照放、点动作和机位停在原地；自动选歌素材暂停；两种都不补发', async () => {
    const run = async (mode: 'manual' | 'auto') => {
      const f = fixture({ mode });
      f.picture.observe(f.clock('ready', 0));
      await f.play(0, 1500);
      const before = f.sent.length;
      f.picture.hold(); await settle();
      // Positions that still come (P1FollowSession sends none while frozen) do not move the picture either.
      await f.play(1550, 2500);
      return { f, after: f.sent.slice(before) };
    };
    const manual = await run('manual');
    expect(manual.after).toEqual([]);
    expect(manual.f.picture.state).toMatchObject({ state: 'running' });
    const auto = await run('auto');
    expect(auto.after).toEqual(['素材pause']);
    expect(auto.f.picture.state).toMatchObject({ state: 'paused' });
  });

  it('接着跟：自动选歌同位置继续，素材接着放、这一遍发过的不重发；手动重新同步，按这个位置对一次，过去的点动作不补', async () => {
    const auto = fixture({ mode: 'auto' });
    auto.picture.observe(auto.clock('ready', 0));
    await auto.play(0, 1500);
    auto.picture.hold(); await settle();
    const paused = auto.sent.length;
    auto.picture.reconcileAt(auto.clock('running', 1500, 2), true); await settle();
    await auto.play(1550, 2500, 2);
    expect(auto.sent.slice(paused)).toEqual(['素材start', '滤镜调色', '切到机位B']);
    expect(auto.made).toHaveLength(1);

    const manual = fixture({ mode: 'manual' });
    manual.picture.observe(manual.clock('ready', 0));
    await manual.play(0, 1500);
    manual.picture.hold(); await settle();
    const frozen = manual.sent.length;
    // P1 went on meanwhile, past camera B's filter at 2 s; the operator resyncs at 2.6 s.
    manual.picture.reconcileAt(manual.clock('running', 2600, 2), false); await settle();
    await manual.play(2650, 3500, 2);
    // The pass before stops on its frame (the video paused); this one places camera B of 2.6 s (once as prepared there, once
    // as it joins where P1 is then: the late rejoin of the program's picture), never B's filter of 2 s; the video, under
    // B, goes off and back on at 3 s.
    expect(manual.sent.slice(frozen)).toEqual(['素材pause', '切到机位B', '切到机位B', 'media:stop:dance', 'media:start:dance']);
    expect(manual.made).toHaveLength(2);
    // The frame of the pass before stayed until this one's picture was on, then went.
    expect([manual.held, manual.released]).toEqual([['song:dance'], ['song']]);
  });

  it('停下和换歌：上一首留在最后一帧，下一首的画面上了才撤；跟随关掉时放开，和关掉节目一样', async () => {
    const f = fixture();
    f.picture.observe(f.clock('ready', 0));
    await f.play(0, 1500);
    f.picture.observe(f.clock('stopped', 1500)); await settle();
    expect([f.held, f.released]).toEqual([['song:dance'], []]);
    expect(f.picture.state).toBeNull();
    expect(f.host.status).toMatchObject({ state: 'stopped' });
    // The next song: its picture prepared, then on with P1's first position; only then the last frame goes.
    f.picture.observe(f.clock('ready', 0, 1, NEXT)); await settle();
    expect(f.released).toEqual([]);
    await f.play(0, 500, 1, NEXT);
    expect(f.released).toEqual(['song']);
    expect(f.host.status).toMatchObject({ sessionId: NEXT, state: 'running' });
    // P1 changes to a song without a picture: the last frame stays until P1 plays it, then goes.
    f.picture.observe(f.clock('stopped', 500, 1, NEXT)); await settle();
    const plain = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
    f.picture.observe(f.clock('ready', 0, 1, plain, 'plain')); await settle();
    expect(f.released).toEqual(['song']);
    await f.play(0, 100, 1, plain, 'plain');
    expect(f.released).toEqual(['song', 'song']);
    // A song without picture work prepares nothing, and that is not a failure.
    expect(f.made).toHaveLength(2);
    expect(f.picture.state).toBeNull();
    expect(f.logs).toEqual([]);
    // Stopped once more on a frame, then the follow closes: released.
    f.picture.observe(f.clock('ready', 0, 1, P1)); await f.play(0, 1500);
    f.picture.observe(f.clock('stopped', 1500)); await settle();
    expect(f.held.at(-1)).toBe('song:dance');
    await f.picture.close();
    expect(f.released).toEqual(['song', 'song', 'song']);
  });

  it('界面没了：关音频引擎（closeEngine 的 nativeObs.close()）不碰跟随的画面；跟随结束才放开', async () => {
    const f = fixture();
    f.picture.observe(f.clock('ready', 0));
    await f.play(0, 1000);
    await f.host.close();
    await f.play(1050, 2500);
    expect(f.host.status).toMatchObject({ sessionId: P1, state: 'running' });
    expect(f.sent.at(-1)).toBe('切到机位B');
    expect([f.held, f.released]).toEqual([[], []]);
    await f.picture.close();
    expect(f.host.status).toMatchObject({ state: 'stopped' });
    expect([f.held, f.released]).toEqual([['song:dance'], ['song']]);
  });

  it('跨工程：画面同一时间只归一家，后来的那一家被拒绝并写明原因，正在用的画面不被抢走', async () => {
    // A follow that runs on (another project) has the picture; the window plays a program of project 乙.
    const p1 = fixture();
    p1.picture.observe(p1.clock('ready', 0));
    await p1.play(0, 1000);
    const program = showProject('internal', '乙');
    p1.program({ status: 'ready' });
    await expect(p1.host.prepare(p1.programRequest(program))).rejects.toThrow('OBS 的画面正在跟随 P1（工程「P1 画面」），这首歌不联动画面，音乐和时间码照常');
    // Its stop of the picture it never got stops nothing of the follow's.
    await expect(p1.host.stopOwned({ version: 1, sessionId: PROGRAM, generation: 1 })).resolves.toBeUndefined();
    expect(p1.host.status).toMatchObject({ sessionId: P1, state: 'running' });
    // The program's music plays: its clocks do not touch the follow's picture, which goes on.
    p1.programClock({ status: 'playing', generation: 2, positionMs: 0 });
    for (let ms = 50; ms <= 500; ms += 50) p1.programClock({ positionMs: ms });
    await p1.play(1050, 2500);
    expect(p1.host.status).toMatchObject({ sessionId: P1, state: 'running' });
    expect(p1.sent.at(-1)).toBe('切到机位B');
    expect(p1.made.map(entry => entry.music)).toEqual([false]);

    // The other way round: the program has the picture, P1 starts a song of a follow.
    const f = fixture();
    f.program({ status: 'ready' });
    await f.host.prepare(f.programRequest(showProject('internal', '乙')));
    f.programClock({ status: 'playing', generation: 1, positionMs: 0 });
    for (let ms = 50; ms <= 500; ms += 50) f.programClock({ positionMs: ms });
    await settle();
    f.picture.observe(f.clock('ready', 0));
    await f.play(0, 2500);
    expect(f.picture.state).toMatchObject({ itemId: 'song', state: 'failed', reason: 'OBS 的画面正在给联动台播放的节目用，跟随 P1 的这首歌不联动画面，动作 MIDI 和灯光照常。节目停下以后，P1 下一首歌就有画面' });
    expect(f.host.status).toMatchObject({ sessionId: PROGRAM, state: 'running' });
    expect(f.made.map(entry => entry.music)).toEqual([true]);
    expect(f.logs).toEqual([expect.stringContaining('跟随 P1 时这首歌的画面没有准备好，音乐、动作 MIDI 和灯光照常：OBS 的画面正在给联动台播放的节目用')]);
  });

  it('P1 放的音乐不经联动台的音乐项：读回不找它（上一首留下的也不算），节目的照旧找', async () => {
    const reading = { kind: 'read' as const, programScene: '机位A', transitioning: false, decoders: [], music: { kind: 'missing' as const } };
    const obs = { readPicture: () => Promise.resolve(reading) };
    const decoders = { onAirSource: () => null };
    const request = { decoders: [] };
    await expect(pictureReadBack(obs, decoders, false)(request)).resolves.toEqual({ ...reading, music: { kind: 'not-used' } });
    await expect(pictureReadBack(obs, decoders)(request)).resolves.toEqual(reading);
  });
});
