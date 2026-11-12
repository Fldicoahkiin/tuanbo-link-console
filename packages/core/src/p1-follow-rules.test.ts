import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkProject } from '@tb/schema';
import { frameNumberToTimecode } from './mtc-timecode';
import { allocateP1TimecodeRanges } from './p1-auto-follow';
import { P1Clock, type P1ClockEvent } from './p1-clock';
import { createLightingDocument, lightingDocumentSchema, lightingMa2BindingSchema, lightingTrackSchema, nativePlayerStatusSchema, type LightingDocument, type LinkAction,
  type Ma2PlaybackAction, type NativePlayerStatus } from '@tb/schema';
import { MidiMessageSkipped } from './midi-late-rule';
import { MidiProgramSession } from './midi-program';
import { litChangeOffs, litReleaseActions } from './lighting-off-ledger';
import type { LitSong } from './program-player';
import type { OutputMode } from './output-failure';
import { P1FollowSession, type P1FollowLights, type P1FollowOutputs } from './p1-follow-session';
import { clockFromNativeStatus, type ProgramClock } from './program-clock';

/**
 * P1 follow rules (AGENTS §4.9; design 03 §7.1, 2026-11-10 "P1 跟随搬到后台"). Part 1 (step P2):
 * the timecode is judged on the MIDI interface's own time, a jump or an unknown range freezes and
 * nothing is sent later, auto-follow starts a new session or resumes, manual mode only resyncs on the
 * operator's word. Parts 2 and 3 (P3, P4) add shared outputs and the source scans here.
 * Every time below is an interface timestamp passed in; no test waits on a real clock.
 */

const FPS = 30;
const FRAME_MS = 1000 / FPS;
/** For the rules where the lights do not matter. */
const NO_LIGHTS: P1FollowLights = { change: () => undefined, stop: () => undefined };
/** For the rules where the outputs do not matter. */
const NO_OUTPUTS: P1FollowOutputs = { observe: () => undefined, hold: () => undefined, reconcileAt: () => undefined };

afterEach(() => { vi.restoreAllMocks(); });

describe('P1 跟随规则 · 断码按接口时间判断（03 §4.1.2，不按界面线程什么时候处理到）', () => {
  it('① 一批消息晚到但接口时间戳连续：不算断码，时钟一直在走', () => {
    const clock = new P1Clock(manualProject(), 'manual');
    clock.arm('song');
    // Whatever the page's or main process's clock says, the whole 3 s of P1 arrives in one batch.
    vi.spyOn(performance, 'now').mockReturnValue(9_999_999);
    vi.spyOn(Date, 'now').mockReturnValue(9_999_999);
    const { events } = play(clock, 0, 90, 1_000);
    expect(kinds(events).filter(kind => kind !== 'clock')).toEqual([]);
    expect(events.length).toBeGreaterThan(40);
    expect(clock.state.phase).toBe('running');
  });

  it('② 接口时间 600 ms 没有四分之一帧（心跳还在）：断码，冻结自动 Cue', () => {
    const clock = new P1Clock(manualProject(), 'manual');
    clock.arm('song');
    const { lastSampleMs } = play(clock, 0, 30, 1_000);
    for (const ms of [100, 200, 300, 400, 490]) expect(clock.idle(at(lastSampleMs + ms))).toEqual([]);
    expect(clock.state.phase).toBe('running');
    expect(clock.idle(at(lastSampleMs + 600))).toEqual([{ kind: 'frozen', cause: 'lost', reason: 'MTC 信号中断' }]);
    expect(clock.state).toMatchObject({ phase: 'frozen', cause: 'lost', itemId: 'song' });
    // Frozen means frozen: the timecode coming back sends no clock until the operator acts.
    expect(kinds(play(clock, 60, 30, lastSampleMs + 700).events)).toEqual([]);
  });
});

