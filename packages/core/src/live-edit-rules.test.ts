import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, lightingDocumentSchema, lightingMa2BindingSchema, lightingTrackSchema, parseLinkProject,
  type LightingDocument, type LinkAction, type LinkProject, type NativeObsNext, type NativeObsPrepare, type NativeObsStatus, type NativePlayerControl, type NativePlayerNext,
  type NativePlayerPrepare, type NativePlayerStatus, type RundownItem } from '@tb/schema';
import { emptyInternalPlayerState, type InternalPlayerDependencies, type InternalPlayerState, type LitSong, type ProgramLightingOutput,
  type ProgramPictureOutput } from './program-player';
import { NativeProgramPlayer } from './native-program-player';
import { MidiProgramSession, type MidiProgramDependencies } from './midi-program';
import { frameNumberToTimecode } from './mtc-timecode';
import { nextAudioIdentity, nextPictureIdentity } from './next-song-identity';
import { LightingOffLedger, litReleaseActions } from './lighting-off-ledger';
import { songStructureChanges } from './live-revision-effect';
import { showGate, type ShowState } from './show-state';

/**
 * 0.5.9 S8a（design 02 §3.5）：拿着歌时改工程。在播的歌的音频、时间码和画面一直跟它开始的那一版；
 * 它保存的音量、它自己的“播完后”和它的灯光可能用到的执行器当即生效，别的等下一首（下一首放最新的一版）。
 * S8b：下一首改了就重新准备（不碰在播的歌）；在播的歌的动作 MIDI 从播放头往后跟新的一版。
 * A change that breaks one of these fails here.
 */

const SHA = 'a'.repeat(64);
const off = (executor: string) => ({ target: 'executor', executor, action: 'off' }) as const;
function lighting(executors: string[]): LightingDocument {
  const track = (index: number) => lightingTrackSchema.parse({ id: `track-${index}`, name: `Track ${index}`, kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false,
    locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [] });
  const binding = lightingMa2BindingSchema.parse({ id: 'binding', timecode: 1, name: '歌曲', readAt: '2026-11-11T00:00:00.000Z', sourceXml: '<MA/>',
    baselineTracks: executors.map((_executor, index) => track(index)), mappings: [],
    trackMappings: executors.map((executor, index) => ({ trackId: `track-${index}`, path: `Track ${index}`, executor, subtracks: [] })) });
  return lightingDocumentSchema.parse({ ...createLightingDocument(), ma2Bindings: [binding] });
}
function song(id: string, mtcOffsetMs: number, patch: Record<string, unknown> = {}) {
  return { id, title: `歌曲${id}`, referenceAudio: { assetId: id, relativePath: `${id}.wav`, sha256: SHA, durationMs: 10_000 },
    playback: { volume: 80, startMs: 0, endMs: 0, mtcOffsetMs, shortcut: '', endAction: 'next' }, ...patch };
}
function project(patch: (items: ReturnType<typeof song>[]) => ReturnType<typeof song>[] = items => items): LinkProject {
  const rundown = patch([song('甲', 3_600_000), song('乙', 3_700_000), song('丙', 3_800_000)]);
  return parseLinkProject({ ...createEmptyLinkProject('拿着歌时改'), playbackSource: 'internal', rundown,
    ...rundown.some(item => 'lighting' in item) ? { schemaVersion: 2 } : {} });
}
/** The newer version: `item` in place of the song with its id; every other song is the same object (shareProjectStructure). */
function edited(from: LinkProject, itemId: string, change: (item: RundownItem) => RundownItem | null): LinkProject {
  return { ...from, rundown: from.rundown.flatMap(item => item.id !== itemId ? [item] : (change(item) ? [change(item)!] : [])) };
}
const withPlayback = (patch: Partial<NonNullable<RundownItem['playback']>>) => (item: RundownItem): RundownItem => ({ ...item, playback: { ...item.playback!, ...patch } });

/** A program over a fake audio engine and picture host; `lighting` records what the lights-off ledger is told.
 * `runtime`: the action MIDI side of the host (prepare, pause, stop, retargetActions), when a test needs it. */
