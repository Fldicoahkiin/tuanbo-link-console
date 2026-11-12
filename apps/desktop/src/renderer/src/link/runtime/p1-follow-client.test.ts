import { describe, expect, it, vi } from 'vitest';
import { frameNumberToTimecode } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type IntegrationProfile, type LinkProject, type P1FollowRequest, type P1FollowState } from '@tb/schema';
import type { MidiInputListener } from '../../../../main/link/midi-port-broker';
import { P1FollowHost } from '../../../../main/link/p1-follow-host';
import { createDefaultIntegrationProfile } from '../view-models/local-integration-profile';
import { followRuntimeState, nothingFollowed, orphanFollow, P1FollowClient, type P1FollowStartInput } from './p1-follow-client';

const PAGE = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const OTHER = '7f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';

const standby: P1FollowState = {
  version: 1, phase: 'standby', ownerId: PAGE, projectId: 'p', projectPath: 'C:/show.tblink', projectName: '演出', mode: 'manual', runMode: 'live',
  itemId: null, sessionId: null, generation: 0, positionMs: null, cause: null, reason: null,
  input: { portName: 'loopMIDI Port', state: 'open', reason: null }, mtc: null, outputs: { actionMidi: null, picture: null }
};

function profile(): IntegrationProfile {
  const base = createDefaultIntegrationProfile();
  return { ...base, p1: { ...base.p1, mtcInputPortProfileId: 'mtc-in' },
    midiPortProfiles: [...base.midiPortProfiles.filter(entry => entry.id !== 'mtc-in'), { id: 'mtc-in', direction: 'input', portName: 'loopMIDI Port' }] };
}

function fixture(options: { errorsShown?: boolean; answer?: (request: P1FollowRequest) => Promise<P1FollowState> } = {}) {
  const requests: P1FollowRequest[] = [], shown: P1FollowState[] = [];
  let push: (state: P1FollowState) => void = () => undefined;
  const p1Follow = vi.fn((request: P1FollowRequest) => { requests.push(request); return options.answer?.(request) ?? Promise.resolve({ ...standby, phase: request.command.kind === 'arm' ? 'waiting' : 'standby' } as P1FollowState); });
  const client = new P1FollowClient({
    api: { p1Follow, getP1FollowState: () => Promise.resolve({ ...standby, phase: 'closed', ownerId: null, projectId: null, projectPath: null, projectName: null, mode: null, runMode: null, input: null }),
      onP1FollowState: listener => { push = listener; return () => undefined; } },
    ownerId: PAGE, shown: state => { shown.push(state); }, errorsShown: () => options.errorsShown ?? true
  });
  const project = parseLinkProject({ ...createEmptyLinkProject('演出'), playbackSource: 'p1', rundown: [{ id: 'song', title: '歌', cues: [] }] });
  const input = (revision = 1) => ({ project, path: 'C:/show.tblink', documentId: 1, revision, profile: profile(), preciseSeeking: false, encode: () => Promise.resolve('{}') });
  return { client, requests, shown, p1Follow, input, push: (state: P1FollowState) => push(state) };
}