describe('P1 跟随规则 · 中途跳变和未知区间冻结，不猜、不补执行（AGENTS §4.9）', () => {
  it('③ 跳变超过 250 ms：冻结；之后不补发中间的位置', () => {
    const clock = new P1Clock(manualProject(), 'manual');
    clock.arm('song');
    const first = play(clock, 0, 30, 1_000);
    // 6 frames (200 ms) ahead is within MTC_JUMP_MS and keeps running.
    const small = play(clock, 36, 30, first.endMs);
    expect(kinds(small.events).every(kind => kind === 'clock')).toBe(true);
    // 15 frames (500 ms) ahead on a continuous interface clock is a jump.
    const jump = play(clock, 66 + 15, 30, small.endMs);
    expect(jump.events[0]).toEqual({ kind: 'frozen', cause: 'jump', reason: 'MTC 时间跳变' });
    expect(kinds(jump.events.slice(1))).toEqual([]);
    expect(clock.state).toMatchObject({ phase: 'frozen', cause: 'jump', positionMs: 66 * 1000 / FPS });
    // Backwards is a jump too.
    const back = new P1Clock(manualProject(), 'manual');
    back.arm('song');
    const ahead = play(back, 0, 60, 1_000);
    expect(play(back, 20, 8, ahead.endMs).events[0]).toEqual({ kind: 'frozen', cause: 'jump', reason: 'MTC 时间倒退' });
  });

  it('④ 自动选歌时落在任何歌曲都没有的区间：冻结，不按最近的歌猜', () => {
    const project = autoProject();
    const clock = new P1Clock(project, 'auto');
    clock.arm(null);
    const a = play(clock, songFrame(project, 'a'), 60, 1_000);
    expect(clock.state.phase).toBe('running');
    // P1 jumps into the gap between song a and song b.
    const gap = play(clock, songFrame(project, 'b') - 5 * FPS, 60, a.endMs);
    expect(gap.events[0]).toMatchObject({ kind: 'frozen', cause: 'unknown-range' });
    expect(kinds(gap.events.slice(1))).toEqual([]);
    // Playing on from there into song b's middle is still not a start: nothing is guessed.
    expect(kinds(play(clock, songFrame(project, 'b') + 10 * FPS, 60, gap.endMs).events)).toEqual([]);
    expect(clock.state).toMatchObject({ phase: 'frozen', cause: 'unknown-range' });
  });
});

describe('P1 跟随规则 · 自动选歌：P1 点歌或重播开新会话，同位置继续就恢复（AGENTS §4.9）', () => {
  it('⑤ P1 从另一首开头放是新会话；同一首从停下的位置继续（≤ fps/4）是 resumed', () => {
    const project = autoProject();
    const clock = new P1Clock(project, 'auto');
    clock.arm(null);
    const a = play(clock, songFrame(project, 'a'), 60, 1_000);
    const songA = a.events[0];
    expect(songA).toMatchObject({ kind: 'song', itemId: 'a' });
    const sessionA = songA?.kind === 'song' ? songA.sessionId : '';
    // P1 clicks song b: plays it from its head.
    const b = play(clock, songFrame(project, 'b'), 60, a.endMs + 200);
    expect(b.events[0]).toMatchObject({ kind: 'song', itemId: 'b' });
    expect(b.events[0]?.kind === 'song' && b.events[0].sessionId).not.toBe(sessionA);
    expect(clock.state).toMatchObject({ phase: 'running', clock: { itemId: 'b' } });
    // P1 pauses (the heartbeat goes on), then plays on from the same place.
    expect(clock.idle(at(b.lastSampleMs + 600))).toMatchObject([{ kind: 'frozen', cause: 'lost' }]);
    const before = clock.state.phase === 'frozen' ? clock.state.positionMs : -1;
    const lastFrame = Math.round(before / FRAME_MS) + songFrame(project, 'b');
    const resumed = play(clock, lastFrame + 5 - 2, 8, b.lastSampleMs + 3_000);
    expect(resumed.events[0]).toMatchObject({ kind: 'resumed', clock: { itemId: 'b', sessionId: b.events[1]?.kind === 'clock' ? b.events[1].clock.sessionId : '' } });
    expect(clock.state.phase).toBe('running');
    // Going on further than fps/4 is not the same place: frozen until P1 plays a song from its head.
    expect(clock.idle(at(resumed.lastSampleMs + 600))).toMatchObject([{ kind: 'frozen', cause: 'lost' }]);
    const resumedFrame = Math.round((clock.state.phase === 'frozen' ? clock.state.positionMs : 0) / FRAME_MS) + songFrame(project, 'b');
    const far = play(clock, resumedFrame + 8 - 2, 30, resumed.lastSampleMs + 3_000);
    expect(far.events[0]).toMatchObject({ kind: 'frozen', cause: 'jump' });
    expect(kinds(far.events.slice(1))).toEqual([]);
    // Another song from its middle is not a start either.
    expect(play(clock, songFrame(project, 'a') + 10 * FPS, 30, far.endMs).events).toEqual([]);
    // P1 replays song b from its head: a new session.
    const replay = play(clock, songFrame(project, 'b'), 30, far.endMs + 5_000);
    expect(replay.events[0]).toMatchObject({ kind: 'song', itemId: 'b' });
    expect(replay.events[0]?.kind === 'song' && replay.events[0].sessionId).not.toBe(b.events[0]?.kind === 'song' && b.events[0].sessionId);
  });
});

