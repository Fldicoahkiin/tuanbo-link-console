import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkProject } from '@tb/schema';
import { frameNumberToTimecode } from './mtc-timecode';
import { allocateP1TimecodeRanges } from './p1-auto-follow';
import { P1FollowSession } from './p1-follow-session';
import type { ProgramClock } from './program-clock';

/** What the session tells the outputs and asks the host, with the page code each rule is taken from (0.5.9 P3c). */

const FPS = 30;
const FRAME_MS = 1000 / FPS;
type Call = { kind: 'observe'; clock: ProgramClock } | { kind: 'reconcileAt'; clock: ProgramClock; playsOn: boolean } | { kind: 'hold' };

function fixture(project: LinkProject, mode: 'manual' | 'auto') {
  const calls: Call[] = [], prepares: { itemId: string; sessionId: string }[] = [];
  const session = new P1FollowSession(project, mode, {
    outputs: { observe: clock => calls.push({ kind: 'observe', clock }), hold: () => calls.push({ kind: 'hold' }), reconcileAt: (clock, playsOn) => calls.push({ kind: 'reconcileAt', clock, playsOn }) },
    prepare: (itemId, sessionId) => prepares.push({ itemId, sessionId })
  });
  return { session, calls, prepares, shape: () => calls.map(call => call.kind === 'hold' ? 'hold' : `${call.kind}:${call.clock.state}`) };
}