function program(opened: LinkProject, runtime: Partial<InternalPlayerDependencies> = {}, picture?: ProgramPictureOutput) {
  let status: NativePlayerStatus | null = null, listener: ((value: NativePlayerStatus) => void) | null = null;
  let pictureListener: ((value: NativeObsStatus) => void) | null = null;
  let state: InternalPlayerState = { ...emptyInternalPlayerState };
  const emit = (patch: Partial<NativePlayerStatus>): NativePlayerStatus => { status = { ...status!, ...patch }; listener?.(status); return status; };
  const api = {
    preloadNativeObs: vi.fn(() => Promise.resolve()), prepareNextNativePlayback: vi.fn<(request: NativePlayerNext) => Promise<void>>(() => Promise.resolve()),
    prepareNextNativeObs: vi.fn<(request: NativeObsNext) => Promise<void>>(() => Promise.resolve()), cancelNativeObsPreload: vi.fn(() => Promise.resolve()),
    onNativeObsStatus: (receive: (value: NativeObsStatus) => void) => { pictureListener = receive; return () => { pictureListener = null; }; }, stopNativeObs: vi.fn(() => Promise.resolve()),
    prepareNativeObs: vi.fn((request: NativeObsPrepare): Promise<NativeObsStatus> => Promise.resolve({ version: 1, sessionId: request.sessionId,
      generation: request.generation, itemId: request.snapshot.item.id, revision: request.snapshot.revision, state: 'ready', reason: null,
      currentCueId: null, nextCueId: null, pendingCount: 0, positionMs: 0 })),
    onNativePlaybackStatus: (receive: (value: NativePlayerStatus) => void) => { listener = receive; return () => { listener = null; }; },
    getNativePlaybackDevices: () => Promise.resolve({ protocol: 4 as const, audio: [], midiOutputs: [], midiInputs: [] }),
    prepareNativePlayback: vi.fn((request: NativePlayerPrepare): Promise<NativePlayerStatus> => {
      const s = request.snapshot;
      status = { version: 1, sessionId: request.sessionId, generation: request.generation, itemId: s.itemId, status: 'ready', positionMs: s.positionMs,
        offsetMs: s.offsetMs, sampleRate: s.sampleRate, enginePid: 1, engineTitle: 'TBLINK Audio 1', mtcPortName: null, mtcSent: 0,
        audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: s.volume, analysis: null };
      return Promise.resolve(emit({}));
    }),
    controlNativePlayback: vi.fn((command: NativePlayerControl): Promise<NativePlayerStatus> => {
      const patch: Partial<NativePlayerStatus> = { generation: command.generation };
      switch (command.kind) {
        case 'play': patch.status = 'playing'; break;
        case 'pause': patch.status = 'paused'; break;
        case 'seek': patch.status = 'paused'; patch.positionMs = command.positionMs; break;
        case 'stop': patch.status = 'stopped'; break;
        case 'stop-mtc': break;
        case 'volume': patch.gain = command.volume; break;
      }
      return Promise.resolve(emit(patch));
    })
  };
  const notice = vi.fn<(message: string, itemId: string | null) => void>();
  const actions = { prepare: vi.fn<InternalPlayerDependencies['prepare']>(() => Promise.resolve()), stop: vi.fn<InternalPlayerDependencies['stop']>(() => Promise.resolve()),
    pause: vi.fn<InternalPlayerDependencies['pause']>(() => Promise.resolve()) };
  const dependencies = { ...actions, ingest: () => Promise.resolve(),
    resolveAudio: () => Promise.resolve('unused'), configuration: () => ({ outputDeviceId: 'default', mtcPortName: null, audioSampleRate: 48000 as const }),
    changed: (next: InternalPlayerState) => { state = next; }, notice, closedFault: vi.fn(), ...runtime };
  const output = {
    change: vi.fn<ProgramLightingOutput['change']>(() => Promise.resolve({ failed: [] })),
    stop: vi.fn<ProgramLightingOutput['stop']>(() => Promise.resolve({ failed: [] })),
    widen: vi.fn<ProgramLightingOutput['widen']>()
  };
  const player = new NativeProgramPlayer(opened, 'C:/show/拿着歌时改.tblink', 1, dependencies, api, output, picture);
  /** The picture session of the song's last preparation reports a status (R9's side, ProgramPictureOutput). */
  const pictureStatus = (patch: Partial<NativeObsStatus>): void => {
    const request = api.prepareNativeObs.mock.lastCall![0];
    pictureListener?.({ version: 1, sessionId: request.sessionId, generation: request.generation, itemId: request.snapshot.item.id,
      revision: request.snapshot.revision, state: 'running', reason: null, currentCueId: null, nextCueId: null, pendingCount: 0, positionMs: 0, ...patch });
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  /** What the engine plays at now, 0–100. */
  const gain = async (): Promise<number> => { await settle(); return Math.round((status?.gain ?? Number.NaN) * 100); };
  /** The engine played the song to its end. */
  const ended = async (): Promise<void> => { emit({ status: 'ended' }); await settle(); await settle(); };
  return { player, api, gain, ended, settle, emit, notice, lighting: output, state: () => state, runtime: actions, pictureStatus };
}

describe('音量：在播的歌保存的音量改了当即生效', () => {
  it('新的一版改了它的音量：输出马上到新的音量；只改别的歌、改名不动输出', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    expect(await f.gain()).toBe(80);
    const v2 = edited(v1, '甲', withPlayback({ volume: 50 }));
    f.player.updateProject(v2, 2, 'C:/show/拿着歌时改.tblink');
    expect(await f.gain()).toBe(50);
    expect(f.state().volume).toBe(50);
    const sent = f.api.controlNativePlayback.mock.calls.length;
    f.player.updateProject(edited(v2, '乙', withPlayback({ volume: 10 })), 3, 'C:/show/拿着歌时改.tblink');
    f.player.updateProject(edited(v2, '甲', item => ({ ...item, title: '改名' })), 4, 'C:/show/拿着歌时改.tblink');
    expect(await f.gain()).toBe(50);
    expect(f.api.controlNativePlayback.mock.calls.length).toBe(sent);
  });

  it('有 CC7 临时音量时：只记下保存的音量，不动输出；之后拖播放条以后是播放条的', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    f.player.overrideVolume(30);
    expect(await f.gain()).toBe(30);
    f.player.updateProject(edited(v1, '甲', withPlayback({ volume: 60 })), 2, 'C:/show/拿着歌时改.tblink');
    expect(await f.gain()).toBe(30);
    expect(f.state()).toMatchObject({ volume: 30, volumeOverride: 30 });
  });

  it('保存的音量只随版本来：撤销回去也是新的一版，输出跟着它，不留着之前的值', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    f.player.updateProject(edited(v1, '甲', withPlayback({ volume: 50 })), 2, 'C:/show/拿着歌时改.tblink');
    expect(await f.gain()).toBe(50);
    // Undo: the version before arrives again, and it alone puts the output back.
    f.player.updateProject(v1, 3, 'C:/show/拿着歌时改.tblink');
    expect(await f.gain()).toBe(80);
    expect(f.state().volume).toBe(80);
  });
});

describe('播完后：它自己的“播完后”当即生效，别的修改不冲掉播放条上的选择', () => {
  it('改它自己的播完后：这一遍就按新的；改别的、删掉它自己的回到播放条上的', async () => {
    const v1 = project(), f = program(v1);
    f.player.setEndAction('pause');
    await f.player.play('甲');
    expect(f.state()).toMatchObject({ endAction: 'next', defaultEndAction: 'pause' });
    const v2 = edited(v1, '甲', withPlayback({ endAction: 'loop' }));
    f.player.updateProject(v2, 2, 'C:/show/拿着歌时改.tblink');
    expect(f.state().endAction).toBe('loop');
    // The operator picks on the player bar during the song: an unrelated version leaves it.
    f.player.setEndAction('stop');
    f.player.updateProject(edited(v2, '乙', item => ({ ...item, title: '别的歌' })), 3, 'C:/show/拿着歌时改.tblink');
    f.player.updateProject(edited(v2, '甲', item => ({ ...item, notes: '只改备注' })), 4, 'C:/show/拿着歌时改.tblink');
    expect(f.state()).toMatchObject({ endAction: 'stop', defaultEndAction: 'stop' });
    const own = v2.rundown[0]!.playback!;
    const { endAction, ...rest } = own; void endAction;
    f.player.updateProject(edited(v2, '甲', item => ({ ...item, playback: { ...rest } as NonNullable<RundownItem['playback']> })), 5, 'C:/show/拿着歌时改.tblink');
    expect(f.state().endAction).toBe('stop');
  });
});

describe('它自己的播完后改了以后：定位、循环回来都还是改过的', () => {
  it('改成“停”以后定位：还是停', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    f.player.updateProject(edited(v1, '甲', withPlayback({ endAction: 'stop' })), 2, 'C:/show/拿着歌时改.tblink');
    expect(f.state().endAction).toBe('stop');
    await f.player.seek(2000);
    expect(f.state().endAction).toBe('stop');
    expect(f.api.prepareNativePlayback.mock.lastCall![0].nextSnapshot).toBeUndefined();
  });

  it('改成“循环”：播完回到开头，再播完还循环', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    f.player.updateProject(edited(v1, '甲', withPlayback({ endAction: 'loop' })), 2, 'C:/show/拿着歌时改.tblink');
    await f.ended();
    expect(f.state()).toMatchObject({ status: 'playing', itemId: '甲', endAction: 'loop' });
    expect(f.api.prepareNativePlayback.mock.lastCall![0].snapshot).toMatchObject({ itemId: '甲', revision: 1 });
    await f.ended();
    expect(f.state()).toMatchObject({ status: 'playing', itemId: '甲', endAction: 'loop' });
  });
});