describe('P1 跟随规则 · 手动模式要明确重同步（AGENTS §4.9）', () => {
  it('⑥ 断码后时间码回到同一位置也不自己恢复，只有操作员重同步才 resynced', () => {
    const clock = new P1Clock(manualProject(), 'manual');
    clock.arm('song');
    const first = play(clock, 0, 60, 1_000);
    expect(clock.idle(at(first.lastSampleMs + 600))).toMatchObject([{ kind: 'frozen', cause: 'lost' }]);
    // The timecode returns right where it stopped: still frozen, no resumed, no clock.
    const again = play(clock, 60, 30, first.lastSampleMs + 2_000);
    expect(again.events).toEqual([]);
    expect(clock.state.phase).toBe('frozen');
    const events = clock.resync();
    expect(events).toMatchObject([{ kind: 'resynced', clock: { itemId: 'song', positionMs: 90 * 1000 / FPS } }]);
    expect(clock.state.phase).toBe('running');
    expect(kinds(play(clock, 90, 30, again.endMs).events).every(kind => kind === 'clock')).toBe(true);
    // Auto-follow has no operator resync: P1 decides.
    const auto = new P1Clock(autoProject(), 'auto');
    expect(() => auto.resync()).toThrow(/P1 恢复/);
  });
});

function manualProject(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('P1 手动跟随'), playbackSource: 'p1', rundown: [{ id: 'song', title: '歌曲', cues: [] }] });
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

function kinds(events: readonly P1ClockEvent[]): string[] { return events.map(event => event.kind); }

/** P1 playing `frames` frames from `fromFrame` at 30 fps: one quarter frame every quarter of a
 * frame, eight per two frames, stamped on the interface's clock starting at `startMs`. */
function play(clock: P1Clock, fromFrame: number, frames: number, startMs: number): { events: P1ClockEvent[]; endMs: number; lastSampleMs: number } {
  const events: P1ClockEvent[] = [];
  let ms = startMs, lastSampleMs = startMs;
  for (let offset = 0; offset < frames; offset += 2) {
    const tc = frameNumberToTimecode(fromFrame + offset, '30');
    const pieces = [tc.frames & 15, tc.frames >> 4, tc.seconds & 15, tc.seconds >> 4, tc.minutes & 15, tc.minutes >> 4, tc.hours & 15, (tc.hours >> 4) | (3 << 1)];
    for (const [type, value] of pieces.entries()) {
      ms = startMs + (offset + type / 4) * FRAME_MS;
      const produced = clock.message([0xf1, (type << 4) | value], at(ms));
      if (type === 7) lastSampleMs = ms;
      events.push(...produced);
    }
  }
  return { events, endMs: startMs + frames * FRAME_MS, lastSampleMs };
}

