import { describe, expect, it, vi } from 'vitest';
import { clockFromNativeStatus, createObsProgramSnapshot, frameNumberToTimecode, type LinkDesktopApi, type ProgramClock } from '@tb/core/link';
import { createEmptyLinkProject, p1FollowPictureSchema, parseLinkProject, type LinkAction, type LinkProject, type NativeObsPrepare, type NativeObsStatus, type NativePlayerStatus } from '@tb/schema';
import { NativeObsHost } from './native-obs-host';
import { NativeObsPreloadPool, ObsPreloadRefused } from './native-obs-preload';
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

/** `showProject` with two more songs of their own videos (`two`, `three`), so either can be made ready while `song`
 * plays: they share no material with it. */
function threeSongs(): LinkProject {
  const project = showProject();
  const at = (ms: number) => frameNumberToTimecode(Math.round(ms * 30 / 1000), '30');
  const song = (id: string) => ({ id, title: `歌${id}`, visualLayers: [{ id: `${id}-clips`, name: '素材' }], cues: [],
    referenceMediaClips: [{ id: `${id}-clip`, assetId: `${id}-video`, label: id, layerId: `${id}-clips`, startTimecode: at(0), durationMs: 10_000, sourceOffsetMs: 0 }],
    referenceAudio: { assetId: `${id}-audio`, relativePath: `assets/${id}.wav`, sha256: 'e'.repeat(64), durationMs: 20_000 } });
  const video = (id: string) => ({ id: `${id}-video`, name: `视频${id}`, kind: 'video' as const, folderId: null, relativePath: `assets/${id}.mp4`, sha256: 'b'.repeat(64),
    byteLength: 1, durationMs: 600_000, width: 1080, height: 1920 });
  return parseLinkProject({ ...project, mediaAssets: [...project.mediaAssets, video('two'), video('three')], rundown: [...project.rundown, song('two'), song('three')] });
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

function fixture(options: { mode?: 'manual' | 'auto'; refuse?: (action: LinkAction) => boolean; prepare?: () => Promise<void>; project?: LinkProject;
  /** Waited for before a song's outputs are made, and as a stopped song holds its last frame. */
  outputs?: () => Promise<void>; hold?: () => Promise<void>; authorize?: () => Promise<void> } = {}) {
  const project = options.project ?? showProject();
  let now = 0, audio: NativePlayerStatus | null = null;
  /** Every OBS request in order: cue actions, clip steps, seeks; `outputs` counts the outputs made for a song. */
  const sent: string[] = [], made: { request: NativeObsPrepare; music: boolean }[] = [], held: string[] = [], released: string[] = [], logs: string[] = [], programStates: NativeObsStatus[] = [];
  /** Whether each clip step and seek sent to OBS plays the clip's own sound (`SetInputMute`). */
  const sound: { clipId: string; on: boolean }[] = [];
  const outputs = (request: NativeObsPrepare): NativeObsOutputs => {
    const item = request.snapshot.item.id;
    return {
      executor: { id: 'obs', supports: () => true, execute: action => { sent.push(named(action));
        return options.refuse?.(action) ? Promise.reject(new Error('OBS 拒绝了')) : Promise.resolve(); } },
      guardOutput: <T>(_canSend: () => boolean, operation: () => Promise<T>) => operation(),
      prepareOutputs: () => options.prepare?.() ?? Promise.resolve(), preloadResources: () => Promise.resolve(), restoreScenes: () => Promise.resolve(),
      holdOutputs: async clips => { await options.hold?.(); held.push(`${item}:${clips.map(clip => clip.clipId).join(',')}`); },
      releaseOutputs: () => { released.push(item); return Promise.resolve(); },
      heldDecoders: () => new Map<string, string>(), handOver: () => Promise.resolve(),
      now: () => now, seekMedia: event => { sent.push(`seek:${event.clipId}@${Math.round(event.sourceOffsetMs / 100) * 100}`);
        sound.push({ clipId: event.clipId, on: event.embeddedAudioEnabled }); return Promise.resolve(); },
      executeManagedMediaEvent: ({ event }) => { sent.push(`media:${event.phase}:${event.clipId}`); sound.push({ clipId: event.clipId, on: event.embeddedAudioEnabled });
        return Promise.resolve(); },
      recordLog: (entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-11-12T00:00:00Z', monotonicMs: now })
    } as NativeObsOutputs;
  };
  // The one pool beside the one host, as link-main wires them: its admission refuses while anyone's picture is on.
  const pool: NativeObsPreloadPool = new NativeObsPreloadPool({
    authorize: async () => { if (audio?.status === 'playing' || host.busy) throw new ObsPreloadRefused('正在播放时不能准备另一个节目'); await host.stop(); },
    create: (request, _positionMs, music) => { made.push({ request, music }); return outputs(request); },
    report: failure => host.report(failure)
  });
  const host: NativeObsHost = new NativeObsHost({ audio: () => audio, changed: state => programStates.push(state), error: message => logs.push(`host:${message}`),
    outputs: async (request, positionMs, assertCurrent, source) => { await options.outputs?.(); return pool.take(request, positionMs, assertCurrent, source === null); },
    prepareNextFiles: async (request, assertCurrent, source) => { await pool.prepareNext(request, assertCurrent, source === null); },
    cancelNextFiles: sessionId => pool.cancelNext(sessionId) });
  const changed = vi.fn();
  const authorize = vi.fn(options.authorize ?? (() => Promise.resolve()));
  const picture = new P1PictureOutput({ host, pool, project, projectPath: 'C:/shows/p1.tblink', mode: options.mode ?? 'manual', preciseSeeking: true, authorize, changed,
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
  return { project, host, pool, picture, sent, sound, made, held, released, logs, programStates, changed, authorize, clock, play, program, programClock, programRequest, settle };
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

  it('视频自己的声音：P1 放音乐时只看片段自己的开关，和 0.5.8 一样（开着就有声，关了就没声）', async () => {
    const withSwitch = (on: boolean | undefined): LinkProject => {
      const project = showProject(), [song, ...rest] = project.rundown;
      const clip = { ...song!.referenceMediaClips[0]!, ...(on === undefined ? {} : { embeddedAudioEnabled: on }) };
      return parseLinkProject({ ...project, rundown: [{ ...song!, referenceMediaClips: [clip] }, ...rest] });
    };
    for (const [on, expected] of [[undefined, true], [true, true], [false, false]] as const) {
      const f = fixture({ project: withSwitch(on) });
      f.picture.observe(f.clock('ready', 0));
      await f.play(0, 1500);
      expect(f.sent, String(on)).toEqual(['切到机位A', 'media:start:dance']);
      expect(f.sound.length, String(on)).toBeGreaterThan(0);
      expect(f.sound, String(on)).toEqual(f.sound.map(() => ({ clipId: 'dance', on: expected })));
    }
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
    expect(f.host.status).toMatchObject({ itemId: 'song', state: 'running', generation: f.made[1]!.request.generation });
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

  it('还在准备时停下：上一首的画面还没收拾完就停，这首的画面一点不发，做出来的输出放开，这首不留最后一帧', async () => {
    const holding = gate();
    const f = fixture({ hold: holding.wait });
    f.picture.observe(f.clock('ready', 0));
    await f.play(0, 1500);
    // P1 changes song: the song before is still being put on its last frame when this one stops.
    f.picture.observe(f.clock('ready', 0, 1, NEXT)); await settle();
    const before = f.sent.length;
    await f.play(0, 300, 1, NEXT);
    f.picture.observe(f.clock('stopped', 300, 1, NEXT)); await settle();
    holding.open(); await settle();
    await f.play(350, 1500, 1, NEXT);
    expect(f.sent.slice(before)).toEqual([]);
    expect(f.made).toHaveLength(1);
    expect(f.held).toEqual(['song:dance']);
    expect(f.picture.state).toBeNull();
    expect(f.host.status).toMatchObject({ itemId: 'song', state: 'stopped', generation: f.made[0]!.request.generation });
    expect(f.logs).toEqual([]);
    // Only that song's stop cancels it: a late stop of the song before leaves the one being prepared alone.
    const later = gate();
    const g = fixture({ hold: later.wait });
    g.picture.observe(g.clock('ready', 0));
    await g.play(0, 1500);
    g.picture.observe(g.clock('ready', 0, 1, NEXT)); await settle();
    const stale = g.host.stopSource(g.picture.source, g.made[0]!.request.generation);
    later.open(); await stale;
    await g.play(0, 500, 1, NEXT);
    expect(g.host.status).toMatchObject({ state: 'running' });
    expect(g.host.status!.generation).toBeGreaterThan(g.made[0]!.request.generation);
  });

  it('还在准备时关掉跟随：输出还没做好就关，这首的画面一点不发，做出来的输出放开，什么都不留', async () => {
    const making = gate();
    const f = fixture({ outputs: making.wait });
    f.picture.observe(f.clock('ready', 0));
    await f.play(0, 300);
    const closed = f.picture.close();
    making.open(); await closed; await settle();
    expect(f.sent).toEqual([]);
    // Whatever outputs were made for it are let go (the pool's own check may stop it before any are made).
    expect(f.released).toEqual(f.made.map(entry => entry.request.snapshot.item.id));
    expect(f.held).toEqual([]);
    expect(f.picture.state).toBeNull();
    expect(f.host.status).toBeNull();
    // Stopped the same way while its outputs are made: nothing goes out, they are let go.
    const again = gate();
    const g = fixture({ outputs: again.wait });
    g.picture.observe(g.clock('ready', 0));
    await g.play(0, 300);
    g.picture.observe(g.clock('stopped', 300)); await settle();
    again.open(); await settle();
    expect([g.sent, g.held, g.released]).toEqual([[], [], g.made.map(entry => entry.request.snapshot.item.id)]);
    expect(g.picture.state).toBeNull();
    // A follow that closes while the program's picture is being prepared leaves that preparation alone.
    const programs = gate();
    const h = fixture({ outputs: programs.wait });
    h.program({ status: 'ready' });
    const prepared = h.host.prepare(h.programRequest(showProject('internal', '乙')));
    await settle();
    const gone = h.picture.close();
    programs.open(); await gone;
    await expect(prepared).resolves.toMatchObject({ sessionId: PROGRAM, state: 'ready' });
  });

  it('跟随的状态只在画面显示的东西变了才更新：一串位置不会每一步都通知', async () => {
    const f = fixture();
    const shown: string[] = [];
    f.changed.mockImplementation(() => shown.push(JSON.stringify(f.picture.state)));
    f.picture.observe(f.clock('ready', 0));
    await f.play(0, 950);
    expect(f.picture.state).toMatchObject({ itemId: 'song', state: 'running' });
    expect(shown.length).toBeGreaterThan(0);
    // Each notice shows something the one before did not.
    expect(shown.filter((entry, index) => index > 0 && entry === shown[index - 1])).toEqual([]);
    const after = shown.length;
    await f.play(1000, 1950);
    expect(shown.slice(after).filter((entry, index, all) => entry === (index > 0 ? all[index - 1] : shown[after - 1]))).toEqual([]);
  });

  it('太长的原因和出错写到跟随状态允许的长度（8192 个字）为止', async () => {
    const long = '很'.repeat(10_000);
    const f = fixture();
    f.picture.observe(f.clock('ready', 0));
    await f.play(0, 100);
    const status = f.host.status!;
    f.picture.source.changed({ ...status, reason: long, fault: long });
    expect(f.picture.state).toMatchObject({ reason: long.slice(0, 8192), fault: long.slice(0, 8192) });
    expect(() => p1FollowPictureSchema.parse(f.picture.state)).not.toThrow();
    const g = fixture({ authorize: () => Promise.reject(new Error(long)) });
    g.picture.observe(g.clock('ready', 0)); await settle();
    expect(g.picture.state).toMatchObject({ state: 'failed' });
    expect(g.picture.state!.reason!.length).toBeLessThanOrEqual(8192);
    expect(() => p1FollowPictureSchema.parse(g.picture.state)).not.toThrow();
  });

  it('界面没了：关音频引擎（closeEngine 的 nativeObs.close()）不碰跟随的画面；跟随结束才放开', async () => {
    const f = fixture();
    f.picture.observe(f.clock('ready', 0));
    await f.play(0, 1000);
    await f.host.close();
    await f.play(1050, 2500);
    expect(f.host.status).toMatchObject({ sessionId: expect.not.stringMatching(PROGRAM), itemId: 'song', state: 'running' });
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
    expect(p1.host.status).toMatchObject({ sessionId: expect.not.stringMatching(PROGRAM), itemId: 'song', state: 'running' });
    // The program's music plays: its clocks do not touch the follow's picture, which goes on.
    p1.programClock({ status: 'playing', generation: 2, positionMs: 0 });
    for (let ms = 50; ms <= 500; ms += 50) p1.programClock({ positionMs: ms });
    await p1.play(1050, 2500);
    expect(p1.host.status).toMatchObject({ sessionId: expect.not.stringMatching(PROGRAM), itemId: 'song', state: 'running' });
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

  it('提前准备（2026-11-12）：手动待命时经提前准备那一处准备好，OBS 上的画面一点不动；P1 开始放，用的就是准备好的那一份，画面按 P1 的位置接上', async () => {
    const f = fixture();
    // A song before, stopped on its last frame.
    f.picture.observe(f.clock('ready', 0));
    await f.play(0, 1500);
    f.picture.observe(f.clock('stopped', 1500)); await settle();
    const sent = f.sent.length;
    f.picture.expect('song'); await settle();
    expect(f.made.map(entry => [entry.request.snapshot.item.id, entry.music])).toEqual([['song', false], ['song', false]]);
    // Nothing reaches OBS, no session is prepared, the last frame stays.
    expect(f.sent.length).toBe(sent);
    expect(f.host.busy).toBe(false);
    expect(f.host.status).toMatchObject({ itemId: 'song', state: 'stopped', generation: f.made[0]!.request.generation });
    expect([f.held, f.released]).toEqual([['song:dance'], []]);
    expect(f.picture.state).toBeNull();
    expect(f.logs).toEqual([expect.stringMatching(/^info:「歌」的画面已提前准备好，用了 \d+ 毫秒$/)]);
    // P1 plays it; its first position reaches us at 300 ms, and the picture is up before the next one.
    f.picture.observe(f.clock('ready', 0, 1, NEXT));
    f.picture.observe(f.clock('running', 300, 1, NEXT, 'song'));
    for (let turn = 0; turn < 5; turn++) await settle();
    await f.play(350, 1500, 1, NEXT);
    // The very outputs made ready (made once), the session prepared at the head, the picture joins at P1's position.
    expect(f.made).toHaveLength(2);
    // Camera A (0–1 s, where P1 is), then the clip taken over from the last frame and started again.
    expect(f.sent.slice(sent)).toEqual(['切到机位A', 'media:stop:dance', 'media:start:dance']);
    expect(f.host.status).toMatchObject({ itemId: 'song', state: 'running' });
    expect(f.host.status?.fault ?? null).toBeNull();
    expect(f.released).toEqual(['song']);
  });

  it('提前准备：自动选歌按顺序，这首在放时下一首准备好（不加联动台的音乐）；P1 放下一首，上一首停在最后一帧，下一首用准备好的那一份', async () => {
    const f = fixture({ mode: 'auto', project: threeSongs() });
    f.picture.observe(f.clock('ready', 0)); f.picture.observe(f.clock('running', 0));
    // As P1FollowSession tells it, right after the song's start.
    f.picture.expect('two');
    await f.play(50, 1500);
    expect(f.made.map(entry => [entry.request.snapshot.item.id, entry.music])).toEqual([['song', false], ['two', false]]);
    expect(f.sent.filter(entry => entry.includes('two'))).toEqual([]);
    expect(f.logs).toEqual([]);
    // P1 plays `two` from its head: `song` stops on its last frame, `two` takes what was made ready.
    f.picture.observe(f.clock('stopped', 1500)); await settle();
    const before = f.sent.length;
    f.picture.observe(f.clock('ready', 0, 1, NEXT, 'two'));
    await f.play(0, 500, 1, NEXT, 'two');
    expect(f.made).toHaveLength(2);
    expect(f.host.status).toMatchObject({ itemId: 'two', state: 'running' });
    expect(f.held).toEqual(['song:dance']);
    expect(f.released).toEqual(['song']);
    // `two` goes on air at P1's position, and only then the last frame of `song` goes.
    expect(f.sent.slice(before)).toEqual(['seek:two-clip@0', '素材start', 'media:stop:dance']);
  });

  it('提前准备：自动选歌不按顺序，P1 放了另一首：为下一首准备的放开一次，那一首照旧开始时准备', async () => {
    const f = fixture({ mode: 'auto', project: threeSongs() });
    f.picture.observe(f.clock('ready', 0)); f.picture.observe(f.clock('running', 0));
    f.picture.expect('two');
    await f.play(50, 1500);
    f.picture.observe(f.clock('stopped', 1500)); await settle();
    f.picture.observe(f.clock('ready', 0, 1, NEXT, 'three'));
    await f.play(0, 1000, 1, NEXT, 'three');
    expect(f.made.map(entry => entry.request.snapshot.item.id)).toEqual(['song', 'two', 'three']);
    expect(f.released).toEqual(['two', 'song']);
    expect(f.host.status).toMatchObject({ itemId: 'three', state: 'running' });
    // P1 plays a song with no picture instead: what was made ready is let go all the same.
    const g = fixture({ mode: 'auto', project: threeSongs() });
    g.picture.observe(g.clock('ready', 0)); g.picture.observe(g.clock('running', 0));
    g.picture.expect('two');
    await g.play(50, 1500);
    g.picture.observe(g.clock('stopped', 1500)); await settle();
    g.picture.observe(g.clock('ready', 0, 1, NEXT, 'plain'));
    await g.play(0, 500, 1, NEXT, 'plain');
    expect(g.released).toEqual(['two', 'song']);
  });

  it('提前准备：节目的画面在用时被拒绝，不报给跟随、不标红，只记一行；节目的歌不受影响', async () => {
    const f = fixture();
    f.program({ status: 'ready' });
    await f.host.prepare(f.programRequest(showProject('internal', '乙')));
    f.programClock({ status: 'playing', generation: 1, positionMs: 0 });
    for (let ms = 50; ms <= 500; ms += 50) f.programClock({ positionMs: ms });
    await settle();
    const sent = f.sent.length;
    expect(() => f.picture.expect('song')).not.toThrow();
    await settle();
    expect(f.logs).toEqual(['info:「歌」的画面没有提前准备：正在播放时不能准备另一个节目。歌开始时再准备']);
    expect(f.picture.state).toBeNull();
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.made.map(entry => entry.music)).toEqual([true]);
    expect(f.sent.length).toBe(sent);
    expect(f.host.status).toMatchObject({ sessionId: PROGRAM, state: 'running' });
    expect(f.host.status?.fault ?? null).toBeNull();
  });

  it('提前准备：说没有了、跟随关掉，准备好的放开一次，什么都不留', async () => {
    const f = fixture();
    f.picture.expect('song'); await settle();
    f.picture.expect(null); await settle();
    expect([f.made.length, f.released]).toEqual([1, ['song']]);
    f.picture.expect('song'); await settle();
    // Told the same song again: nothing new.
    f.picture.expect('song'); await settle();
    expect(f.made).toHaveLength(2);
    await f.picture.close(); await settle();
    expect(f.released).toEqual(['song', 'song']);
    // Nothing of the follow is left: closing the pool lets nothing more go.
    await f.pool.close();
    expect(f.released).toEqual(['song', 'song']);
    // While a song is on, as its next one: let go the same way.
    const g = fixture({ project: threeSongs() });
    g.picture.observe(g.clock('ready', 0)); g.picture.observe(g.clock('running', 0));
    g.picture.expect('two');
    await g.play(50, 500);
    g.picture.expect(null); await settle();
    expect(g.released).toEqual(['two']);
    await g.picture.close(); await settle();
    await g.pool.close();
    expect(g.released).toEqual(['two', 'song']);
  });

  it('同一首歌的两遍：早一遍迟到的停止不停后一遍（画面会话整场一个，按这一遍的准备认）', async () => {
    const f = fixture();
    f.picture.observe(f.clock('ready', 0));
    await f.play(0, 1000);
    f.picture.observe(f.clock('stopped', 1000)); await settle();
    f.picture.observe(f.clock('ready', 0, 1, NEXT));
    await f.play(0, 500, 1, NEXT);
    const first = f.made[0]!.request.generation, second = f.made[1]!.request.generation;
    expect(second).toBeGreaterThan(first);
    await f.host.stopSource(f.picture.source, first);
    await f.play(550, 1000, 1, NEXT);
    expect(f.host.status).toMatchObject({ itemId: 'song', state: 'running', generation: second });
    // A late status of the earlier pass does not show on this one.
    f.picture.source.changed({ ...f.host.status!, generation: first, state: 'failed', reason: '早一遍的' });
    expect(f.picture.state).toMatchObject({ itemId: 'song', state: 'running', reason: null });
    await f.host.stopSource(f.picture.source, second);
    expect(f.host.status).toMatchObject({ state: 'stopped' });
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