describe('音频本身：仓库在界面拦住；就算送到主进程，也不碰音频和 MTC 起始码', () => {
  it('界面：在台上的歌改音频本身、删掉、停用都要等它停下（showGate）；别的歌不等', () => {
    const v1 = project(), onStage: ShowState = { phase: 'running', source: 'internal', program: null, itemId: '甲' };
    const gate = (next: LinkProject) => {
      const changes = songStructureChanges(v1, next);
      return [...changes.removed.map(id => showGate('song.remove', onStage, id)), ...changes.audio.map(id => showGate('song.audio.edit', onStage, id))]
        .find(entry => entry.kind === 'wait') ?? { kind: 'allow' };
    };
    expect(gate(edited(v1, '甲', withPlayback({ startMs: 1000 })))).toMatchObject({ kind: 'wait', message: '演出还没停止，这首歌还在台上，停下它以后再换音频、修剪音频、加空白或改 MTC 起始码。' });
    expect(gate(edited(v1, '甲', withPlayback({ mtcOffsetMs: 3_610_000 })))).toMatchObject({ kind: 'wait' });
    expect(gate(edited(v1, '甲', () => null))).toMatchObject({ kind: 'wait', message: '演出还没停止，这首歌还在台上，停下它以后再删除或停用这首歌。' });
    expect(gate(edited(v1, '甲', item => ({ ...item, enabled: false })))).toMatchObject({ kind: 'wait' });
    expect(gate(edited(v1, '乙', withPlayback({ startMs: 1000 })))).toEqual({ kind: 'allow' });
    expect(gate(edited(v1, '甲', withPlayback({ volume: 20 })))).toEqual({ kind: 'allow' });
  });

  it('主进程收到改了音频的一版：不重新准备、不发命令，只写日志；之后定位还按开始那一版的起始码和范围', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    const prepared = f.api.prepareNativePlayback.mock.calls.length, sent = f.api.controlNativePlayback.mock.calls.length;
    f.player.updateProject(edited(v1, '甲', withPlayback({ startMs: 2000, mtcOffsetMs: 3_610_000 })), 2, 'C:/show/拿着歌时改.tblink');
    await f.settle();
    expect(f.api.prepareNativePlayback.mock.calls.length).toBe(prepared);
    expect(f.api.controlNativePlayback.mock.calls.length).toBe(sent);
    expect(f.notice).toHaveBeenCalledWith('这次修改改了正在播的「歌曲甲」的音频或时间码，这首歌照原样播完，停下重播才生效', '甲');
    await f.player.seek(4000);
    expect(f.api.prepareNativePlayback.mock.lastCall![0].snapshot).toMatchObject({ itemId: '甲', revision: 1, startMs: 0, offsetMs: 3_600_000, positionMs: 4000 });
  });
});

describe('定位和画面恢复跟开始那一版', () => {
  it('改了以后定位、拖动：音频、画面都按开始那一版准备；停下再播才是新的一版', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    const v2 = edited(v1, '甲', item => ({ ...item, title: '新名字', notes: '新的画面说明' }));
    f.player.updateProject(v2, 2, 'C:/show/拿着歌时改.tblink');
    expect(f.player.currentProject()).toBe(v1);
    await f.player.seek(3000);
    expect(f.api.prepareNativePlayback.mock.lastCall![0].snapshot).toMatchObject({ revision: 1 });
    expect(f.api.prepareNativeObs.mock.lastCall![0].snapshot).toMatchObject({ revision: 1, item: { id: '甲', title: '歌曲甲' } });
    await f.player.scrub('甲', 5000);
    expect(f.api.prepareNativeObs.mock.lastCall![0].snapshot).toMatchObject({ revision: 1, item: { title: '歌曲甲' } });
    await f.player.stop();
    expect(f.player.currentProject()).toBe(v2);
    await f.player.play('甲');
    expect(f.api.prepareNativeObs.mock.lastCall![0].snapshot).toMatchObject({ revision: 2, item: { title: '新名字' } });
  });
});

describe('下一首按最新的一版找', () => {
  it('下一首被删掉：播完不报错，接着最新一版里的下一首，用最新的一版开始', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    const v2 = edited(v1, '乙', () => null);
    f.player.updateProject(v2, 2, 'C:/show/拿着歌时改.tblink');
    await f.ended();
    expect(f.state()).toMatchObject({ status: 'playing', itemId: '丙', error: null });
    expect(f.api.prepareNativePlayback.mock.lastCall![0].snapshot).toMatchObject({ itemId: '丙', revision: 2 });
  });

  it('下一首改了、挪了位置：按最新一版的顺序和内容', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    const moved: LinkProject = { ...v1, rundown: [v1.rundown[0]!, { ...v1.rundown[2]!, title: '挪上来的' }, v1.rundown[1]!] };
    f.player.updateProject(moved, 2, 'C:/show/拿着歌时改.tblink');
    await f.ended();
    expect(f.state()).toMatchObject({ status: 'playing', itemId: '丙' });
    expect(f.api.prepareNativeObs.mock.lastCall![0].snapshot).toMatchObject({ revision: 2, item: { title: '挪上来的' } });
  });

  it('在播的这首自己被删掉：照原样播完，接着它原来位置后面最新一版还有的那首；只写一次日志', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    f.player.updateProject(edited(v1, '甲', () => null), 2, 'C:/show/拿着歌时改.tblink');
    f.player.updateProject(edited(edited(v1, '甲', () => null), '丙', item => ({ ...item, notes: '再改' })), 3, 'C:/show/拿着歌时改.tblink');
    expect(f.notice.mock.calls.filter(([message]) => message.includes('删掉或停用了正在播的「歌曲甲」'))).toHaveLength(1);
    await f.player.seek(1000);
    expect(f.api.prepareNativePlayback.mock.lastCall![0].snapshot).toMatchObject({ itemId: '甲', revision: 1 });
    await f.ended();
    expect(f.state()).toMatchObject({ status: 'playing', itemId: '乙', error: null });
    expect(f.api.prepareNativePlayback.mock.lastCall![0].snapshot).toMatchObject({ itemId: '乙', revision: 3 });
  });

  it('改过以后定位：照样给引擎和 OBS 下一首的准备，按最新的一版（主进程按内容认，不按版本号）', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    expect(f.api.prepareNativePlayback.mock.lastCall![0].nextSnapshot).toMatchObject({ itemId: '乙', revision: 1 });
    f.player.updateProject(edited(v1, '乙', item => ({ ...item, title: '改了下一首' })), 2, 'C:/show/拿着歌时改.tblink');
    await f.player.seek(2000);
    const prepared = f.api.prepareNativePlayback.mock.lastCall![0];
    expect(prepared.snapshot).toMatchObject({ itemId: '甲', revision: 1 });
    expect(prepared.nextSnapshot).toMatchObject({ itemId: '乙', revision: 2 });
    expect(f.api.prepareNativeObs.mock.lastCall![0]).toMatchObject({ snapshot: { revision: 1, item: { id: '甲' } },
      nextFiles: { snapshot: { revision: 2, item: { id: '乙', title: '改了下一首' } } } });
  });

  it('退回上一首时在播的这首已被删掉：接着它原来位置前面最新一版还有的那首', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('乙');
    f.player.updateProject(edited(v1, '乙', () => null), 2, 'C:/show/拿着歌时改.tblink');
    await f.player.skip(-1);
    expect(f.state()).toMatchObject({ status: 'playing', itemId: '甲' });
  });

  it('要播的歌在最新一版里已经删掉或停用（快捷键、旧界面）：不播，在播的歌照常，什么都不动', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    const before = f.state(), prepared = f.api.prepareNativePlayback.mock.calls.length, sent = f.api.controlNativePlayback.mock.calls.length;
    const v2 = edited(edited(v1, '乙', () => null), '丙', item => ({ ...item, enabled: false }));
    f.player.updateProject(v2, 2, 'C:/show/拿着歌时改.tblink');
    await f.player.play('乙');
    await f.player.play('丙');
    await f.settle();
    expect(f.state()).toMatchObject({ status: 'playing', itemId: '甲', positionMs: before.positionMs, error: null });
    expect(f.api.prepareNativePlayback.mock.calls.length).toBe(prepared);
    expect(f.api.controlNativePlayback.mock.calls.length).toBe(sent);
    expect(f.notice).toHaveBeenCalledWith('要播的歌已经删掉或停用了，没有播放；正在播的歌照常播放', '甲');
  });

  it('出错以后再播：开始前就按最新的一版，不再拿出错那一遍的旧版本', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    f.emit({ status: 'error', audioError: '声卡断开' });
    await f.settle();
    expect(f.state().status).toBe('error');
    const v2 = edited(v1, '甲', withPlayback({ startMs: 1000 }));
    f.player.updateProject(v2, 2, 'C:/show/拿着歌时改.tblink');
    const playing = f.player.play('甲');
    expect(f.state().status).toBe('preparing');
    expect(f.player.currentProject()).toBe(v2);
    await playing;
    expect(f.api.prepareNativePlayback.mock.lastCall![0].snapshot).toMatchObject({ itemId: '甲', revision: 2, startMs: 1000 });
  });
});

