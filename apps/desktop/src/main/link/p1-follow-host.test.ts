import { describe, expect, it, vi } from 'vitest';
import { allocateP1TimecodeRanges, frameNumberToTimecode, type ProgramClock } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type LinkProject, type P1FollowCommand, type P1FollowState } from '@tb/schema';
import type { MidiInputClaim, MidiInputListener } from './midi-port-broker';
import { P1FollowHost } from './p1-follow-host';

/** The main-process P1 follow host with a fake broker and fake outputs (0.5.9 P3c). */

const FPS = 30;
const FRAME_MS = 1000 / FPS;
const OWNER = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const OTHER = '7f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';

function fixture(project: LinkProject, options: { prepare?: (itemId: string) => Promise<void>; claim?: () => Promise<void> } = {}) {
  const calls: string[] = [], states: P1FollowState[] = [], logs: string[] = [], clocks: ProgramClock[] = [];
  const claims: { name: string; listener: MidiInputListener; release: ReturnType<typeof vi.fn> }[] = [];
  const prepareSong = vi.fn((_project: LinkProject, itemId: string) => options.prepare?.(itemId) ?? Promise.resolve());
  const host = new P1FollowHost({
    claimInput: async (name, listener) => {
      await options.claim?.();
      const release = vi.fn(() => Promise.resolve());
      claims.push({ name, listener, release });
      return { owner: 'P1 时间码', release } satisfies MidiInputClaim;
    },
    openProject: () => project,
    outputs: () => ({
      observe: clock => { calls.push(`observe:${clock.state}`); clocks.push(clock); },
      hold: () => { calls.push('hold'); },
      reconcileAt: clock => { calls.push(`reconcileAt:${clock.state}`); clocks.push(clock); }
    }),
    prepareSong, changed: state => { states.push(state); }, log: (level, message) => { logs.push(`${level}:${message}`); }
  });
  const send = (command: P1FollowCommand, ownerId = OWNER) => host.command({ version: 1, ownerId, command });
  const start = (mode: 'manual' | 'auto' = 'manual') => send({ kind: 'start', projectPath: 'C:/show.tblink', sessionId: OWNER, revision: 1, document: '{}',
    mode, runMode: 'live', inputPortName: 'loopMIDI Port' });
  /** P1 playing on the claimed input, on the interface's clock. */
  const play = (fromFrame: number, frames: number, startMs: number) => {
    const listener = claims.at(-1)!.listener;
    let lastSampleMs = startMs;
    for (let offset = 0; offset < frames; offset += 2) {
      const tc = frameNumberToTimecode(fromFrame + offset, '30');
      const pieces = [tc.frames & 15, tc.frames >> 4, tc.seconds & 15, tc.seconds >> 4, tc.minutes & 15, tc.minutes >> 4, tc.hours & 15, (tc.hours >> 4) | (3 << 1)];
      for (const [type, value] of pieces.entries()) {
        const ms = startMs + (offset + type / 4) * FRAME_MS;
        listener.message({ bytes: [0xf1, (type << 4) | value], at100ns: at(ms) });
        if (type === 7) lastSampleMs = ms;
      }
    }
    return { endMs: startMs + frames * FRAME_MS, lastSampleMs };
  };
  return { host, calls, states, logs, clocks, claims, prepareSong, send, start, play };
}