/*
 * Part 2 (step P3, design 03 §7.1 ⑦–⑩): P1 follow drives the same outputs as the internal player. The action MIDI path
 * is checked here: one MIDI output, fed the clocks of `P1FollowSession` (P1's MTC) or `clockFromNativeStatus` (the
 * internal player), runs the shared `MidiProgramSession`. The picture path waits for R9 (todos below).
 */

const NOTE: LinkAction = { id: 'note', label: '开场', kind: 'midi.noteOn', portProfileId: 'out', channel: 1, note: 60, velocity: 100, durationMs: 100 };
const CUES: { frame: number; action: LinkAction }[] = [
  { frame: 0, action: NOTE },
  { frame: 15, action: { id: 'cc', label: '推子', kind: 'midi.controlChange', portProfileId: 'out', channel: 2, controller: 7, value: 64 } },
  { frame: 45, action: { ...NOTE, id: 'note-45', label: '主歌', note: 62 } },
  { frame: 75, action: { id: 'pc', label: '换音色', kind: 'midi.programChange', portProfileId: 'out', channel: 1, program: 5 } },
  { frame: 100, action: { id: 'go', label: '副歌', kind: 'midi.showControl', portProfileId: 'out', deviceId: 0x7f, commandFormat: 0x01, command: 'go', cueNumber: '3' } }
];
const BYTES = { note: [0x90, 60, 100], noteOff: [0x80, 60, 0], cc: [0xb1, 7, 64], note45: [0x90, 62, 100], note45Off: [0x80, 62, 0], pc: [0xc0, 5],
  go: [0xf0, 0x7f, 0x7f, 0x02, 0x01, 0x01, 0x33, 0xf7] };

describe('P1 跟随规则 · 共用一套输出（03 §7.1 ⑦，动作 MIDI）', () => {
  it('⑦ 同一个工程、同一串位置：经 P1 的时间码和经联动台播放的时钟，动作 MIDI 发出去的完全一样', async () => {
    const project = midiProject();
    const p1 = midiOutput(project, 'live');
    const follow = new P1FollowSession(project, 'manual', { outputs: p1.outputs, prepare: () => undefined, lights: NO_LIGHTS });
    follow.arm('song');
    playFollow(follow, 0, 120, 1_000);
    await p1.settled();
    // The internal player at the same positions and times: ready at the head, then playing. A decoded MTC position is
    // two frames after the frame its pieces encode, complete with the last piece.
    const internal = midiOutput(project, 'live');
    internal.outputs.observe(clockFromNativeStatus(playerStatus('ready', 0), null));
    for (let frame = 0; frame < 120; frame += 2) {
      internal.outputs.observe(clockFromNativeStatus(playerStatus('playing', (frame + 2) * 1000 / FPS), qpc(1_000 + (frame + 1.75) * FRAME_MS)));
    }
    await internal.settled();
    expect(p1.sent.map(entry => entry.bytes)).toEqual([BYTES.note, BYTES.noteOff, BYTES.cc, BYTES.note45, BYTES.note45Off, BYTES.pc, BYTES.go]);
    expect(p1.sent).toEqual(internal.sent);
    expect(p1.problems).toEqual([]); expect(internal.problems).toEqual([]);
  });

  it.todo('⑦ 画面：同一串位置经两种时钟，OBS 请求完全相同（等 R9：画面会话收 P1 的时钟，obs-program-session.ts 去掉按来源的拒绝）');
});