describe('灯光：修改不发 Off，执行器只增不减；停止关所有版本用过的', () => {
  it('改了在播那首的灯光：不经 change 发 Off，告诉清单多了哪些执行器；停止交给清单的是所有版本', async () => {
    const first = lighting(['1.101']), second = lighting(['1.102']);
    const v1 = project(items => items.map(item => item.id === '甲' ? { ...item, lighting: first } : item)), f = program(v1);
    await f.player.play('甲');
    expect(f.lighting.change).toHaveBeenCalledOnce();
    const v2 = edited(v1, '甲', item => ({ ...item, lighting: second }));
    f.player.updateProject(v2, 2, 'C:/show/拿着歌时改.tblink');
    expect(f.lighting.change).toHaveBeenCalledOnce();
    expect(f.lighting.widen).toHaveBeenCalledOnce();
    const widened = f.lighting.widen.mock.calls[0]![0];
    expect(litReleaseActions(widened)).toEqual([off('1.101'), off('1.102')]);
    // Lighting removed in a later version: nothing more, nothing let go.
    f.player.updateProject(edited(v2, '甲', item => ({ ...item, lighting: undefined })), 3, 'C:/show/拿着歌时改.tblink');
    expect(f.lighting.widen).toHaveBeenCalledOnce();
    // A seek keeps every executor so far.
    await f.player.seek(2000);
    expect(f.lighting.change.mock.lastCall).toEqual([widened, widened]);
    await f.player.stop();
    const stopped: LitSong | null = f.lighting.stop.mock.lastCall![0];
    expect(stopped).toBe(widened);
    expect(litReleaseActions(stopped!)).toEqual([off('1.101'), off('1.102')]);
  });

  it('清单：多出来的执行器算正在用；已经欠着的 Off 不取消', () => {
    const ledger = new LightingOffLedger(), opening = { itemId: '乙', title: '歌曲乙' };
    ledger.use('program', ['1.101']);
    const owed = ledger.owe([off('1.103')], opening, 'stop', null);
    ledger.fail('1.103', owed[0]!.attempt, '没有连接控台', null, null);
    ledger.widen('program', ['1.101', '1.102', '1.103']);
    expect(ledger.owed().map(entry => entry.executor)).toEqual(['1.103']);
    // The new executor is in use: an Off for it is not owed while the song holds it.
    expect(ledger.owe([off('1.102'), off('1.101')], opening, 'song-change', null)).toEqual([]);
  });
});

/** A promise the test answers. */
function deferred() {
  let answer: () => void = () => undefined;
  const promise = new Promise<void>(resolve => { answer = resolve; });
  return { promise, answer: () => answer() };
}
const otherAudio = (sha: string) => (item: RundownItem): RundownItem => ({ ...item, referenceAudio: { ...item.referenceAudio!, sha256: sha.repeat(64) } });

