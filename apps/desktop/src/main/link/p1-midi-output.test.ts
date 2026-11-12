import { describe, expect, it, vi } from 'vitest';
import { allocateP1TimecodeRanges, clockFromNativeStatus, frameNumberToTimecode, P1FollowSession, type ProgramClock } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type LinkAction, type LinkProject, type NativePlayerStatus } from '@tb/schema';
import { NativeMidiHost, type ActionMidiRecovery, type MidiClockSource, type NativeMidiChannelState } from './native-midi-host';
import { MidiOutputFailure } from './native-midi-output';
import { P1MidiOutput } from './p1-midi-output';

/** The action MIDI of a P1 follow through the shared NativeMidiHost (0.5.9 P3d). */

const FPS = 30;
const FRAME_MS = 1000 / FPS;
const SESSION = '4d081ed2-7f76-44c8-9c45-b0e06e860870';

function clock(state: ProgramClock['state'], positionMs: number, generation = 1, sessionId = SESSION): ProgramClock {
  return { source: 'p1', sessionId, generation, itemId: 'song', state, positionMs, observedAtMs: state === 'running' ? 1_000 + positionMs : null, reason: null };
}

/** A host that records what the adapter asks of it. `closing`: it is still closing the previous song when a preparation
 * starts, so its status shows this song only once that preparation is done. */
function recording(project: LinkProject = p1Project(), closing = false) {
  const calls: string[] = [], sources: MidiClockSource[] = [], logs: string[] = [];
  let status: NativeMidiChannelState | null = null;
  const finishes: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const host = {
    get status() { return status; },
    prepare: vi.fn((_project: LinkProject, identity: { sessionId: string; generation: number; itemId: string }, pass?: number, source?: MidiClockSource) => {
      calls.push(`prepare:g${identity.generation}:p${pass}:${source?.opening ? 'opening' : 'plain'}`);
      if (source) sources.push(source);
      const state: NativeMidiChannelState = { ...identity, state: 'preparing', reason: null, currentCueId: null };
      if (!closing) status = state;
      return new Promise<void>((resolve, reject) => { finishes.push({ resolve: () => { if (closing) status = { ...state, state: 'ready' }; resolve(); }, reject }); });
    }),
    observe: vi.fn((observed: ProgramClock) => { calls.push(`observe:${observed.state}@${observed.positionMs}`); }),
    stop: vi.fn(() => { calls.push('stop'); status = null; return Promise.resolve(); })
  };
  const output = new P1MidiOutput(project, host, (level, message) => { logs.push(`${level}:${message}`); });
  /** The latest preparation, or the `index`th, is done. */
  const ready = async (index = finishes.length - 1) => { finishes[index]!.resolve(); await Promise.resolve(); await Promise.resolve(); };
  const refuse = async (error: Error, index = finishes.length - 1) => { finishes[index]!.reject(error); await Promise.resolve(); await Promise.resolve(); };
  return { output, host, calls, sources, logs, ready, refuse, now: () => sources.at(-1)!.now() };
}