describe('P1 跟随规则 · 重同步和同位置继续不补点动作（03 §7.1 ⑧，AGENTS §4.9）', () => {
  it('⑧ 手动：断码期间一条不发，时间码回来也不发；重同步以后，过去的动作不补，后面的照发', async () => {
    const project = midiProject();
    const out = midiOutput(project, 'live');
    const follow = new P1FollowSession(project, 'manual', { outputs: out.outputs, prepare: () => undefined, lights: NO_LIGHTS });
    follow.arm('song');
    const first = playFollow(follow, 0, 30, 1_000);
    follow.idle(at(first.lastSampleMs + 600));
    // P1 went on meanwhile: frames 60–90 come back, past the actions at 45 and 75.
    const back = playFollow(follow, 60, 30, first.lastSampleMs + 1_000);
    await out.settled();
    expect(out.sent.map(entry => entry.bytes)).toEqual([BYTES.note, BYTES.noteOff, BYTES.cc]);
    follow.resync();
    playFollow(follow, 90, 30, back.endMs);
    await out.settled();
    expect(out.sent.map(entry => entry.bytes)).toEqual([BYTES.note, BYTES.noteOff, BYTES.cc, BYTES.go]);
    expect(out.problems).toEqual([]);
  });

  it('⑧ 自动选歌：P1 暂停后从同一位置继续，之后的动作照发；暂停期间没有动作被补发', async () => {
    const project = midiProject(true);
    const out = midiOutput(project, 'live');
    const prepares: string[] = [];
    const follow = new P1FollowSession(project, 'auto', { outputs: out.outputs, prepare: (_itemId, sessionId) => { prepares.push(sessionId); }, lights: NO_LIGHTS });
    follow.arm(null);
    const start = project.p1AutoFollow!.ranges[0]!.startSeconds * FPS;
    // Prepared right after the first position (a slow preparation makes the opening actions late: see the late rule).
    const first = playFollow(follow, start, 2, 1_000);
    follow.prepared(prepares[0]!);
    const on = playFollow(follow, start + 2, 38, first.endMs);
    follow.idle(at(on.lastSampleMs + 600));
    playFollow(follow, start + 40, 70, on.lastSampleMs + 5_000);
    await out.settled();
    expect(follow.view.phase).toBe('running');
    expect(out.sent.map(entry => entry.bytes)).toEqual([BYTES.note, BYTES.noteOff, BYTES.cc, BYTES.note45, BYTES.note45Off, BYTES.pc, BYTES.go]);
    expect(out.problems).toEqual([]);
  });

  it('⑧ 开场：P1 先放、联动台准备好才跟上，歌曲开头到第一个跟上的位置之间的动作随它发一次，不算晚、不标红；之后照晚到规则', async () => {
    const project = midiProject(true);
    const lines: string[] = [];
    const out = midiOutput(project, 'live', () => false, line => { lines.push(line); });
    const prepares: string[] = [];
    const follow = new P1FollowSession(project, 'auto', { outputs: out.outputs, prepare: (_itemId, sessionId) => { prepares.push(sessionId); }, lights: NO_LIGHTS });
    follow.arm(null);
    const start = project.p1AutoFollow!.ranges[0]!.startSeconds * FPS;
    // The preparation takes a second: P1 is at frame 32 when 联动台 follows, past the Note On at 0 and the CC at 15.
    const first = playFollow(follow, start, 30, 1_000);
    follow.prepared(prepares[0]!);
    await out.settled();
    expect(out.sent.map(entry => entry.bytes)).toEqual([BYTES.note, BYTES.noteOff, BYTES.cc]);
    expect(out.problems).toEqual([]);
    expect(lines).toEqual([expect.stringMatching(/^开始跟随：歌曲开头到第一个位置的 3 条 MIDI 动作一起发送，最晚的比歌里的时间晚了 \d+ ms$/)]);
    // After the opening the late rule is unchanged: P1 skips ahead (within what is not a jump), so the Note On at frame
    // 45 is due 166 ms before the position that reaches it, and is skipped and marked red as for any output.
    const on = playFollow(follow, start + 30, 12, first.endMs);
    playFollow(follow, start + 48, 10, on.endMs);
    await out.settled();
    expect(follow.view.phase).toBe('running');
    expect(out.sent.map(entry => entry.bytes)).toEqual([BYTES.note, BYTES.noteOff, BYTES.cc]);
    expect(out.problems).toEqual(['播放位置更新中断，错过了 1 个 MIDI 动作，没有补发']);
    expect(lines).toHaveLength(1);
  });

  it.todo('⑧ 画面：重同步或同位置继续后，此刻的机位和素材出现在 OBS（等 R9：画面会话的 reconcileAt）');
});