describe('P1 跟随会话 · 手动模式（协调器 armFromStart / resyncCurrentTime / rearmFromStart / stop）', () => {
  it('从头开始：输出先在歌曲开头准备，再跟上第一个位置（CueRuntime 从头待命执行开头到第一帧的 Cue）', () => {
    const f = fixture(manualProject(), 'manual');
    f.session.arm('song');
    expect(f.session.view).toMatchObject({ phase: 'waiting', itemId: 'song', reason: '等 P1 从歌曲开头播放' });
    play(f.session, 0, 30, 1_000);
    const [ready, first] = f.calls;
    expect(ready).toMatchObject({ kind: 'observe', clock: { state: 'ready', positionMs: 0, observedAtMs: null, itemId: 'song' } });
    expect(first).toMatchObject({ kind: 'observe', clock: { state: 'running', itemId: 'song' } });
    expect(first?.kind === 'observe' && ready?.kind === 'observe' && first.clock.sessionId === ready.clock.sessionId && first.clock.generation === ready.clock.generation).toBe(true);
    expect(f.shape().slice(1).every(kind => kind === 'observe:running')).toBe(true);
    expect(f.session.view).toMatchObject({ phase: 'running', itemId: 'song' });
  });

  it('断码只告诉输出一次 hold；时间码回来也不自己恢复；操作员重同步按当前位置 reconcileAt；停止放开这首歌', () => {
    const f = fixture(manualProject(), 'manual');
    f.session.arm('song');
    const first = play(f.session, 0, 60, 1_000);
    f.calls.length = 0;
    f.session.idle(at(first.lastSampleMs + 600)); f.session.idle(at(first.lastSampleMs + 700));
    expect(f.shape()).toEqual(['hold']);
    expect(f.session.view).toMatchObject({ phase: 'frozen', cause: 'lost', reason: 'MTC 信号中断' });
    const again = play(f.session, 90, 30, first.lastSampleMs + 2_000);
    expect(f.shape()).toEqual(['hold']);
    f.session.resync();
    expect(f.calls.at(-1)).toMatchObject({ kind: 'reconcileAt', clock: { state: 'running', positionMs: 4000 } });
    // A resync is a new pass from here (P3d): nothing handled before carries over.
    expect(f.calls.at(-1)).toMatchObject({ playsOn: false });
    expect(f.session.view).toMatchObject({ phase: 'running', cause: null, reason: null });
    expect(() => f.session.takeover()).toThrow('只有时间码中断后才能手动接管');
    play(f.session, 120, 30, again.endMs);
    expect(f.shape().slice(2).every(kind => kind === 'observe:running')).toBe(true);
    f.session.stop();
    expect(f.calls.at(-1)).toMatchObject({ kind: 'observe', clock: { state: 'stopped', reason: '操作员请求停止', observedAtMs: null } });
    expect(f.session.view.phase).toBe('standby');
    // Arm again after a stop: a new session.
    f.session.arm('song');
    expect(f.session.view.phase).toBe('waiting');
  });

  it('不是从开头开始：冻结但没有可以 hold 的歌；重同步后从当前位置开始', () => {
    const f = fixture(manualProject(), 'manual');
    f.session.arm('song');
    play(f.session, 10 * FPS, 30, 1_000);
    expect(f.calls).toEqual([]);
    expect(f.session.view).toMatchObject({ phase: 'frozen', cause: 'not-from-start', reason: 'MTC 不是从节目开头开始的' });
    f.session.resync();
    expect(f.shape()).toEqual(['reconcileAt:running']);
  });

  it('从头重新待命：输出不清（界面只忘掉执行过的），新的一轮在开头重新准备', () => {
    const f = fixture(manualProject(), 'manual');
    f.session.arm('song');
    const first = play(f.session, 0, 30, 1_000);
    const sessionA = f.session.view.sessionId;
    f.session.idle(at(first.lastSampleMs + 600));
    f.calls.length = 0;
    f.session.rearm();
    expect(f.calls).toEqual([]);
    expect(f.session.view).toMatchObject({ phase: 'waiting', reason: '等 P1 从歌曲开头播放' });
    play(f.session, 0, 10, first.endMs + 5_000);
    expect(f.calls[0]).toMatchObject({ kind: 'observe', clock: { state: 'ready', positionMs: 0 } });
    expect(f.calls[0]?.kind === 'observe' && f.calls[0].clock.sessionId).not.toBe(sessionA);
  });

  it('手动接管：只在冻结时；之后不跟时间码，不能重同步、不能重新待命，只有停止能结束', () => {
    const f = fixture(manualProject(), 'manual');
    expect(() => f.session.takeover()).toThrow('只有时间码中断后才能手动接管');
    f.session.arm('song');
    const first = play(f.session, 0, 30, 1_000);
    f.session.idle(at(first.lastSampleMs + 600));
    f.session.takeover();
    f.calls.length = 0;
    expect(f.session.view).toMatchObject({ phase: 'takeover', cause: null });
    play(f.session, 40, 30, first.endMs + 1_000);
    f.session.idle(at(first.endMs + 9_000));
    expect(f.calls).toEqual([]);
    expect(() => f.session.resync()).toThrow('只有时间码中断后才能重新同步');
    expect(() => f.session.rearm()).toThrow('只有时间码中断后才能从头重新待命');
    f.session.stop();
    expect(f.shape()).toEqual(['observe:stopped']);
  });

  it('输入口没了：在走的这首歌算断码，hold 一次', () => {
    const f = fixture(manualProject(), 'manual');
    f.session.arm('song');
    play(f.session, 0, 30, 1_000);
    f.calls.length = 0;
    f.session.inputGone();
    expect(f.shape()).toEqual(['hold']);
    expect(f.session.view).toMatchObject({ phase: 'frozen', cause: 'lost', reason: 'MTC 信号中断' });
    // Armed but nothing started yet: the page stayed armed (no loss without a first sample, CueRuntime tick).
    const waiting = fixture(manualProject(), 'manual');
    waiting.session.arm('song'); waiting.session.inputGone();
    expect(waiting.session.view.phase).toBe('waiting');
  });

  it('没待命时也显示 P1 的时间码；连续 500 ms 才算稳定，有缺口就重新算（MtcStabilityTracker）', () => {
    const f = fixture(manualProject(), 'manual');
    const first = play(f.session, 100, 10, 1_000);
    expect(f.session.view.mtc).toMatchObject({ receiving: true, stable: false, sample: { totalFrames: 110 } });
    const more = play(f.session, 110, 20, first.endMs);
    expect(f.session.view.mtc).toMatchObject({ receiving: true, stable: true });
    f.session.idle(at(more.lastSampleMs + 600));
    expect(f.session.view.mtc).toMatchObject({ receiving: false });
    play(f.session, 130, 4, more.lastSampleMs + 700);
    expect(f.session.view.mtc).toMatchObject({ receiving: true, stable: false });
    expect(f.calls).toEqual([]);
    expect(f.session.view.phase).toBe('standby');
  });
});