describe('P1 跟随的动作 MIDI · 对共用宿主的调用顺序（P3d）', () => {
  it('ready：新的一遍从歌曲开头准备，带开场；准备中来的位置先留着，准备好以后只把最新的一个交给宿主；之后每个位置都交', async () => {
    const f = recording();
    f.output.observe(clock('ready', 0));
    expect(f.calls).toEqual(['prepare:g1:p1:opening']);
    expect(f.now()).toMatchObject({ sessionId: SESSION, generation: 1, itemId: 'song', status: 'ready', positionMs: 0 });
    f.output.observe(clock('running', 66)); f.output.observe(clock('running', 133));
    expect(f.calls).toEqual(['prepare:g1:p1:opening']);
    await f.ready();
    expect(f.calls).toEqual(['prepare:g1:p1:opening', 'observe:running@133']);
    expect(f.now()).toMatchObject({ status: 'playing', positionMs: 133 });
    f.output.observe(clock('running', 200));
    expect(f.calls.at(-1)).toBe('observe:running@200');
    // The same session's ready again is not a new song.
    f.output.observe(clock('ready', 0));
    expect(f.host.prepare).toHaveBeenCalledOnce();
  });

  it('hold：宿主关掉这首的会话；之后的位置不交；stopped 再来也不重复关', async () => {
    const f = recording();
    f.output.observe(clock('ready', 0)); f.output.observe(clock('running', 66)); await f.ready();
    f.output.hold();
    expect(f.calls.slice(-1)).toEqual(['stop']);
    expect(f.now()).toMatchObject({ status: 'paused', positionMs: 66 });
    f.output.observe(clock('running', 100));
    f.output.observe(clock('stopped', 100));
    expect(f.calls.filter(call => call === 'stop')).toHaveLength(1);
    expect(f.calls.some(call => call.startsWith('observe:running@100'))).toBe(false);
  });

  it('reconcileAt：重同步是新的一遍、从那个位置准备；同位置继续是同一遍、从宿主停下的位置准备；都不带开场', async () => {
    const f = recording();
    f.output.observe(clock('ready', 0)); f.output.observe(clock('running', 2_000)); await f.ready();
    f.output.hold();
    f.output.reconcileAt(clock('running', 4_000, 2), false);
    expect(f.calls.at(-1)).toBe('prepare:g2:p2:plain');
    expect(f.now()).toMatchObject({ generation: 2, status: 'ready', positionMs: 4_000 });
    await f.ready();
    expect(f.calls.at(-1)).toBe('observe:running@4000');
    f.output.hold();
    f.output.reconcileAt(clock('running', 4_200, 3), true);
    expect(f.calls.at(-1)).toBe('prepare:g3:p2:plain');
    expect(f.now()).toMatchObject({ generation: 3, status: 'ready', positionMs: 4_000 });
    await f.ready();
    expect(f.calls.at(-1)).toBe('observe:running@4200');
    // Going on from where it stopped is only ever this song's; a resync of another session (rearmed, then frozen while
    // still waiting) begins that one here, a new pass.
    f.output.reconcileAt(clock('running', 1, 9, 'other'), true);
    expect(f.host.prepare).toHaveBeenCalledTimes(3);
    f.output.reconcileAt(clock('running', 5_000, 9, 'other'), false);
    expect(f.calls.at(-1)).toBe('prepare:g9:p3:plain');
    expect(f.now()).toMatchObject({ generation: 9, status: 'ready', positionMs: 5_000 });
  });

  it('stopped：宿主放开这首；换歌（手动从头待命不发 stopped）时新的 ready 直接准备，宿主自己先放开上一首', async () => {
    const f = recording();
    f.output.observe(clock('ready', 0)); await f.ready();
    f.output.observe(clock('stopped', 0));
    expect(f.calls.at(-1)).toBe('stop');
    expect(f.now()).toBeNull();
    f.output.observe(clock('ready', 0, 2, 'b'));
    await f.ready();
    f.output.observe(clock('ready', 0, 3, 'c'));
    expect(f.calls.slice(-2)).toEqual(['prepare:g2:p2:opening', 'prepare:g3:p3:opening']);
    expect(f.calls.filter(call => call === 'stop')).toHaveLength(1);
  });

  it('准备失败或宿主出错不抛给跟随：记一条运行日志，这首之后的位置不交；被下一首取代的准备不算失败', async () => {
    const f = recording();
    f.output.observe(clock('ready', 0));
    await f.refuse(new Error('MIDI 接口被占用'));
    expect(f.logs).toEqual(['error:跟随 P1 时动作 MIDI 没有准备好，这首歌这一段不发动作：MIDI 接口被占用']);
    expect(() => f.output.observe(clock('running', 66))).not.toThrow();
    expect(f.host.observe).not.toHaveBeenCalled();
    f.output.observe(clock('ready', 0, 2, 'b'));
    f.output.observe(clock('ready', 0, 3, 'c'));
    await f.refuse(new Error('MIDI 准备已被新的操作取消'), 1);
    expect(f.logs).toHaveLength(1);
    await f.ready();
    f.host.observe.mockImplementationOnce(() => { throw new Error('坏了'); });
    expect(() => f.output.observe(clock('running', 66, 3, 'c'))).not.toThrow();
    expect(f.logs.at(-1)).toBe('error:跟随 P1 时动作 MIDI 出错：坏了');
  });

  it('准备中冻结：宿主取消这次准备；准备结果晚到也不再交位置', async () => {
    const f = recording();
    f.output.observe(clock('ready', 0)); f.output.observe(clock('running', 66));
    f.output.hold();
    expect(f.calls).toEqual(['prepare:g1:p1:opening', 'stop']);
    await f.ready();
    expect(f.host.observe).not.toHaveBeenCalled();
  });

  it('宿主还在关上一首时冻结：那时它手里还没有这首，等准备好了再放开它', async () => {
    const f = recording(p1Project(), true);
    f.output.observe(clock('ready', 0)); f.output.observe(clock('running', 66));
    f.output.hold();
    expect(f.calls).toEqual(['prepare:g1:p1:opening']);
    await f.ready();
    expect(f.calls).toEqual(['prepare:g1:p1:opening', 'stop']);
    expect(f.host.observe).not.toHaveBeenCalled();
  });

  it('上一次准备的结果晚到：不放开、不打断同一首后来开始的准备', async () => {
    const f = recording();
    f.output.observe(clock('ready', 0)); f.output.observe(clock('running', 66));
    f.output.hold();
    f.output.reconcileAt(clock('running', 100, 2), false);
    await f.ready(0);
    expect(f.calls).toEqual(['prepare:g1:p1:opening', 'stop', 'prepare:g2:p2:plain']);
    await f.ready(1);
    expect(f.calls.at(-1)).toBe('observe:running@100');
  });
});