describe('P1 跟随宿主', () => {
  it('开始时由主进程占用 MTC 输入口；待命后输出收到 P1 的时钟；位置最多每 100 ms 告诉界面一次，状态一变马上告诉', async () => {
    const f = fixture(manualProject());
    const opened = await f.start();
    expect(f.claims.map(claim => claim.name)).toEqual(['loopMIDI Port']);
    expect(opened).toMatchObject({ phase: 'standby', projectId: manualProject().projectId, mode: 'manual', runMode: 'live', input: { portName: 'loopMIDI Port', state: 'open' } });
    expect(f.states.map(state => state.input?.state)).toEqual(['opening', 'open']);
    await expect(f.send({ kind: 'arm', itemId: 'song' }, OTHER)).rejects.toThrow('另一个界面正在跟随 P1');
    await f.send({ kind: 'arm', itemId: 'song' });
    const shown = f.states.length;
    f.play(0, 60, 1_000);
    expect(f.calls[0]).toBe('observe:ready');
    expect(f.calls.slice(1).every(call => call === 'observe:running')).toBe(true);
    expect(f.calls.length).toBe(31);
    const updates = f.states.slice(shown);
    expect(updates.find(state => state.phase !== 'waiting')).toMatchObject({ phase: 'running', itemId: 'song', sessionId: f.clocks[0]!.sessionId });
    // 2 s of P1: about one update per 100 ms, not one per quarter frame.
    expect(updates.length).toBeGreaterThan(10); expect(updates.length).toBeLessThan(30);
    expect(f.host.state).toMatchObject({ phase: 'running', itemId: 'song', mtc: { frameRate: '30', receiving: true, stable: true } });
    // A jump right after: the freeze reaches the window with the message that caused it, not at the next 100 ms.
    const before = f.states.length;
    f.play(200, 2, 3_000);
    expect(f.states.length).toBe(before + 1);
    expect(f.states.at(-1)).toMatchObject({ phase: 'frozen', cause: 'jump' });
  });

  it('输入口拔掉：在走的歌冻结，放开输入口，不自己重新打开；重新开始才再占用', async () => {
    const f = fixture(manualProject());
    await f.start(); await f.send({ kind: 'arm', itemId: 'song' });
    f.play(0, 30, 1_000);
    f.claims[0]!.listener.closed('MIDI 接口「loopMIDI Port」已断开。重新插好后再打开。');
    expect(f.calls.at(-1)).toBe('hold');
    expect(f.claims[0]!.release).toHaveBeenCalledOnce();
    expect(f.host.state).toMatchObject({ phase: 'frozen', cause: 'lost', reason: 'MTC 信号中断',
      input: { state: 'closed', reason: 'MIDI 接口「loopMIDI Port」已断开。重新插好后再打开。' } });
    expect(f.logs).toContain('warning:P1 时间码输入停了：MIDI 接口「loopMIDI Port」已断开。重新插好后再打开。');
    await expect(f.start()).rejects.toThrow('正在跟随 P1，先停止再换工程');
    await f.send({ kind: 'stop' });
    expect(f.calls.at(-1)).toBe('observe:stopped');
    await expect(f.send({ kind: 'arm', itemId: 'song' })).rejects.toThrow('已断开');
    expect(f.claims).toHaveLength(1);
    await f.start();
    expect(f.claims).toHaveLength(2);
    await f.send({ kind: 'arm', itemId: 'song' });
    expect(f.host.state.phase).toBe('waiting');
  });

  it('自动选歌：P1 点歌后按这首歌准备，准备好才开始；准备失败写明原因、记日志，不重试', async () => {
    let fail = false;
    const project = autoProject();
    const f = fixture(project, { prepare: () => fail ? Promise.reject(new Error('开播前检查：OBS 没连上')) : Promise.resolve() });
    await f.start('auto'); await f.send({ kind: 'arm', itemId: null });
    const a = f.play(songFrame(project, 'a'), 30, 1_000);
    expect(f.prepareSong).toHaveBeenCalledWith(project, 'a');
    expect(f.calls).toEqual([]);
    await vi.waitFor(() => expect(f.calls.slice(0, 2)).toEqual(['observe:ready', 'observe:running']));
    expect(f.host.state).toMatchObject({ phase: 'running', itemId: 'a' });
    fail = true;
    f.play(songFrame(project, 'b'), 30, a.endMs + 200);
    expect(f.calls.at(-1)).toBe('observe:stopped');
    await vi.waitFor(() => expect(f.host.state).toMatchObject({ phase: 'failed', reason: '开播前检查：OBS 没连上', itemId: 'b' }));
    expect(f.logs).toContain('warning:「b」没有开始：开播前检查：OBS 没连上');
    expect(f.prepareSong).toHaveBeenCalledTimes(2);
  });

  it('关闭、界面没了都放开输入口；手动 GO、重试和单步测试还没搬过来，明确拒绝；占用失败回到没跟随', async () => {
    const f = fixture(manualProject());
    await f.start();
    for (const command of [{ kind: 'manualGo', cueId: 'cue' }, { kind: 'retryAction', cueId: 'cue', actionId: 'a' },
      { kind: 'testAction', action: { id: 'a', label: '机位', kind: 'obs.setProgramScene', sceneName: '机位' } }] as const) {
      await expect(f.send(command)).rejects.toThrow('还没有搬到后台');
    }
    await f.send({ kind: 'close' });
    expect(f.claims[0]!.release).toHaveBeenCalledOnce();
    expect(f.host.state).toEqual(expect.objectContaining({ phase: 'closed', input: null }));
    await f.start(); await f.send({ kind: 'arm', itemId: 'song' });
    f.play(0, 30, 1_000);
    await f.host.pageGone(OTHER);
    expect(f.host.state.phase).toBe('running');
    await f.host.pageGone(OWNER);
    expect(f.calls.at(-1)).toBe('observe:stopped');
    expect(f.claims[1]!.release).toHaveBeenCalledOnce();
    expect(f.host.state.phase).toBe('closed');
    const refused = fixture(manualProject(), { claim: () => Promise.reject(new Error('MIDI 接口「loopMIDI Port」正在用作P1 时间码')) });
    await expect(refused.start()).rejects.toThrow('正在用作P1 时间码');
    expect(refused.host.state.phase).toBe('closed');
  });
});

function manualProject(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('P1 手动跟随'), projectId: 'manual', playbackSource: 'p1', rundown: [{ id: 'song', title: '歌曲', cues: [] }] });
}

function autoProject(): LinkProject {
  const project = parseLinkProject({ ...createEmptyLinkProject('P1 自动选歌'), playbackSource: 'p1', rundown: ['a', 'b'].map(id => ({
    id, title: id, cues: [], referenceAudio: { assetId: `audio-${id}`, relativePath: `assets/${id}.wav`, sha256: 'a'.repeat(64), durationMs: 30_000 }
  })) });
  project.p1AutoFollow = allocateP1TimecodeRanges(project);
  return project;
}

function songFrame(project: LinkProject, itemId: string): number {
  return project.p1AutoFollow!.ranges.find(range => range.itemId === itemId)!.startSeconds * FPS;
}

function at(ms: number): bigint { return BigInt(Math.round(ms * 10_000)); }
