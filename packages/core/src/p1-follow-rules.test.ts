import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkProject } from '@tb/schema';
import { frameNumberToTimecode } from './mtc-timecode';
import { allocateP1TimecodeRanges } from './p1-auto-follow';
import { P1Clock, type P1ClockEvent } from './p1-clock';

/**
 * P1 follow rules (AGENTS §4.9; design 03 §7.1, 2026-11-10 "P1 跟随搬到后台"). Part 1 (step P2):
 * the timecode is judged on the MIDI interface's own time, a jump or an unknown range freezes and
 * nothing is sent later, auto-follow starts a new session or resumes, manual mode only resyncs on the
 * operator's word. Parts 2 and 3 (P3, P4) add shared outputs and the source scans here.
 * Every time below is an interface timestamp passed in; no test waits on a real clock.
 */

const FPS = 30;
const FRAME_MS = 1000 / FPS;

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
