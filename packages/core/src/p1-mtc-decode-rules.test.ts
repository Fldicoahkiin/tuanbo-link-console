import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkProject } from '@tb/schema';
import { frameNumberToTimecode, MtcDecodeError } from './mtc-timecode';
import { allocateP1TimecodeRanges } from './p1-auto-follow';
import { P1FollowSession } from './p1-follow-session';
import type { ProgramClock } from './program-clock';

/*
 * A cycle of P1's quarter frames that makes no timecode (P1 relocating mid-cycle mixes the pieces of two positions) is
 * dropped and the follow goes on (2026-11-12; 0.5.8 reported it and kept listening). The rule is in p1-clock.ts: the
 * decoder starts a fresh cycle, the existing rules judge what follows (silence for 500 ms is a loss, the next position
 * is checked for a jump), and the first of a run is thrown as an MtcDecodeError for the host's run log, before anything
 * of its message is taken. The host (p1-follow-host.ts `guard`) only logs it; any other error still closes the input.
 */

const FPS = 30;
const FRAME_MS = 1000 / FPS;
type Call = { kind: 'observe'; clock: ProgramClock } | { kind: 'reconcileAt'; clock: ProgramClock; playsOn: boolean } | { kind: 'hold' };

function fixture(project: LinkProject, mode: 'manual' | 'auto') {
  const calls: Call[] = [], prepares: string[] = [], warnings: string[] = [];
  const session = new P1FollowSession(project, mode, {
    lights: { change: () => undefined, stop: () => undefined },
    outputs: { observe: clock => calls.push({ kind: 'observe', clock }), hold: () => calls.push({ kind: 'hold' }), reconcileAt: (clock, playsOn) => calls.push({ kind: 'reconcileAt', clock, playsOn }) },
    prepare: itemId => prepares.push(itemId)
  });
  /** One cycle (two frames) from `frame` at `startMs`, as the host hands it on: a decode error is what it logs. `bad`:
   * the seconds' pieces come from two positions (12 and 59: "60"). */
  const cycle = (frame: number, startMs: number, bad = false) => {
    const tc = frameNumberToTimecode(frame, '30');
    const pieces = [tc.frames & 15, tc.frames >> 4, bad ? 12 : tc.seconds & 15, bad ? 3 : tc.seconds >> 4, tc.minutes & 15, tc.minutes >> 4, tc.hours & 15, (tc.hours >> 4) | (3 << 1)];
    for (const [type, value] of pieces.entries()) {
      try { session.message([0xf1, (type << 4) | value], at(startMs + type / 4 * FRAME_MS)); } catch (error) {
        if (!(error instanceof MtcDecodeError)) throw error;
        warnings.push(error.message);
      }
    }
  };
  /** P1 playing `frames` frames from `fromFrame` in time; the cycles at `badFrames` make no timecode. */
  const play = (fromFrame: number, frames: number, startMs: number, badFrames: readonly number[] = []) => {
    for (let offset = 0; offset < frames; offset += 2) cycle(fromFrame + offset, startMs + offset * FRAME_MS, badFrames.includes(fromFrame + offset));
    return { endMs: startMs + frames * FRAME_MS, lastPieceMs: startMs + (frames - 2 + 7 / 4) * FRAME_MS };
  };
  const shape = () => calls.map(call => call.kind === 'hold' ? 'hold' : `${call.kind}:${call.clock.state}`);
  return { session, calls, prepares, warnings, play, shape };
}

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

function at(ms: number): bigint { return BigInt(Math.round(ms * 10_000)); }

describe('P1 的时间码有一段解不出来：略过这一段，输入口照开，接下来的照原来的规矩判断', () => {
  it('跟着歌时中间有两段解不出来、后面的按时到：歌照跟，不冻结、不补，运行日志只记一次', () => {
    const f = fixture(manualProject(), 'manual');
    f.session.arm('song');
    const first = f.play(0, 60, 1_000);
    f.calls.length = 0;
    f.play(60, 60, first.endMs, [60, 62]);
    expect(f.warnings).toEqual(['MTC quarter-frame 解码出无效时间码：00:00:60:00 @ 30']);
    expect(f.session.view).toMatchObject({ phase: 'running', cause: null, reason: null });
    expect(f.shape().every(kind => kind === 'observe:running')).toBe(true);
    const positions = f.calls.map(call => call.kind === 'observe' ? call.clock.positionMs : -1);
    expect(positions.every((position, index) => index === 0 || position > positions[index - 1]!)).toBe(true);
    expect(f.calls.at(-1)).toMatchObject({ kind: 'observe', clock: { positionMs: 4_000 } });
  });

  it('解对一段就结束这一串：之后再有解不出来的再记一次', () => {
    const f = fixture(manualProject(), 'manual');
    f.session.arm('song');
    f.play(0, 90, 1_000, [30, 32, 60]);
    expect(f.warnings).toHaveLength(2);
    expect(f.session.view.phase).toBe('running');
  });

  it('解不出来以后就没声了：过 500 ms 照断码冻结', () => {
    const f = fixture(manualProject(), 'manual');
    f.session.arm('song');
    const first = f.play(0, 60, 1_000);
    const bad = f.play(60, 2, first.endMs, [60]);
    expect(f.session.view.phase).toBe('running');
    f.calls.length = 0;
    f.session.idle(at(bad.lastPieceMs + 600));
    expect(f.shape()).toEqual(['hold']);
    expect(f.session.view).toMatchObject({ phase: 'frozen', cause: 'lost', reason: 'MTC 信号中断' });
    expect(f.warnings).toHaveLength(1);
  });

  it('解不出来以后下一个位置跳了：照跳变冻结', () => {
    const f = fixture(manualProject(), 'manual');
    f.session.arm('song');
    const first = f.play(0, 60, 1_000);
    const bad = f.play(60, 2, first.endMs, [60]);
    f.play(300, 2, bad.endMs);
    expect(f.session.view).toMatchObject({ phase: 'frozen', cause: 'jump', reason: 'MTC 时间跳变' });
  });

  it('待命时（手动、自动选歌）收到的都解不出来：什么都不开始', () => {
    const manual = fixture(manualProject(), 'manual');
    manual.session.arm('song');
    manual.play(0, 30, 1_000, Array.from({ length: 15 }, (_, index) => index * 2));
    expect(manual.session.view).toMatchObject({ phase: 'waiting', itemId: 'song' });
    expect(manual.calls).toEqual([]);
    expect(manual.warnings).toHaveLength(1);
    const project = autoProject();
    const auto = fixture(project, 'auto');
    auto.session.arm(null);
    const head = project.p1AutoFollow!.ranges[0]!.startSeconds * FPS;
    auto.play(head, 30, 1_000, Array.from({ length: 15 }, (_, index) => head + index * 2));
    expect(auto.session.view).toMatchObject({ phase: 'waiting', itemId: null });
    expect({ calls: auto.calls, prepares: auto.prepares, warnings: auto.warnings.length }).toEqual({ calls: [], prepares: [], warnings: 1 });
  });
});