describe('P1 跟随规则 · 换歌关灯（03 §7.1 ⑨）', () => {
  it('⑨ 自动选歌：P1 换歌只关上一首独有的执行器；P1 自己停、断码、等下一首都不关；在联动台按停止关这首的，P1 照放', () => {
    const project = autoProject();
    const lights = lightsOn({ a: ['1.101', '1.102'], b: ['1.102', '1.103'] });
    const prepares: string[] = [];
    const follow = new P1FollowSession(project, 'auto', { outputs: NO_OUTPUTS, prepare: (_itemId, sessionId) => { prepares.push(sessionId); }, lights: lights.lights });
    // Waiting for P1's song sends nothing.
    follow.arm(null);
    expect(lights.offs).toEqual([]);
    const a = playFollow(follow, songFrame(project, 'a'), 30, 1_000);
    follow.prepared(prepares[0]!);
    expect(follow.view).toMatchObject({ phase: 'running', itemId: 'a' });
    // P1 stops by itself: the timecode is lost, nothing goes off; the input going away neither.
    follow.idle(at(a.lastSampleMs + 600));
    expect(follow.view.phase).toBe('frozen');
    expect(lights.offs).toEqual([]);
    // P1 plays song b from its head: only what a has alone goes off.
    const b = playFollow(follow, songFrame(project, 'b'), 30, a.lastSampleMs + 2_000);
    follow.prepared(prepares[1]!);
    expect(follow.view).toMatchObject({ phase: 'running', itemId: 'b' });
    expect(lights.offs).toEqual([['1.101']]);
    // P1 replays b from its head: the same song, nothing it uses goes off.
    const replay = playFollow(follow, songFrame(project, 'b'), 30, b.endMs + 1_000);
    follow.prepared(prepares[2]!);
    expect(lights.offs).toEqual([['1.101']]);
    // The operator stops following in 联动台: b's executors go off; P1 plays on and nothing more is sent.
    follow.stop('stop');
    expect(lights.offs).toEqual([['1.101'], ['1.102', '1.103']]);
    playFollow(follow, songFrame(project, 'b') + 30, 30, replay.endMs);
    follow.inputGone();
    expect(lights.offs).toEqual([['1.101'], ['1.102', '1.103']]);
    expect(lights.causes).toEqual(['stop']);
  });

  it('⑨ 手动：待命不关；第一个位置起控台跑这首；断码、重新待命都不关；关掉跟随关这首的；停在待命时什么都不关', () => {
    const lights = lightsOn({ song: ['1.201'] });
    const follow = new P1FollowSession(manualProject(), 'manual', { outputs: NO_OUTPUTS, prepare: () => undefined, lights: lights.lights });
    follow.arm('song');
    follow.stop('stop');
    expect(lights.calls).toEqual([]);
    follow.arm('song');
    const first = playFollow(follow, 0, 30, 1_000);
    expect(lights.calls).toEqual(['change null→song']);
    follow.idle(at(first.lastSampleMs + 600));
    follow.rearm();
    playFollow(follow, 0, 30, first.lastSampleMs + 2_000);
    expect(lights.offs).toEqual([]);
    follow.stop('close');
    expect(lights.offs).toEqual([['1.201']]);
    expect(lights.causes).toEqual(['close']);
  });
});

