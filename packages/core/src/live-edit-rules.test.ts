import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, lightingDocumentSchema, lightingMa2BindingSchema, lightingTrackSchema, parseLinkProject,
  type LightingDocument, type LinkProject, type NativeObsPrepare, type NativeObsStatus, type NativePlayerControl, type NativePlayerPrepare, type NativePlayerStatus,
  type RundownItem } from '@tb/schema';
import { emptyInternalPlayerState, type InternalPlayerState, type LitSong, type ProgramLightingOutput } from './program-player';
import { NativeProgramPlayer } from './native-program-player';
import { LightingOffLedger, litReleaseActions } from './lighting-off-ledger';
import { songStructureChanges } from './live-revision-effect';
import { showGate, type ShowState } from './show-state';

/**
 * 0.5.9 S8a（design 02 §3.5）：拿着歌时改工程。在播的歌的音频、时间码、画面和动作 MIDI 一直跟它开始的那一版；
 * 只有它保存的音量、它自己的“播完后”和它的灯光可能用到的执行器当即生效，别的等下一首（下一首放最新的一版）。
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

/** A program over a fake audio engine and picture host; `lighting` records what the lights-off ledger is told. */
function program(opened: LinkProject) {
  let status: NativePlayerStatus | null = null, listener: ((value: NativePlayerStatus) => void) | null = null;
  let state: InternalPlayerState = { ...emptyInternalPlayerState };
  const emit = (patch: Partial<NativePlayerStatus>): NativePlayerStatus => { status = { ...status!, ...patch }; listener?.(status); return status; };
  const api = {
    preloadNativeObs: vi.fn(() => Promise.resolve()), cancelNativeObsPreload: vi.fn(() => Promise.resolve()),
    onNativeObsStatus: () => () => undefined, stopNativeObs: vi.fn(() => Promise.resolve()),
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
  const dependencies = { prepare: () => Promise.resolve(), ingest: () => Promise.resolve(), stop: () => Promise.resolve(), pause: () => Promise.resolve(),
    resolveAudio: () => Promise.resolve('unused'), configuration: () => ({ outputDeviceId: 'default', mtcPortName: null, audioSampleRate: 48000 as const }),
    changed: (next: InternalPlayerState) => { state = next; }, notice, closedFault: vi.fn() };
  const output = {
    change: vi.fn<ProgramLightingOutput['change']>(() => Promise.resolve({ failed: [] })),
    stop: vi.fn<ProgramLightingOutput['stop']>(() => Promise.resolve({ failed: [] })),
    widen: vi.fn<ProgramLightingOutput['widen']>()
  };
  const player = new NativeProgramPlayer(opened, 'C:/show/拿着歌时改.tblink', 1, dependencies, api, output);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  /** What the engine plays at now, 0–100. */
  const gain = async (): Promise<number> => { await settle(); return Math.round((status?.gain ?? Number.NaN) * 100); };
  /** The engine played the song to its end. */
  const ended = async (): Promise<void> => { emit({ status: 'ended' }); await settle(); await settle(); };
  return { player, api, gain, ended, settle, emit, notice, lighting: output, state: () => state };
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