describe('P1 跟随会话 · 自动选歌（P1AutoFollowController）', () => {
  it('P1 从开头放一首：先准备，准备好才在开头开始并跟上最新位置；准备期间不给输出', () => {
    const project = autoProject();
    const f = fixture(project, 'auto');
    f.session.arm(null);
    expect(f.session.view).toMatchObject({ phase: 'waiting', itemId: null, reason: '等 P1 点歌，从歌曲开头播放' });
    const a = play(f.session, songFrame(project, 'a'), 30, 1_000);
    expect(f.prepares.map(prepare => prepare.itemId)).toEqual(['a']);
    expect(f.calls).toEqual([]);
    expect(f.session.view).toMatchObject({ phase: 'preparing', itemId: 'a' });
    f.session.prepared(f.prepares[0]!.sessionId);
    expect(f.shape()).toEqual(['observe:ready', 'observe:running']);
    expect(f.calls[1]).toMatchObject({ clock: { positionMs: 1000 } });
    play(f.session, songFrame(project, 'a') + 30, 30, a.endMs);
    expect(f.shape().slice(2).every(kind => kind === 'observe:running')).toBe(true);
    // P1 clicks song b: song a stops first, then b is prepared.
    f.calls.length = 0;
    play(f.session, songFrame(project, 'b'), 30, a.endMs + 30 * FRAME_MS + 200);
    expect(f.calls[0]).toMatchObject({ kind: 'observe', clock: { itemId: 'a', state: 'stopped', reason: 'P1 切歌，停止上一首' } });
    expect(f.calls).toHaveLength(1);
    expect(f.prepares.at(-1)?.itemId).toBe('b');
    // An answer for an older preparation changes nothing (the controller's `isCurrent`).
    f.session.prepared(f.prepares[0]!.sessionId);
    expect(f.calls).toHaveLength(1);
    f.session.prepared(f.prepares.at(-1)!.sessionId);
    expect(f.calls.slice(1)).toMatchObject([{ clock: { itemId: 'b', state: 'ready' } }, { clock: { itemId: 'b', state: 'running' } }]);
  });

  it('准备期间 P1 停了：准备好以后不开始，等 P1 从歌曲开头播放；同一遍接着放也不开始，重播才重新准备', () => {
    const project = autoProject();
    const f = fixture(project, 'auto');
    f.session.arm(null);
    const a = play(f.session, songFrame(project, 'a'), 30, 1_000);
    f.session.idle(at(a.lastSampleMs + 600));
    f.session.prepared(f.prepares[0]!.sessionId);
    expect(f.calls).toEqual([]);
    expect(f.session.view).toMatchObject({ phase: 'failed', reason: '准备过程中 P1 停止了，请恢复监听后重新点歌' });
    // P1 goes on from where it stopped: still waiting for a start from the head.
    play(f.session, songFrame(project, 'a') + 30, 8, a.lastSampleMs + 2_000);
    expect(f.calls).toEqual([]); expect(f.prepares).toHaveLength(1);
    play(f.session, songFrame(project, 'a'), 30, a.lastSampleMs + 5_000);
    expect(f.prepares).toHaveLength(2);
    expect(f.session.view.phase).toBe('preparing');
  });

  it('准备期间 P1 暂停又接着放（在 500 ms 以内的样本还在）：照常开始', () => {
    const project = autoProject();
    const f = fixture(project, 'auto');
    f.session.arm(null);
    const a = play(f.session, songFrame(project, 'a'), 30, 1_000);
    f.session.idle(at(a.lastSampleMs + 600));
    play(f.session, songFrame(project, 'a') + 29, 8, a.lastSampleMs + 2_000);
    f.session.prepared(f.prepares[0]!.sessionId);
    expect(f.shape()).toEqual(['observe:ready', 'observe:running']);
  });

  it('准备失败：写明原因，同一遍不重试，下一首（或重播）从开头才重新准备', () => {
    const project = autoProject();
    const f = fixture(project, 'auto');
    f.session.arm(null);
    const a = play(f.session, songFrame(project, 'a'), 30, 1_000);
    f.session.preparationFailed(f.prepares[0]!.sessionId, '开播前检查：OBS 没连上');
    expect(f.session.view).toMatchObject({ phase: 'failed', reason: '开播前检查：OBS 没连上' });
    const on = play(f.session, songFrame(project, 'a') + 30, 60, a.endMs);
    // P1 pausing and going on is not followed either (the controller ignores the play while awaiting a restart).
    f.session.idle(at(on.lastSampleMs + 600));
    play(f.session, songFrame(project, 'a') + 92, 8, on.lastSampleMs + 2_000);
    expect(f.prepares).toHaveLength(1); expect(f.calls).toEqual([]);
    expect(f.session.view).toMatchObject({ phase: 'failed', reason: '开播前检查：OBS 没连上' });
    play(f.session, songFrame(project, 'b'), 30, a.endMs + 5_000);
    expect(f.prepares.at(-1)?.itemId).toBe('b');
  });

  it('P1 暂停又从同一位置继续（≤ fps/4）：hold，然后在当前位置 reconcileAt；跳到别处冻结，等 P1 从开头放', () => {
    const project = autoProject();
    const f = fixture(project, 'auto');
    f.session.arm(null);
    const a = play(f.session, songFrame(project, 'a'), 60, 1_000);
    f.session.prepared(f.prepares[0]!.sessionId);
    play(f.session, songFrame(project, 'a') + 60, 30, a.endMs);
    f.calls.length = 0;
    const lastFrame = 88;
    f.session.idle(at(a.endMs + 30 * FRAME_MS + 600));
    expect(f.shape()).toEqual(['hold']);
    const resumed = play(f.session, songFrame(project, 'a') + lastFrame + 2, 8, a.endMs + 5_000);
    expect(f.shape().slice(0, 2)).toEqual(['hold', 'reconcileAt:running']);
    // P1 going on from where it stopped is the same pass (P3d).
    expect(f.calls[1]).toMatchObject({ kind: 'reconcileAt', playsOn: true });
    expect(f.session.view.phase).toBe('running');
    f.session.idle(at(resumed.lastSampleMs + 600));
    f.calls.length = 0;
    play(f.session, songFrame(project, 'a') + 200, 30, resumed.lastSampleMs + 3_000);
    expect(f.calls).toEqual([]);
    expect(f.session.view).toMatchObject({ phase: 'frozen', cause: 'jump' });
  });
});