describe('P1 跟随规则 · 排练和直播（03 §7.1 ⑩，AGENTS §4.8）', () => {
  it('⑩ 动作 MIDI：排练时第一条没发出的动作挡住后面的（松开照发）；直播时只这一条没发，后面照发', async () => {
    const run = async (mode: OutputMode) => {
      const project = midiProject();
      const out = midiOutput(project, mode, bytes => bytes[0] === 0xb1);
      const follow = new P1FollowSession(project, 'manual', { outputs: out.outputs, prepare: () => undefined, lights: NO_LIGHTS });
      follow.arm('song');
      playFollow(follow, 0, 120, 1_000);
      await out.settled();
      return out;
    };
    const rehearsal = await run('rehearsal');
    expect(rehearsal.sent.map(entry => entry.bytes)).toEqual([BYTES.note, BYTES.noteOff]);
    expect(rehearsal.problems.some(problem => problem.includes('不再发送'))).toBe(true);
    const live = await run('live');
    expect(live.sent.map(entry => entry.bytes)).toEqual([BYTES.note, BYTES.noteOff, BYTES.note45, BYTES.note45Off, BYTES.pc, BYTES.go]);
    expect(live.problems.some(problem => problem.includes('推子'))).toBe(true);
  });

  it.todo('⑩ 画面：排练时第一个失败挡住这一路后面的画面动作，直播标红继续（等 R9）');
});

function midiProject(auto = false): LinkProject {
  const project = parseLinkProject({ ...createEmptyLinkProject('P1 动作 MIDI'), playbackSource: 'p1', rundown: [{ id: 'song', title: '歌曲',
    cues: CUES.map((cue, index) => ({ id: `cue-${index}`, name: cue.action.label, timecode: frameNumberToTimecode(cue.frame, '30'), actions: [cue.action] })),
    referenceAudio: { assetId: 'audio', relativePath: 'assets/song.wav', sha256: 'a'.repeat(64), durationMs: 30_000 } }] });
  if (auto) project.p1AutoFollow = allocateP1TimecodeRanges(project);
  return project;
}

function playerStatus(status: 'ready' | 'playing', positionMs: number): NativePlayerStatus {
  return nativePlayerStatusSchema.parse({
    version: 1, sessionId: '6f1c2b0e-8a8d-4c47-9a38-0d6a51f1f6a1', generation: 1, itemId: 'song', status, positionMs,
    offsetMs: 0, sampleRate: 48000, enginePid: null, engineTitle: null, mtcPortName: null, mtcSent: 0, audioError: null, mtcError: null,
    underruns: 0, mtcInterruptions: 0, gain: 1, analysis: null
  });
}

function qpc(ms: number): string { return String(Math.round(ms * 10_000)); }

/** `play` for a whole follow: the same quarter frames on the interface's clock. */
function playFollow(follow: P1FollowSession, fromFrame: number, frames: number, startMs: number): { endMs: number; lastSampleMs: number } {
  let lastSampleMs = startMs;
  for (let offset = 0; offset < frames; offset += 2) {
    const tc = frameNumberToTimecode(fromFrame + offset, '30');
    const pieces = [tc.frames & 15, tc.frames >> 4, tc.seconds & 15, tc.seconds >> 4, tc.minutes & 15, tc.minutes >> 4, tc.hours & 15, (tc.hours >> 4) | (3 << 1)];
    for (const [type, value] of pieces.entries()) {
      const ms = startMs + (offset + type / 4) * FRAME_MS;
      follow.message([0xf1, (type << 4) | value], at(ms));
      if (type === 7) lastSampleMs = ms;
    }
  }
  return { endMs: startMs + frames * FRAME_MS, lastSampleMs };
}

/**
 * One action MIDI output as the shared host drives it: `ready` (or a reconcile) opens a session at that position, a
 * running clock sends what is due, a hold or a stop closes it. Both clocks go through this same output, so equal sends
 * mean equal clocks for the outputs. The session is built from the P1 project itself (P3d). `opening`: a `ready` opens
 * it as the start of a follow (MidiProgramSession.prepare `opening`), as the P1 adapter of the main process does.
 */