describe('S8b：下一首改了就重新准备，不碰在播的歌', () => {
  it('下一首的音频改了：按新的一版重新准备音频和画面文件，播完时开的正是准备好的那一份', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    const v2 = edited(v1, '乙', otherAudio('b'));
    f.player.updateProject(v2, 2, 'C:/show/拿着歌时改.tblink');
    await f.settle();
    expect(f.api.prepareNextNativePlayback).toHaveBeenCalledOnce();
    const asked: NativePlayerNext = f.api.prepareNextNativePlayback.mock.lastCall![0];
    expect(asked.nextSnapshot).toMatchObject({ itemId: '乙', revision: 2, audio: { sha256: 'b'.repeat(64) } });
    const files: NativeObsNext = f.api.prepareNextNativeObs.mock.lastCall![0];
    expect(files.nextFiles).toMatchObject({ snapshot: { revision: 2, item: { id: '乙', referenceAudio: { sha256: 'b'.repeat(64) } } } });
    await f.ended();
    expect(f.state()).toMatchObject({ status: 'playing', itemId: '乙' });
    // The main process takes a preparation only by these identities (NativeAudioPreload.take, NativeObsPreloadPool.take).
    const started = f.api.prepareNativePlayback.mock.lastCall![0], picture = f.api.prepareNativeObs.mock.lastCall![0];
    expect(nextAudioIdentity(started.snapshot)).toBe(nextAudioIdentity(asked.nextSnapshot!));
    expect(nextPictureIdentity(picture, started.snapshot.positionMs)).toBe(nextPictureIdentity({ ...picture, snapshot: files.nextFiles!.snapshot }, files.nextFiles!.positionMs));
  });

  it('下一首被删掉：放下它，准备它后面那首；别的歌改了不重新准备', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    f.player.updateProject(edited(v1, '丙', item => ({ ...item, title: '改了第三首' })), 2, 'C:/show/拿着歌时改.tblink');
    f.player.updateProject(edited(v1, '甲', withPlayback({ volume: 30 })), 3, 'C:/show/拿着歌时改.tblink');
    await f.settle();
    expect(f.api.prepareNextNativePlayback).not.toHaveBeenCalled();
    expect(f.api.prepareNextNativeObs).not.toHaveBeenCalled();
    f.player.updateProject(edited(v1, '乙', () => null), 4, 'C:/show/拿着歌时改.tblink');
    await f.settle();
    expect(f.api.prepareNextNativePlayback.mock.lastCall![0].nextSnapshot).toMatchObject({ itemId: '丙', revision: 4 });
    expect(f.api.prepareNextNativeObs.mock.lastCall![0].nextFiles).toMatchObject({ snapshot: { revision: 4, item: { id: '丙' } } });
    // Its own end action switched away from 播下一首: nothing is prepared ahead any more.
    f.player.updateProject(edited(edited(v1, '乙', () => null), '甲', withPlayback({ endAction: 'stop' })), 5, 'C:/show/拿着歌时改.tblink');
    await f.settle();
    expect(f.api.prepareNextNativePlayback.mock.lastCall![0].nextSnapshot).toBeNull();
    expect(f.api.prepareNextNativeObs.mock.lastCall![0].nextFiles).toBeNull();
  });

  it('连改十次：同一时间最多一个在路上，最后一次的赢，中间的不再发', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    let inFlight = 0, most = 0;
    const answers: (() => void)[] = [];
    const held = (): Promise<void> => {
      inFlight++; most = Math.max(most, inFlight);
      const answer = deferred(); answers.push(answer.answer);
      return answer.promise.finally(() => { inFlight--; });
    };
    f.api.prepareNextNativePlayback.mockImplementation(held);
    f.api.prepareNextNativeObs.mockImplementation(held);
    let version = v1;
    for (let edit = 1; edit <= 10; edit++) {
      version = edited(version, '乙', withPlayback({ startMs: edit * 100 }));
      f.player.updateProject(version, edit + 1, 'C:/show/拿着歌时改.tblink');
      await f.settle();
    }
    expect(f.api.prepareNextNativePlayback).toHaveBeenCalledTimes(1);
    for (let round = 0; round < 3; round++) { for (const answer of answers.splice(0)) answer(); await f.settle(); }
    expect(most).toBe(2);
    expect(f.api.prepareNextNativePlayback).toHaveBeenCalledTimes(2);
    expect(f.api.prepareNextNativeObs).toHaveBeenCalledTimes(2);
    expect(f.api.prepareNextNativePlayback.mock.lastCall![0].nextSnapshot).toMatchObject({ itemId: '乙', revision: 11, positionMs: 1000 });
    expect(f.api.prepareNextNativeObs.mock.lastCall![0].nextFiles).toMatchObject({ snapshot: { revision: 11 }, positionMs: 1000 });
  });

  it('重新准备期间：在播的歌的引擎、画面和动作 MIDI 什么都没收到；问的是另一条路，不是播放控制', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    const before = { prepared: f.api.prepareNativePlayback.mock.calls.length, controls: f.api.controlNativePlayback.mock.calls.length,
      pictures: f.api.prepareNativeObs.mock.calls.length, stops: f.api.stopNativeObs.mock.calls.length, preloads: f.api.preloadNativeObs.mock.calls.length,
      cancels: f.api.cancelNativeObsPreload.mock.calls.length, actions: f.runtime.prepare.mock.calls.length, actionStops: f.runtime.stop.mock.calls.length,
      actionPauses: f.runtime.pause.mock.calls.length };
    const audio = deferred(), picture = deferred();
    f.api.prepareNextNativePlayback.mockImplementationOnce(() => audio.promise);
    f.api.prepareNextNativeObs.mockImplementationOnce(() => picture.promise);
    f.player.updateProject(edited(v1, '乙', otherAudio('c')), 2, 'C:/show/拿着歌时改.tblink');
    await f.settle();
    // The song plays on meanwhile: its clock comes in, nothing is sent back.
    f.emit({ positionMs: 1500 }); f.emit({ positionMs: 1600 });
    audio.answer(); picture.answer(); await f.settle();
    expect({ prepared: f.api.prepareNativePlayback.mock.calls.length, controls: f.api.controlNativePlayback.mock.calls.length,
      pictures: f.api.prepareNativeObs.mock.calls.length, stops: f.api.stopNativeObs.mock.calls.length, preloads: f.api.preloadNativeObs.mock.calls.length,
      cancels: f.api.cancelNativeObsPreload.mock.calls.length, actions: f.runtime.prepare.mock.calls.length, actionStops: f.runtime.stop.mock.calls.length,
      actionPauses: f.runtime.pause.mock.calls.length }).toEqual(before);
    expect(f.state()).toMatchObject({ status: 'playing', itemId: '甲', error: null, notice: null });
    // Bound to the song's own session and its picture's preparation, not a control of either.
    const asked = f.api.prepareNextNativePlayback.mock.lastCall![0], obs = f.api.prepareNativeObs.mock.lastCall![0];
    expect(Object.keys(asked).sort()).toEqual(['generation', 'nextSnapshot', 'sessionId', 'version']);
    expect(f.api.prepareNextNativeObs.mock.lastCall![0]).toMatchObject({ sessionId: obs.sessionId, generation: obs.generation });
  });

  it('播完时新的还没准备好：照常冷启动下一首（不等、不报错）', async () => {
    const v1 = project(), f = program(v1);
    await f.player.play('甲');
    f.api.prepareNextNativePlayback.mockImplementationOnce(() => new Promise<void>(() => undefined));
    f.player.updateProject(edited(v1, '乙', otherAudio('d')), 2, 'C:/show/拿着歌时改.tblink');
    await f.settle();
    await f.ended();
    expect(f.state()).toMatchObject({ status: 'playing', itemId: '乙', error: null });
    expect(f.api.prepareNativePlayback.mock.lastCall![0].snapshot).toMatchObject({ itemId: '乙', revision: 2, audio: { sha256: 'd'.repeat(64) } });
  });
});

const pressed = (id: string, note = 60, durationMs?: number): LinkAction => ({ id, label: id, kind: 'midi.noteOn', portProfileId: 'out', channel: 1, note, velocity: 100,
  ...durationMs === undefined ? {} : { durationMs } });
const released = (id: string, note = 60): LinkAction => ({ id, label: id, kind: 'midi.noteOff', portProfileId: 'out', channel: 1, note, velocity: 0 });
/** The held song 甲 with these cues, at 30 frames a second: `atMs` is on a frame. */
function withCues(from: LinkProject, cues: { id: string; atMs: number; actions: LinkAction[] }[]): LinkProject {
  const parsed = parseLinkProject({ ...from, rundown: from.rundown.map(item => item.id !== '甲' ? item
    : { ...item, cues: cues.map(cue => ({ id: cue.id, name: cue.id, enabled: true, notes: '', timecode: frameNumberToTimecode(cue.atMs * 30 / 1000, '30'), actions: cue.actions })) }) });
  return edited(from, '甲', () => parsed.rundown.find(item => item.id === '甲')!);
}
/** An action MIDI session over a fake port, its clock driven by the test. */
function actionPort() {
  let now = 0;
  const sent: number[][] = [], missed: string[] = [];
  const dependencies: MidiProgramDependencies = { prepare: () => Promise.resolve(), close: () => Promise.resolve(), now: () => now,
    send: (_port, bytes) => { sent.push([...bytes]); return Promise.resolve(); }, sent: () => undefined, missed: message => { missed.push(message); },
    late: () => undefined, failed: error => { throw error; } };
  const at = async (session: MidiProgramSession, positionMs: number) => { now = 10_000 + positionMs; session.clock(positionMs, now); await session.settled(); };
  return { sent, missed, dependencies, at };
}
const ON = [0x90, 60, 100], OFF = [0x80, 60, 0];