describe('界面上跟随 P1 的唯一入口（P4）', () => {
  it('开始：带上 MTC 输入口的名字、这台电脑的设置，只按直播跑；同一版不重发，工程改了才再开始', async () => {
    const f = fixture();
    await f.client.start(() => (f.input()), 'manual');
    expect(f.requests[0]).toMatchObject({ ownerId: PAGE, command: { kind: 'start', projectPath: 'C:/show.tblink', mode: 'manual', runMode: 'live',
      inputPortName: 'loopMIDI Port', document: '{}', revision: 1, lightingProfile: { p1: { mtcInputPortProfileId: 'mtc-in' } }, preciseSeeking: false } });
    await f.client.start(() => (f.input()), 'manual');
    expect(f.requests).toHaveLength(1);
    await f.client.start(() => (f.input(2)), 'manual');
    expect(f.requests).toHaveLength(2);
  });

  it('改得快时，排着队的开始都读最新的一版：只送最新的一次', async () => {
    let release: () => void = () => undefined;
    let revision = 1;
    const f = fixture({ answer: () => new Promise(resolve => { release = () => resolve({ ...standby }); }) });
    const first = f.client.start(() => f.input(revision), 'manual');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    revision = 2; const second = f.client.start(() => f.input(revision), 'manual');
    revision = 3; const third = f.client.start(() => f.input(revision), 'manual');
    release(); await first;
    await new Promise(resolve => setTimeout(resolve, 0));
    release(); await second; await third;
    expect(f.requests.map(request => request.command.kind === 'start' ? request.command.revision : null)).toEqual([1, 3]);
  });

  it('界面还没在显示主进程的红字时不开始；没保存、联动台播放的工程、没设输入口都写明原因', async () => {
    const f = fixture({ errorsShown: false });
    await expect(f.client.start(() => (f.input()), 'manual')).rejects.toThrow('界面还没准备好显示出错提示');
    const g = fixture();
    await expect(g.client.start(() => ({ ...g.input(), path: null }), 'manual')).rejects.toThrow('工程还没保存');
    await expect(g.client.start(() => ({ ...g.input(), project: { ...g.input().project, playbackSource: 'internal' } }), 'manual')).rejects.toThrow('由联动台播放');
    await expect(g.client.start(() => ({ ...g.input(), profile: { ...profile(), midiPortProfiles: [] } }), 'manual')).rejects.toThrow('还没设置 P1 的 MTC 输入端口');
    expect([...f.requests, ...g.requests]).toEqual([]);
  });

  it('命令一次一个、按顺序；失败的说明原因，不自己重发', async () => {
    let release: () => void = () => undefined;
    const f = fixture({ answer: request => request.command.kind === 'arm'
      ? new Promise(resolve => { release = () => resolve({ ...standby, phase: 'waiting', itemId: 'song' }); })
      : request.command.kind === 'resync' ? Promise.reject(new Error('只有时间码中断后才能重新同步')) : Promise.resolve(standby) });
    const arm = f.client.arm('song');
    const resync = f.client.resync();
    await Promise.resolve(); await Promise.resolve();
    expect(f.requests.map(request => request.command.kind)).toEqual(['arm']);
    release();
    await arm;
    await expect(resync).rejects.toThrow('只有时间码中断后才能重新同步');
    expect(f.requests.map(request => request.command.kind)).toEqual(['arm', 'resync']);
    await f.client.stop();
    expect(f.requests.map(request => request.command.kind)).toEqual(['arm', 'resync', 'stop']);
  });

  it('只显示自己的跟随和没有页面的跟随，别的页面的不显示', async () => {
    const f = fixture();
    f.client.connect();
    f.push({ ...standby, ownerId: OTHER });
    expect(f.shown.filter(state => state.ownerId === OTHER)).toEqual([]);
    const orphan = { ...standby, phase: 'running', itemId: 'song', ownerId: null } as const;
    f.push(orphan);
    expect(f.shown.at(-1)).toEqual(orphan);
    expect(orphanFollow(f.shown.at(-1) ?? null)).toEqual({ projectName: '演出', projectPath: 'C:/show.tblink' });
    await f.client.adopt('C:/show.tblink');
    expect(f.requests.at(-1)).toEqual({ version: 1, ownerId: PAGE, command: { kind: 'adopt', projectPath: 'C:/show.tblink' } });
  });

  it('跟随的阶段在界面的运行状态里：自动选歌等第一首歌时算空闲，检查时显示在检查', () => {
    const at = (phase: P1FollowState['phase'], extra: Partial<P1FollowState> = {}, checking = false) => followRuntimeState({ ...standby, phase, ...extra } as P1FollowState, checking);
    expect([at('closed'), at('standby'), at('waiting', { itemId: 'song' }), at('preparing'), at('running'), at('frozen', { cause: 'lost' }), at('takeover'), at('failed')])
      .toEqual(['idle', 'idle', 'armed', 'preflight', 'running', 'timecodeLost', 'paused', 'error']);
    expect(at('waiting', { mode: 'auto', itemId: null })).toBe('idle');
    expect(at('standby', {}, true)).toBe('preflight');
    expect(at('running', {}, true)).toBe('running');
  });
});