describe('P1 跟随会话 · 自动选歌时手动接管', () => {
  it('接管以后 P1 接着放也不跟（CueRuntime 接管时不处理时间码）；P1 从开头放一首才重新开始（控制器照常准备）', () => {
    const project = autoProject();
    const f = fixture(project, 'auto');
    f.session.arm(null);
    const a = play(f.session, songFrame(project, 'a'), 30, 1_000);
    f.session.prepared(f.prepares[0]!.sessionId);
    f.session.idle(at(a.lastSampleMs + 600));
    f.session.takeover();
    f.calls.length = 0;
    const on = play(f.session, songFrame(project, 'a') + 30, 30, a.lastSampleMs + 2_000);
    f.session.idle(at(on.lastSampleMs + 600));
    expect(f.calls).toEqual([]);
    expect(f.session.view.phase).toBe('takeover');
    play(f.session, songFrame(project, 'b'), 10, on.lastSampleMs + 3_000);
    expect(f.shape()).toEqual(['observe:stopped']);
    expect(f.session.view).toMatchObject({ phase: 'preparing', itemId: 'b' });
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

/** P1 playing `frames` frames from `fromFrame` at 30 fps, eight quarter frames per two frames on the interface's clock.
 * A decoded position is two frames after the one its pieces encode (the time of its last piece). */
function play(session: P1FollowSession, fromFrame: number, frames: number, startMs: number): { endMs: number; lastSampleMs: number } {
  let lastSampleMs = startMs;
  for (let offset = 0; offset < frames; offset += 2) {
    const tc = frameNumberToTimecode(fromFrame + offset, '30');
    const pieces = [tc.frames & 15, tc.frames >> 4, tc.seconds & 15, tc.seconds >> 4, tc.minutes & 15, tc.minutes >> 4, tc.hours & 15, (tc.hours >> 4) | (3 << 1)];
    for (const [type, value] of pieces.entries()) {
      const ms = startMs + (offset + type / 4) * FRAME_MS;
      session.message([0xf1, (type << 4) | value], at(ms));
      if (type === 7) lastSampleMs = ms;
    }
  }
  return { endMs: startMs + frames * FRAME_MS, lastSampleMs };
}