describe('S8b：在播的歌的动作 MIDI 从播放头往后跟新的一版', () => {
  const base = withCues(project(), [{ id: 'x', atMs: 5000, actions: [pressed('x-on', 62)] }]);
  const start = async (opened: LinkProject) => {
    const port = actionPort(), session = new MidiProgramSession(opened, '甲', port.dependencies, 'live');
    await session.prepare(0);
    return { ...port, session };
  };

  it('播放头后面的动作挪到更后面：只在新的时间发一次', async () => {
    const f = await start(base);
    await f.at(f.session, 0); await f.at(f.session, 2000);
    f.session.retarget(withCues(base, [{ id: 'x', atMs: 8000, actions: [pressed('x-on', 62)] }]));
    for (const position of [3000, 5000, 6000]) await f.at(f.session, position);
    expect(f.sent).toEqual([]);
    for (const position of [8000, 9000, 10_000]) await f.at(f.session, position);
    expect(f.sent).toEqual([[0x90, 62, 100]]);
  });

  it('挪到播放头前面：不发；已经发过的挪到后面：也不再发', async () => {
    // A Program Change goes out however late it is (midi-late-rule.ts): it shows an action moved before the playhead is not sent.
    const program = (id: string): LinkAction => ({ id, label: id, kind: 'midi.programChange', portProfileId: 'out', channel: 1, program: 7 });
    const opened = withCues(base, [{ id: 'y', atMs: 1000, actions: [pressed('y-on', 64)] }, { id: 'x', atMs: 5000, actions: [pressed('x-on', 62)] },
      { id: 'pc', atMs: 6000, actions: [program('pc-change')] }]);
    const f = await start(opened);
    await f.at(f.session, 0); await f.at(f.session, 1000); await f.at(f.session, 2000);
    expect(f.sent).toEqual([[0x90, 64, 100]]);
    f.session.retarget(withCues(base, [{ id: 'y', atMs: 7000, actions: [pressed('y-on', 64)] }, { id: 'x', atMs: 1000, actions: [pressed('x-on', 62)] },
      { id: 'pc', atMs: 1500, actions: [program('pc-change')] }]));
    for (const position of [3000, 5000, 7000, 9000]) await f.at(f.session, position);
    expect(f.sent).toEqual([[0x90, 64, 100]]);
  });

  it('不留挂着的音：已发的 Note On 新的一版删了它的 Note Off，旧的 Note Off 照发；带时长的照旧时长结束；没发的删了就不发', async () => {
    const opened = withCues(base, [{ id: 'held', atMs: 1000, actions: [pressed('held-on')] }, { id: 'pulse', atMs: 1000, actions: [pressed('pulse-on', 61, 1500)] },
      { id: 'later', atMs: 3000, actions: [pressed('later-on', 63)] }, { id: 'end', atMs: 6000, actions: [released('held-off')] }]);
    const f = await start(opened);
    await f.at(f.session, 0); await f.at(f.session, 1000); await f.at(f.session, 2000);
    expect(f.sent).toEqual([ON, [0x90, 61, 100]]);
    // The new version has none of them: no Note Off for `held`, no `pulse` and no `later`.
    f.session.retarget(withCues(base, []));
    for (const position of [2500, 3000, 4000, 5000, 6000, 7000]) await f.at(f.session, position);
    expect(f.sent).toEqual([ON, [0x90, 61, 100], [0x80, 61, 0], OFF]);
  });

  it('新的一版有它自己的 Note Off：按新的时间关，旧的那条不再发', async () => {
    const opened = withCues(base, [{ id: 'held', atMs: 1000, actions: [pressed('held-on')] }, { id: 'end', atMs: 6000, actions: [released('held-off')] }]);
    const f = await start(opened);
    await f.at(f.session, 0); await f.at(f.session, 1000); await f.at(f.session, 2000);
    f.session.retarget(withCues(base, [{ id: 'held', atMs: 1000, actions: [pressed('held-on')] }, { id: 'end', atMs: 4000, actions: [released('held-off')] }]));
    for (const position of [3000, 4000, 5000, 6000, 7000]) await f.at(f.session, position);
    expect(f.sent).toEqual([ON, OFF]);
    expect(f.missed).toEqual([]);
  });

  it('暂停时改了：改动等在那里，继续播放时按新的一版从那时的位置排；暂停前已经发过的挪到后面也不再发（a、b）', async () => {
    const opened = withCues(base, [{ id: 'w', atMs: 1000, actions: [pressed('w-on', 66)] }, { id: 'x', atMs: 5000, actions: [pressed('x-on', 62)] }]);
    const r = actionRig(opened);
    await r.f.player.play('甲');
    await r.run([0, 1000, 2000]);
    expect(r.port.sent).toEqual([[0x90, 66, 100]]);
    await r.f.player.pause();
    const moved = withCues(opened, [{ id: 'w', atMs: 3500, actions: [pressed('w-on', 66)] },
      { id: 'x', atMs: 3000, actions: [pressed('x-on', 62)] }, { id: 'z', atMs: 4000, actions: [pressed('z-on', 65)] }]);
    r.f.player.updateProject(moved, 2, 'C:/show/拿着歌时改.tblink');
    expect(r.f.player.actionsProject()).toBe(moved);
    await r.f.player.resume();
    await r.run([2500, 3000, 3500, 4000, 5000, 6000]);
    expect(r.port.sent).toEqual([[0x90, 66, 100], [0x90, 62, 100], [0x90, 65, 100]]);
    // A seek of the same song keeps them; the audio and picture still follow the version it started with.
    await r.f.player.seek(1000);
    expect(r.f.player.actionsProject()).toBe(moved);
    expect(r.f.player.currentProject()).toBe(opened);
  });
});

/** The held song 甲 through the player, its action MIDI on a real MidiProgramSession over a fake port. The prepare
 * dependency does what NativeMidiHost does: it carries what the stopped session handled only into the same pass. */
function actionRig(opened: LinkProject) {
  const port = actionPort();
  let session: MidiProgramSession | null = null, sessionPass: number | undefined, failNext = false;
  let passed: { pass: number | undefined; keys: ReadonlySet<string> } | null = null;
  const passes: (number | undefined)[] = [];
  const close = async () => {
    const closing = session; session = null;
    if (closing) passed = { pass: sessionPass, keys: closing.passed };
    await closing?.close();
  };
  const f = program(opened, {
    prepare: async (itemId, positionMs, { pass }) => {
      passes.push(pass); await close();
      if (failNext) { failNext = false; throw new Error('动作 MIDI 没有准备好'); }
      session = new MidiProgramSession(f.player.actionsProject(), itemId, port.dependencies, 'live'); sessionPass = pass;
      await session.prepare(positionMs, pass !== undefined && passed?.pass === pass ? passed.keys : undefined);
    },
    pause: close, stop: close, retargetActions: project => session?.retarget(project)
  });
  /** The music plays through these positions: the player sees them, and the session gets each as a clock. */
  const run = async (positions: number[]) => {
    for (const position of positions) { f.emit({ positionMs: position }); await port.at(session!, position); }
  };
  return { f, port, run, passes, failNextPrepare: () => { failNext = true; } };
}
const X = [0x90, 64, 100], Y = [0x90, 67, 100];