const NOTE: LinkAction = { id: 'note', label: '开场', kind: 'midi.noteOn', portProfileId: 'out', channel: 1, note: 60, velocity: 100 };

function p1Project(auto = false): LinkProject {
  const cues: { frame: number; action: LinkAction }[] = [
    { frame: 0, action: NOTE },
    { frame: 60, action: { id: 'pc2', label: 'PC 2', kind: 'midi.programChange', portProfileId: 'out', channel: 1, program: 2 } },
    { frame: 120, action: { id: 'pc3', label: 'PC 3', kind: 'midi.programChange', portProfileId: 'out', channel: 1, program: 3 } }
  ];
  const project = parseLinkProject({ ...createEmptyLinkProject('P1 动作 MIDI 宿主'), playbackSource: 'p1', rundown: [{ id: 'song', title: '歌曲',
    cues: cues.map((cue, index) => ({ id: `cue-${index}`, name: cue.action.label, timecode: frameNumberToTimecode(cue.frame, '30'), actions: [cue.action] })),
    referenceAudio: { assetId: 'audio', relativePath: 'assets/song.wav', sha256: 'a'.repeat(64), durationMs: 30_000 } }] });
  if (auto) project.p1AutoFollow = allocateP1TimecodeRanges(project);
  return project;
}