function midiOutput(project: LinkProject, mode: OutputMode, refuse: (bytes: readonly number[]) => boolean = () => false, opening?: (message: string) => void) {
  const sent: { bytes: number[]; deadlineAtMs: number }[] = [], problems: string[] = [];
  let now = 0, session: MidiProgramSession | null = null, tail: Promise<unknown> = Promise.resolve();
  const close = (): void => {
    const current = session; session = null;
    if (current) tail = tail.then(() => current.close());
  };
  const open = (clock: ProgramClock, starts: boolean): void => {
    close();
    const opened = session = new MidiProgramSession(project, clock.itemId, {
      prepare: () => Promise.resolve(), close: () => Promise.resolve(), now: () => now, sent: () => undefined,
      send: (_port, bytes, deadlineAtMs) => {
        if (refuse(bytes)) return Promise.reject(new MidiMessageSkipped('接口拒绝了这一条', -7));
        sent.push({ bytes: [...bytes], deadlineAtMs });
        return Promise.resolve();
      },
      missed: message => { problems.push(message); }, late: message => { problems.push(message); }, failed: error => { problems.push(error.message); }
    }, mode);
    tail = tail.then(() => opened.prepare(clock.positionMs, undefined, starts ? opening : undefined));
  };
  const tick = (clock: ProgramClock): void => {
    const current = session, observedAtMs = clock.observedAtMs;
    if (!current || observedAtMs === null) return;
    tail = tail.then(() => { now = observedAtMs; current.clock(clock.positionMs, observedAtMs); return current.settled(); });
  };
  const outputs: P1FollowOutputs = {
    observe: clock => {
      switch (clock.state) {
        case 'ready': open(clock, true); return;
        case 'running': case 'ended': tick(clock); return;
        case 'held': case 'lost': case 'stopped': close(); return;
      }
    },
    hold: close,
    reconcileAt: clock => { open(clock, false); tick(clock); }
  };
  return { sent, problems, settled: () => tail, outputs };
}

/** The follow's lights as the main process turns them into Offs (p1-follow-wiring.ts followLights, through the one
 * ledger's rules): `executors` is what each song's console timeline runs. */
function lightsOn(executors: Record<string, string[]>) {
  const offs: string[][] = [], causes: string[] = [], calls: string[] = [];
  const song = (itemId: string): LitSong => ({ document: lightingWith(executors[itemId] ?? []), song: { itemId, title: itemId } });
  const names = (actions: readonly Ma2PlaybackAction[]): string[] => actions.flatMap(action => action.target === 'executor' ? [action.executor] : []);
  const lights: P1FollowLights = {
    change: (previous, next) => {
      calls.push(`change ${previous ?? 'null'}→${next}`);
      if (previous === null) return;
      const sends = names(litChangeOffs(song(previous), song(next)));
      if (sends.length > 0) offs.push(sends);
    },
    stop: (itemId, cause) => { calls.push(`stop ${itemId}`); causes.push(cause); offs.push(names(litReleaseActions(song(itemId)))); }
  };
  return { lights, offs, causes, calls };
}

function lightingWith(executors: string[]): LightingDocument {
  const track = (index: number) => lightingTrackSchema.parse({ id: `track-${index}`, name: `Track ${index}`, kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false,
    locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [] });
  const binding = lightingMa2BindingSchema.parse({ id: 'binding', timecode: 1, name: '歌曲', readAt: '2026-11-11T00:00:00.000Z', sourceXml: '<MA/>',
    baselineTracks: executors.map((_executor, index) => track(index)), mappings: [],
    trackMappings: executors.map((executor, index) => ({ trackId: `track-${index}`, path: `Track ${index}`, executor, subtracks: [] })) });
  return lightingDocumentSchema.parse({ ...createLightingDocument(), ma2Bindings: [binding] });
}