describe('S8b：一遍里轮到过的动作不再发，重新放到某处就是新的一遍', () => {
  const opened = withCues(project(), [{ id: 'x', atMs: 1000, actions: [pressed('x-on', 64)] }, { id: 'y', atMs: 1500, actions: [pressed('y-on', 67)] }]);

  it('c：播放中拖回 X 前面再接着放：X 到点再发一次', async () => {
    const r = actionRig(opened);
    await r.f.player.play('甲'); await r.run([0, 500, 1000, 1500, 2000]);
    // The scrub leaves it paused there (no press while it placed the song); play is pressed after it.
    await r.f.player.scrub('甲', 500); await r.f.player.resume();
    await r.run([500, 1000, 1500]);
    expect(r.port.sent).toEqual([X, Y, X, Y]);
    expect(r.passes[1]).not.toBe(r.passes[0]);
  });

  it('d：暂停、拖回 X 前面、继续：X 再发；i：暂停时新的一版把 Y 挪到新位置后面，Y 按新的时间发', async () => {
    const r = actionRig(opened);
    await r.f.player.play('甲'); await r.run([0, 500, 1000, 1500, 2000]);
    await r.f.player.pause();
    await r.f.player.scrub('甲', 500);
    r.f.player.updateProject(withCues(opened, [{ id: 'x', atMs: 1000, actions: [pressed('x-on', 64)] }, { id: 'y', atMs: 3000, actions: [pressed('y-on', 67)] }]), 2, 'C:/show/拿着歌时改.tblink');
    await r.f.player.resume();
    await r.run([500, 1000, 1500, 2000, 3000]);
    expect(r.port.sent).toEqual([X, Y, X, Y]);
  });

  it('e：定位回 X 前面：X 再发', async () => {
    const r = actionRig(opened);
    await r.f.player.play('甲'); await r.run([0, 500, 1000, 1500, 2000]);
    await r.f.player.seek(500); await r.f.settle();
    await r.run([500, 1000]);
    expect(r.port.sent).toEqual([X, Y, X]);
  });

  it('f：定位回去时动作 MIDI 没准备成，暂停再继续：X 再发', async () => {
    const r = actionRig(opened);
    await r.f.player.play('甲'); await r.run([0, 500, 1000, 1500, 2000]);
    r.failNextPrepare();
    await r.f.player.seek(500); await r.f.settle();
    await r.f.player.pause();
    await r.f.player.resume();
    await r.run([500, 1000]);
    expect(r.port.sent).toEqual([X, Y, X]);
  });

  it('g：暂停继续两次：X 一直不再发', async () => {
    const r = actionRig(opened);
    await r.f.player.play('甲'); await r.run([0, 500, 1000, 1200]);
    for (let round = 0; round < 2; round++) {
      await r.f.player.pause();
      r.f.player.updateProject(withCues(opened, [{ id: 'x', atMs: 2500 + round * 1000, actions: [pressed('x-on', 64)] },
        { id: 'y', atMs: 1500, actions: [pressed('y-on', 67)] }]), round + 2, 'C:/show/拿着歌时改.tblink');
      await r.f.player.resume();
    }
    await r.run([1300, 1500, 2500, 3500, 4000]);
    expect(r.port.sent).toEqual([X, Y]);
  });

  it('排不出来的一版（Cue 在不存在的图层上）：播放器当场拒绝，暂停中也一样，这首歌照原来的动作发', async () => {
    const retarget = vi.fn<NonNullable<InternalPlayerDependencies['retargetActions']>>();
    const f = program(opened, { retargetActions: retarget });
    await f.player.play('甲'); await f.player.pause();
    const broken: LinkProject = edited(opened, '甲', item => ({ ...item, cues: item.cues.map(cue => ({ ...cue, layerId: 'gone' })) }));
    f.player.updateProject(broken, 2, 'C:/show/拿着歌时改.tblink');
    expect(retarget).not.toHaveBeenCalled();
    expect(f.player.actionsProject()).toBe(opened);
    expect(f.state().notice).toContain('这次修改的 MIDI 动作没能用上');
  });

  it('h：循环：每一遍 X 都发', async () => {
    const r = actionRig(edited(opened, '甲', withPlayback({ endAction: 'loop' })));
    await r.f.player.play('甲'); await r.run([0, 500, 1000, 1500, 2000]);
    await r.f.ended(); await r.f.settle();
    await r.run([0, 500, 1000, 1500]);
    expect(r.port.sent).toEqual([X, Y, X, Y]);
  });
});

describe('S8b：下一首准备不了，同一首在播的歌只说一次', () => {
  it('下一首的播放范围不对、准备不了：连改十次也只提示、只记一次', async () => {
    // Its range ends before it starts (an older file, or an edit the store did not check): it cannot be prepared ahead.
    const opened = edited(project(), '乙', withPlayback({ startMs: 9000, endMs: 3000 }));
    const f = program(opened);
    await f.player.play('甲');
    let version = opened;
    for (let edit = 1; edit <= 10; edit++) {
      version = edited(version, '丙', item => ({ ...item, title: `改了 ${edit}` }));
      f.player.updateProject(version, edit + 1, 'C:/show/拿着歌时改.tblink');
      await f.settle();
      // A seek of the held song clears the player's notice halfway: still the same song held, so not said again.
      if (edit === 5) { await f.player.seek(500); await f.settle(); expect(f.state().notice ?? '').not.toContain('下一个节目'); }
    }
    const said = f.notice.mock.calls.filter(([message]) => message.includes('下一个节目'));
    expect(said.length).toBeGreaterThan(0); expect(said.length).toBeLessThanOrEqual(2);
    expect(new Set(said.map(([message]) => message)).size).toBe(said.length);
  });
});