/** The real main-process follow behind the real client, as the window reaches it (link:p1-follow). */
function live() {
  const project: LinkProject = parseLinkProject({ ...createEmptyLinkProject('演出'), playbackSource: 'p1', rundown: [{ id: 'song', title: '歌', cues: [] }] });
  const claims: { portName: string; listener: MidiInputListener; release: ReturnType<typeof vi.fn> }[] = [];
  const listeners = new Set<(state: P1FollowState) => void>();
  const host = new P1FollowHost({
    claimInput: (portName, listener) => { const release = vi.fn(() => Promise.resolve()); claims.push({ portName, listener, release }); return Promise.resolve({ owner: 'P1 时间码', release }); },
    openProject: () => Promise.resolve(project),
    outputs: () => ({ outputs: { observe: () => undefined, hold: () => undefined, reconcileAt: () => undefined }, lights: { change: () => undefined, stop: () => undefined },
      state: () => ({ actionMidi: null, picture: null }), close: () => Promise.resolve() }),
    prepareSong: () => Promise.resolve(), changed: state => { for (const listener of listeners) listener(state); }, log: () => undefined
  });
  const requests: P1FollowRequest[] = [];
  const client = new P1FollowClient({
    api: { p1Follow: request => { requests.push(request); return host.command(request); }, getP1FollowState: () => Promise.resolve(host.state),
      onP1FollowState: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    ownerId: PAGE, shown: () => undefined, errorsShown: () => true
  });
  client.connect();
  // The same document version throughout: the operator only re-plugs a cable or changes this computer's settings.
  let settings = profile();
  const input = (): P1FollowStartInput => ({ project, path: 'C:/show.tblink', documentId: 1, revision: 7, profile: settings, preciseSeeking: false, encode: () => Promise.resolve('{}') });
  const play = (frames: number, startMs: number) => {
    const listener = claims.at(-1)!.listener;
    for (let frame = 0; frame < frames; frame += 2) {
      const tc = frameNumberToTimecode(frame, '30');
      const pieces = [tc.frames & 15, tc.frames >> 4, tc.seconds & 15, tc.seconds >> 4, tc.minutes & 15, tc.minutes >> 4, tc.hours & 15, (tc.hours >> 4) | (3 << 1)];
      for (const [type, value] of pieces.entries()) listener.message({ bytes: [0xf1, (type << 4) | value], at100ns: BigInt(Math.round((startMs + (frame + type / 4) * 1000 / 30) * 10_000)) });
    }
  };
  const starts = () => requests.filter(request => request.command.kind === 'start');
  return { host, client, claims, requests, starts, input, play, change: (next: IntegrationProfile) => { settings = next; } };
}

function withPort(base: IntegrationProfile, portName: string): IntegrationProfile {
  return { ...base, midiPortProfiles: base.midiPortProfiles.map(entry => entry.id === 'mtc-in' ? { ...entry, portName } : entry) };
}

describe('同一版工程再按「启动并待命」：没跟着歌时，输入口停了或设置改了就重新开始', () => {
  it('跟着歌时拔掉 P1 的线、停止、插回再开始：重新开始，输入口重新打开，能待命', async () => {
    const f = live();
    await f.client.start(f.input, 'manual');
    await f.client.arm('song');
    f.play(30, 1_000);
    expect(f.host.state.phase).toBe('running');
    f.claims[0]!.listener.closed('MIDI 接口「loopMIDI Port」已断开。重新插好后再打开。');
    expect(f.host.state).toMatchObject({ phase: 'frozen', input: { state: 'closed' } });
    await f.client.stop();
    expect(f.host.state).toMatchObject({ phase: 'standby', input: { state: 'closed' } });
    const again = await f.client.start(f.input, 'manual');
    expect(f.starts()).toHaveLength(2);
    expect(f.claims).toHaveLength(2);
    expect(again.input).toEqual({ portName: 'loopMIDI Port', state: 'open', reason: null });
    await expect(f.client.arm('song')).resolves.toMatchObject({ phase: 'waiting', itemId: 'song' });
  });

  it('待命前换了 P1 的 MTC 输入口：带着新的输入口重新开始', async () => {
    const f = live();
    await f.client.start(f.input, 'manual');
    f.change(withPort(profile(), 'USB MIDI Interface'));
    const state = await f.client.start(f.input, 'manual');
    expect(f.starts().map(request => request.command.kind === 'start' ? request.command.inputPortName : null)).toEqual(['loopMIDI Port', 'USB MIDI Interface']);
    expect(f.claims.map(claim => claim.portName)).toEqual(['loopMIDI Port', 'USB MIDI Interface']);
    expect(f.claims[0]!.release).toHaveBeenCalledTimes(1);
    expect(state.input).toMatchObject({ portName: 'USB MIDI Interface', state: 'open' });
  });

  it('待命时改了别的连接设置（例如动作 MIDI 的输出口）：带着新的设置重新开始，输入口不重开', async () => {
    const f = live();
    await f.client.start(f.input, 'manual');
    const base = profile();
    f.change({ ...base, midiPortProfiles: [...base.midiPortProfiles, { id: 'actions', direction: 'output', portName: 'USB MIDI Interface' }] });
    await f.client.start(f.input, 'manual');
    expect(f.starts()).toHaveLength(2);
    const command = f.starts()[1]!.command;
    expect(command.kind === 'start' && command.lightingProfile?.midiPortProfiles.some(entry => entry.id === 'actions')).toBe(true);
    expect(f.claims).toHaveLength(1);
  });

  it('什么都没变：不再发开始（同一版只发一次）', async () => {
    const f = live();
    await f.client.start(f.input, 'manual');
    await f.client.start(f.input, 'manual');
    await f.client.arm('song');
    await f.client.start(f.input, 'manual');
    expect(f.starts()).toHaveLength(1);
    expect(f.claims).toHaveLength(1);
  });

  it('跟着歌时改了设置：照旧跟着这首歌，不发开始；停止以后再开始才带上新设置', async () => {
    const f = live();
    await f.client.start(f.input, 'manual');
    await f.client.arm('song');
    f.play(30, 1_000);
    f.change(withPort(profile(), 'USB MIDI Interface'));
    await expect(f.client.start(f.input, 'manual')).resolves.toMatchObject({ phase: 'running', input: { portName: 'loopMIDI Port', state: 'open' } });
    expect(f.starts()).toHaveLength(1);
    await f.client.stop();
    await f.client.start(f.input, 'manual');
    expect(f.starts()).toHaveLength(2);
    expect(f.host.state.input).toMatchObject({ portName: 'USB MIDI Interface', state: 'open' });
  });

  it('待命时输入口停了（驱动进程出错）：再开始就重新打开输入口', async () => {
    const f = live();
    await f.client.start(f.input, 'manual');
    f.claims[0]!.listener.closed('MIDI 输入服务意外关闭');
    expect(f.client.state).toMatchObject({ phase: 'standby', input: { state: 'closed' } });
    expect(nothingFollowed(f.client.state!)).toBe(true);
    await f.client.start(f.input, 'manual');
    expect(f.starts()).toHaveLength(2);
    expect(f.claims).toHaveLength(2);
    expect(f.client.state?.input?.state).toBe('open');
  });
});
