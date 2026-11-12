import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type IntegrationProfile, type P1FollowRequest, type P1FollowState } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../view-models/local-integration-profile';
import { followRuntimeState, orphanFollow, P1FollowClient } from './p1-follow-client';

const PAGE = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const OTHER = '7f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';

const standby: P1FollowState = {
  version: 1, phase: 'standby', ownerId: PAGE, projectId: 'p', projectPath: 'C:/show.tblink', projectName: '演出', mode: 'manual', runMode: 'live',
  itemId: null, sessionId: null, generation: 0, positionMs: null, cause: null, reason: null,
  input: { portName: 'loopMIDI Port', state: 'open', reason: null }, mtc: null, outputs: { actionMidi: null }
};

function profile(): IntegrationProfile {
  const base = createDefaultIntegrationProfile();
  return { ...base, p1: { ...base.p1, mtcInputPortProfileId: 'mtc-in' },
    midiPortProfiles: [...base.midiPortProfiles.filter(entry => entry.id !== 'mtc-in'), { id: 'mtc-in', label: 'P1', direction: 'input', portName: 'loopMIDI Port' }] };
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
  const input = (revision = 1) => ({ project, path: 'C:/show.tblink', documentId: 1, revision, profile: profile(), encode: () => Promise.resolve('{}') });
  return { client, requests, shown, p1Follow, input, push: (state: P1FollowState) => push(state) };
}

describe('界面上跟随 P1 的唯一入口（P4）', () => {
  it('开始：带上 MTC 输入口的名字、这台电脑的设置，只按直播跑；同一版不重发，工程改了才再开始', async () => {
    const f = fixture();
    await f.client.start(() => (f.input()), 'manual');
    expect(f.requests[0]).toMatchObject({ ownerId: PAGE, command: { kind: 'start', projectPath: 'C:/show.tblink', mode: 'manual', runMode: 'live',
      inputPortName: 'loopMIDI Port', document: '{}', revision: 1, lightingProfile: { p1: { mtcInputPortProfileId: 'mtc-in' } } } });
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