/** A real follow, adapter and host, with fake driver ports and the interface's clock as the host's now. */
function live(mode: 'manual' | 'auto') {
  const project = p1Project(mode === 'auto');
  let nowMs = 0;
  let audio: NativePlayerStatus | null = null;
  const ports = { prepare: vi.fn<() => Promise<void>>(() => Promise.resolve()), send: vi.fn<() => Promise<void>>(() => Promise.resolve()), close: vi.fn<() => Promise<void>>(() => Promise.resolve()) };
  const faults: string[] = [], errors: string[] = [], logs: string[] = [], recovered: ActionMidiRecovery[] = [];
  let failed: (error: Error) => void = () => undefined;
  const outputs = vi.fn<() => Promise<{ id: number; name: string }[]>>(() => Promise.resolve([{ id: 3, name: 'TBLINK CUE' }]));
  const host = new NativeMidiHost({ audio: () => audio, profile: () => null, executable: 'unused', now: () => nowMs, authorize: () => Promise.resolve(),
    ports: report => { failed = report; return ports; }, changed: () => undefined, error: message => errors.push(message),
    fault: message => faults.push(message), outputs, recovered: report => recovered.push(report) });
  const output = new P1MidiOutput(project, host, (level, message) => { logs.push(`${level}:${message}`); });
  const prepares: string[] = [];
  const follow = new P1FollowSession(project, mode, { outputs: output, prepare: (_itemId, sessionId) => { prepares.push(sessionId); },
    lights: { change: () => undefined, stop: () => undefined } });
  const start = mode === 'auto' ? project.p1AutoFollow!.ranges[0]!.startSeconds * FPS : 0;
  /** P1 playing `frames` frames from the song's frame `fromFrame`; the main process gets its turn after each whole timecode,
   * as when the quarter frames arrive over time. */
  const play = async (fromFrame: number, frames: number, startMs: number) => {
    let lastSampleMs = startMs;
    for (let offset = 0; offset < frames; offset += 2) {
      const tc = frameNumberToTimecode(start + fromFrame + offset, '30');
      const pieces = [tc.frames & 15, tc.frames >> 4, tc.seconds & 15, tc.seconds >> 4, tc.minutes & 15, tc.minutes >> 4, tc.hours & 15, (tc.hours >> 4) | (3 << 1)];
      for (const [type, value] of pieces.entries()) {
        // The host's now on the interface's 100 ns clock, as the time the follow reads.
        const ticks = BigInt(Math.round((startMs + (offset + type / 4) * FRAME_MS) * 10_000)), ms = Number(ticks) / 10_000;
        nowMs = ms;
        follow.message([0xf1, (type << 4) | value], ticks);
        if (type === 7) lastSampleMs = ms;
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    return { endMs: startMs + frames * FRAME_MS, lastSampleMs };
  };
  const idle = (ms: number) => { nowMs = ms; follow.idle(BigInt(Math.round(ms * 10_000))); };
  const sent = () => ports.send.mock.calls.map(call => (call as unknown[])[1]);
  const unplug = () => failed(new MidiOutputFailure('MIDI 输出失败：接口已断开（错误码 6）', 6, 'TBLINK CUE'));
  return { host, follow, ports, faults, errors, logs, recovered, outputs, prepares, play, idle, sent, unplug, setAudio: (status: NativePlayerStatus | null) => { audio = status; } };
}

describe('P1 跟随的动作 MIDI · 经共用宿主实际发出去的（P3d）', () => {
  it('开场：P1 放了 1 秒才准备好，开头的 Note On 照发一次，不标红，运行日志一行写明几条、晚多少；之后照常', async () => {
    const f = live('auto');
    f.follow.arm(null);
    const first = await f.play(0, 30, 1_000);
    f.follow.prepared(f.prepares[0]!);
    await vi.waitFor(() => expect(f.sent()).toEqual([[0x90, 60, 100]]));
    expect(f.host.status?.state).toBe('running');
    const on = await f.play(30, 40, first.endMs);
    await vi.waitFor(() => expect(f.sent()).toEqual([[0x90, 60, 100], [0xc0, 2]]));
    expect(f.faults).toEqual([]); expect(f.errors).toEqual([]);
    expect(f.logs).toEqual([expect.stringMatching(/^info:开始跟随：歌曲开头到第一个位置的 1 条 MIDI 动作一起发送，最晚的比歌里的时间晚了 1\d{3} ms$/)]);
    await f.play(70, 60, on.endMs);
    await vi.waitFor(() => expect(f.sent()).toHaveLength(3));
    await f.host.stop();
  });

  it('联动台播放那边来了别的会话的时钟：P1 这首歌在哪由 P1 说了算，动作 MIDI 不停', async () => {
    const f = live('manual');
    f.follow.arm('song');
    const first = await f.play(0, 10, 1_000);
    await vi.waitFor(() => expect(f.host.status?.state).toBe('running'));
    const other = nativeStatus();
    f.setAudio(other);
    f.host.observe(clockFromNativeStatus(other, '10000000'));
    expect(f.host.status?.state).toBe('running');
    await f.play(10, 60, first.endMs);
    await vi.waitFor(() => expect(f.sent()).toEqual([[0x90, 60, 100], [0xc0, 2]]));
    await f.host.stop();
  });

  it('自动：P1 暂停后从同一位置继续，停下的位置和继续的位置之间的动作照晚到规则发一次；暂停前发过的不再发', async () => {
    const f = live('auto');
    f.follow.arm(null);
    const first = await f.play(0, 2, 1_000);
    f.follow.prepared(f.prepares[0]!);
    // P1 stops after the frame 54 it encodes (position 56) and goes on from 58 (position 60): the PC at 60 is in the gap.
    const on = await f.play(2, 54, first.endMs);
    await vi.waitFor(() => expect(f.sent()).toEqual([[0x90, 60, 100]]));
    f.idle(on.lastSampleMs + 600);
    expect(f.follow.view.phase).toBe('frozen');
    await vi.waitFor(() => expect(f.host.status).toBeNull());
    await f.play(58, 10, on.lastSampleMs + 5_000);
    await vi.waitFor(() => expect(f.sent()).toEqual([[0x90, 60, 100], [0xc0, 2]]));
    expect(f.follow.view.phase).toBe('running');
    expect(f.faults).toEqual([]);
    await f.host.stop();
  });

  it('手动：重同步是新的一遍，重同步位置之前的动作不补', async () => {
    const f = live('manual');
    f.follow.arm('song');
    const first = await f.play(0, 30, 1_000);
    f.idle(first.lastSampleMs + 600);
    const back = await f.play(70, 30, first.lastSampleMs + 1_000);
    f.follow.resync();
    await f.play(100, 30, back.endMs);
    await vi.waitFor(() => expect(f.sent()).toEqual([[0x90, 60, 100], [0xc0, 3]]));
    await f.host.stop();
  });

  it('手动：待命时 P1 已经放过开头（还在等就冻结了），重同步在宿主上从这个位置开始这首；之前的动作一条不补', async () => {
    const f = live('manual');
    f.follow.arm('song');
    // P1 is at 2.33 s when armed, past the Note On at 0 and the PC at 60: frozen while still waiting, the host holds nothing.
    const waited = await f.play(70, 20, 1_000);
    expect(f.follow.view).toMatchObject({ phase: 'frozen', cause: 'not-from-start' });
    expect(f.host.status).toBeNull();
    f.follow.resync();
    await f.play(90, 40, waited.endMs);
    await vi.waitFor(() => expect(f.sent()).toEqual([[0xc0, 3]]));
    expect(f.host.status?.state).toBe('running');
    expect(f.ports.prepare).toHaveBeenCalledTimes(1);
    expect(f.faults).toEqual([]); expect(f.errors).toEqual([]);
    // Not the start of a follow: no opening catch-up line.
    expect(f.logs).toEqual([]);
    await f.host.stop();
  });

  it('动作 MIDI 接口断开又回来（2026-10-24）：跟随不停，同一接口回来后从 P1 当前位置接着发，中断期间的不补', async () => {
    const f = live('manual');
    f.follow.arm('song');
    const first = await f.play(0, 10, 1_000);
    await vi.waitFor(() => expect(f.sent()).toEqual([[0x90, 60, 100]]));
    f.outputs.mockResolvedValue([]);
    f.unplug();
    expect(f.faults).toEqual(['MIDI 输出失败：接口已断开（错误码 6）']);
    const gone = await f.play(10, 60, first.endMs);
    expect(f.follow.view.phase).toBe('running');
    f.outputs.mockResolvedValue([{ id: 4, name: 'TBLINK CUE' }]);
    let at = gone.endMs, frame = 70;
    // P1 plays on while the port is looked for again.
    await vi.waitFor(async () => { const step = await f.play(frame, 2, at); at = step.endMs; frame += 2; expect(f.recovered).toHaveLength(1); }, { timeout: 5000, interval: 200 });
    expect(f.recovered[0]).toMatchObject({ portName: 'TBLINK CUE', skippedActions: 1 });
    expect(frame).toBeLessThan(118);
    await f.play(frame, 120 - frame + 4, at);
    await vi.waitFor(() => expect(f.sent()).toEqual([[0x90, 60, 100], [0xc0, 3]]));
    expect(f.ports.prepare).toHaveBeenCalledTimes(2);
    await f.host.stop();
  }, 10_000);
});

function nativeStatus(): NativePlayerStatus {
  return { version: 1, sessionId: '9b081ed2-7f76-44c8-9c45-b0e06e860870', generation: 4, itemId: 'song', status: 'stopped', positionMs: 0, offsetMs: 0,
    sampleRate: 48000, enginePid: 1, engineTitle: '验收', mtcPortName: null, mtcSent: 0, audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0,
    gain: 1, analysis: null };
}