describe('S8b 第二部分：在播的歌的画面按新的一版走（播放器这边；画面那边见 R9 的 native-obs-host-retarget.test.ts）', () => {
  const cut = (scene: string, atMs = 2000) => ({ id: 'cam', atMs, actions: [{ id: 'cam-cut', label: '切机位', kind: 'obs.setProgramScene' as const, sceneName: scene }] });
  const setup = () => {
    const opened = withCues(project(), [cut('机位一')]);
    const retarget = vi.fn<ProgramPictureOutput['retarget']>();
    return { opened, retarget, f: program(opened, {}, { retarget }) };
  };

  it('改了机位：交给画面的是新的一版，不带位置；画面报了“已用上”才算这一版', async () => {
    const { opened, retarget, f } = setup();
    await f.player.play('甲');
    const v2 = withCues(opened, [cut('机位二')]);
    f.player.updateProject(v2, 2, 'C:/show/拿着歌时改.tblink');
    expect(retarget).toHaveBeenCalledOnce();
    const request = retarget.mock.lastCall![0];
    expect(Object.keys(request).sort()).toEqual(['revision', 'snapshot']);
    expect(request).toMatchObject({ revision: 2, snapshot: { revision: 2, item: { cues: [{ actions: [{ sceneName: '机位二' }] }] } } });
    // Not applied yet: the picture still runs the version the song started with.
    expect(f.player.currentProject()).toBe(opened);
    f.pictureStatus({ appliedRevision: 1 });
    expect(f.player.currentProject()).toBe(opened);
    f.pictureStatus({ appliedRevision: 2 });
    expect(f.player.currentProject()).toBe(v2);
    // The audio, its timecode and its action MIDI were not prepared again.
    expect(f.api.prepareNativePlayback).toHaveBeenCalledOnce();
    expect(f.api.prepareNativeObs).toHaveBeenCalledOnce();
  });

  it('连改十次：同一时间最多一个在路上，用上以后只发最新的那一版', async () => {
    const { opened, retarget, f } = setup();
    await f.player.play('甲');
    let version = opened;
    for (let edit = 1; edit <= 10; edit++) {
      version = withCues(version, [cut(`机位${edit}`)]);
      f.player.updateProject(version, edit + 1, 'C:/show/拿着歌时改.tblink');
    }
    expect(retarget).toHaveBeenCalledOnce();
    f.pictureStatus({ appliedRevision: 2 });
    expect(retarget).toHaveBeenCalledTimes(2);
    expect(retarget.mock.lastCall![0].revision).toBe(11);
    f.pictureStatus({ appliedRevision: 11 });
    expect(retarget).toHaveBeenCalledTimes(2);
    expect(f.player.currentProject()).toBe(version);
  });

  it('只改音量、名字、动作 MIDI 这类和画面无关的：不动画面；改回原样也算一次改动', async () => {
    const { opened, retarget, f } = setup();
    await f.player.play('甲');
    f.player.updateProject(edited(opened, '甲', withPlayback({ volume: 30 })), 2, 'C:/show/拿着歌时改.tblink');
    // The cues change, but only by an action MIDI cue and the song's name: the picture is the same.
    const midi = withCues(opened, [cut('机位一'), { id: 'midi', atMs: 3000, actions: [pressed('m-on', 70)] }]);
    f.player.updateProject(edited(midi, '甲', item => ({ ...item, notes: '改了备注', title: '改了名字' })), 3, 'C:/show/拿着歌时改.tblink');
    expect(retarget).not.toHaveBeenCalled();
    const v4 = withCues(opened, [cut('机位二')]);
    f.player.updateProject(v4, 4, 'C:/show/拿着歌时改.tblink');
    f.pictureStatus({ appliedRevision: 4 });
    f.player.updateProject(opened, 5, 'C:/show/拿着歌时改.tblink');
    expect(retarget).toHaveBeenCalledTimes(2);
    expect(retarget.mock.lastCall![0]).toMatchObject({ revision: 5, snapshot: { item: { cues: [{ actions: [{ sceneName: '机位一' }] }] } } });
  });

  it('画面接不了这一版、报了失败：之后再改也不再交给这个画面（R9）', async () => {
    const { opened, retarget, f } = setup();
    await f.player.play('甲');
    f.player.updateProject(withCues(opened, [cut('机位二')]), 2, 'C:/show/拿着歌时改.tblink');
    expect(retarget).toHaveBeenCalledOnce();
    f.pictureStatus({ state: 'failed', reason: '这次修改的画面用不上' });
    f.player.updateProject(withCues(opened, [cut('机位三')]), 3, 'C:/show/拿着歌时改.tblink');
    expect(retarget).toHaveBeenCalledOnce();
    expect(f.player.currentProject()).toBe(opened);
  });

  it('画面拒绝了这一版：说明原因、不再等它，下一次改照常交；拒绝以后到下一版用上之前，窗口知道改的画面这一遍用不上（R9）', async () => {
    const { opened, retarget, f } = setup();
    await f.player.play('甲');
    expect(f.state().pictureTakesEdits).toBe(true);
    retarget.mockImplementationOnce(() => { throw new Error('画面已经有更新的一版，这一版用不着'); });
    f.player.updateProject(withCues(opened, [cut('机位二')]), 2, 'C:/show/拿着歌时改.tblink');
    expect(retarget).toHaveBeenCalledOnce();
    expect(f.state().notice).toBe('这次修改的画面没能用上，画面照原来的播：画面已经有更新的一版，这一版用不着');
    expect(f.state().pictureTakesEdits).toBe(false);
    const v3 = withCues(opened, [cut('机位三')]);
    f.player.updateProject(v3, 3, 'C:/show/拿着歌时改.tblink');
    expect(retarget).toHaveBeenCalledTimes(2);
    expect(retarget.mock.lastCall![0].revision).toBe(3);
    f.pictureStatus({ appliedRevision: 3 });
    expect(f.player.currentProject()).toBe(v3);
    expect(f.state().pictureTakesEdits).toBe(true);
  });

  it('画面失败、停了、或者 OBS 重连恢复到了上限：窗口知道改的画面这一遍用不上（R9）', async () => {
    const limit = setup();
    await limit.f.player.play('甲');
    limit.f.pictureStatus({ items: [{ id: 'obs.restore', scope: 'item', state: 'limit', detail: '这首歌的画面恢复已经到上限' }] });
    expect(limit.f.state().pictureTakesEdits).toBe(false);
    const failed = setup();
    await failed.f.player.play('甲');
    failed.f.pictureStatus({ state: 'failed', reason: '画面出错' });
    expect(failed.f.state().pictureTakesEdits).toBe(false);
    // No picture output that follows newer versions: said as before.
    const plain = program(withCues(project(), [cut('机位一')]));
    await plain.player.play('甲');
    expect(plain.state().pictureTakesEdits).toBeUndefined();
  });

  it('暂停时也交给画面；准备中改的，准备好了再交；没有画面输出时照旧按开始那一版', async () => {
    const { opened, retarget, f } = setup();
    let finish: (status: NativeObsStatus) => void = () => undefined;
    f.api.prepareNativeObs.mockImplementationOnce(request => new Promise<NativeObsStatus>(resolve => { finish = resolve; void request; }));
    const playing = f.player.play('甲');
    await f.settle();
    const v2 = withCues(opened, [cut('机位二')]);
    f.player.updateProject(v2, 2, 'C:/show/拿着歌时改.tblink');
    expect(retarget).not.toHaveBeenCalled();
    const request = f.api.prepareNativeObs.mock.lastCall![0];
    finish({ version: 1, sessionId: request.sessionId, generation: request.generation, itemId: '甲', revision: 1, state: 'ready', reason: null,
      currentCueId: null, nextCueId: null, pendingCount: 0, positionMs: 0 });
    await playing;
    expect(retarget).toHaveBeenCalledOnce();
    f.pictureStatus({ appliedRevision: 2 });
    await f.player.pause();
    const v3 = withCues(v2, [cut('机位三')]);
    f.player.updateProject(v3, 3, 'C:/show/拿着歌时改.tblink');
    expect(retarget).toHaveBeenCalledTimes(2);
    expect(retarget.mock.lastCall![0].revision).toBe(3);

    const plain = program(opened);
    await plain.player.play('甲');
    plain.player.updateProject(v2, 2, 'C:/show/拿着歌时改.tblink');
    expect(plain.player.currentProject()).toBe(opened);
  });
});
