import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkProject, type MtcFrameRate } from '@tb/schema';
import { frameNumberToTimecode, nominalFramesPerSecond } from './mtc-timecode';
import { allocateP1TimecodeRanges } from './p1-auto-follow';
import { P1Clock, type P1ClockEvent } from './p1-clock';

describe('P1Clock', () => {
  it('只给 P1 工程用；自动选歌要先生成点歌联动', () => {
    expect(() => new P1Clock({ ...manualProject(), playbackSource: 'internal' }, 'manual')).toThrow(/联动台播放/);
    expect(() => new P1Clock(manualProject(), 'auto')).toThrow(/点歌联动/);
  });

  it('待命前收到的时间码不算；待命要选一首启用的歌，跟随中不能重新待命', () => {
    const clock = new P1Clock(manualProject(), 'manual');
    expect(play(clock, 0, 30, 1_000).events).toEqual([]);
    expect(clock.state).toEqual({ phase: 'idle' });
    expect(() => clock.arm('missing')).toThrow(/节目不存在/);
    const disabled = manualProject(); disabled.rundown[0]!.enabled = false;
    expect(() => new P1Clock(disabled, 'manual').arm('song')).toThrow(/已停用/);
    expect(() => new P1Clock(autoProject(), 'auto').arm('a')).toThrow(/P1 点歌/);
    clock.arm('song');
    expect(() => clock.arm('song')).toThrow(/先停止/);
  });

  it('等 P1 开始时只有心跳不算断码；从开头 2 秒内开始才进入运行', () => {
    const clock = new P1Clock(manualProject(), 'manual');
    clock.arm('song');
    for (let ms = 1_000; ms <= 10_000; ms += 100) expect(clock.idle(at(ms))).toEqual([]);
    expect(clock.state).toMatchObject({ phase: 'waiting', itemId: 'song' });
    const late = new P1Clock(manualProject(), 'manual');
    late.arm('song');
    expect(play(late, 3 * 30, 8, 1_000).events[0]).toEqual({ kind: 'frozen', cause: 'not-from-start', reason: 'MTC 不是从节目开头开始的' });
    // The operator may still resync to where P1 is.
    expect(late.resync()).toMatchObject([{ kind: 'resynced', clock: { itemId: 'song' } }]);
    const onTime = new P1Clock(manualProject(), 'manual');
    onTime.arm('song');
    expect(play(onTime, 2 * 30 - 2, 2, 1_000).events).toMatchObject([{ kind: 'clock', clock: { positionMs: 2_000 } }]);
  });

  it('时钟带接口时间、歌曲内位置（减去 P1 区间起点）、会话和代数', () => {
    const project = autoProject();
    const clock = new P1Clock(project, 'auto');
    clock.arm(null);
    const start = project.p1AutoFollow!.ranges.find(range => range.itemId === 'b')!.startSeconds * 30;
    const { events } = play(clock, start + 10, 4, 5_000);
    expect(events[0]).toMatchObject({ kind: 'song', itemId: 'b' });
    const first = events[1], second = events[2];
    if (first?.kind !== 'clock' || second?.kind !== 'clock') throw new Error('应当收到时钟');
    expect(first.clock).toMatchObject({ source: 'p1', itemId: 'b', state: 'running', reason: null, positionMs: 12 * 1000 / 30 });
    expect(first.clock.observedAtMs).toBeCloseTo(5_000 + 1.75 * 1000 / 30, 3);
    expect(second.clock).toMatchObject({ sessionId: first.clock.sessionId, generation: first.clock.generation });
  });

  it('手动重同步只在冻结且时间码在来时可以；帧率不对也不行', () => {
    const clock = new P1Clock(manualProject(), 'manual');
    clock.arm('song');
    expect(() => clock.resync()).toThrow(/中断后/);
    const { lastSampleMs } = play(clock, 0, 30, 1_000);
    expect(() => clock.resync()).toThrow(/中断后/);
    clock.idle(at(lastSampleMs + 600));
    expect(() => clock.resync()).toThrow(/还没恢复稳定/);
    const wrongRate = new P1Clock(manualProject('25'), 'manual');
    wrongRate.arm('song');
    expect(play(wrongRate, 0, 8, 1_000).events[0]).toEqual({ kind: 'frozen', cause: 'frame-rate', reason: 'MTC 帧率不一致：应为 25，收到的是 30' });
    expect(() => wrongRate.resync()).toThrow(/帧率不一致/);
  });

  it('重同步和恢复让代数加一，同一会话；从头重新待命换会话', () => {
    const clock = new P1Clock(manualProject(), 'manual');
    clock.arm('song');
    const first = play(clock, 0, 30, 1_000);
    const before = first.events.at(-1);
    if (before?.kind !== 'clock') throw new Error('应当收到时钟');
    clock.idle(at(first.lastSampleMs + 600));
    play(clock, 30, 4, first.lastSampleMs + 700);
    const [resynced] = clock.resync();
    if (resynced?.kind !== 'resynced') throw new Error('应当重同步');
    expect(resynced.clock).toMatchObject({ sessionId: before.clock.sessionId, generation: before.clock.generation + 1 });
    expect(() => clock.rearmFromStart()).toThrow(/中断后/);
    clock.idle(at(first.lastSampleMs + 2_000));
    clock.rearmFromStart();
    expect(clock.state).toMatchObject({ phase: 'waiting', itemId: 'song' });
    const again = play(clock, 0, 2, first.lastSampleMs + 3_000).events[0];
    expect(again?.kind === 'clock' && again.clock.sessionId).not.toBe(before.clock.sessionId);
  });

  it('Full Frame 丢掉之前收了一半的四分之一帧；其他 MIDI 消息不影响', () => {
    const clock = new P1Clock(manualProject(), 'manual');
    clock.arm('song');
    const pieces = quarterFrames(0, '30');
    for (const [index, piece] of pieces.slice(0, 4).entries()) clock.message(piece, at(1_000 + index));
    expect(clock.message([0xf0, 0x7f, 0x7f, 1, 1, 0x60, 0, 1, 0, 0xf7], at(1_010))).toEqual([]);
    expect(clock.message([0x90, 60, 100], at(1_011))).toEqual([]);
    for (const [index, piece] of pieces.slice(4).entries()) expect(clock.message(piece, at(1_020 + index))).toEqual([]);
    expect(clock.state.phase).toBe('waiting');
  });

  it('心跳之后读到一条时间略早的消息是正常的：不报错，“现在”取较晚的那个，断码照样按它算', () => {
    const clock = new P1Clock(manualProject(), 'manual');
    clock.arm('song');
    const { endMs } = play(clock, 0, 8, 1_000);
    expect(clock.state.phase).toBe('running');
    const running = clock.state;
    expect(clock.idle(at(endMs + 100))).toEqual([]);
    // Written by the driver 5 ms before the heartbeat, read after it.
    expect(clock.message([0x90, 60, 100], at(endMs + 95))).toEqual([]);
    expect(clock.state).toEqual(running);
    // "Now" did not go back: an older heartbeat changes nothing, and silence is still counted on the interface's time.
    expect(clock.idle(at(endMs + 90))).toEqual([]);
    expect(clock.idle(at(endMs + 700))).toMatchObject([{ kind: 'frozen', cause: 'lost' }]);
  });

  it('停止后不再产生事件，可以重新待命', () => {
    const clock = new P1Clock(manualProject(), 'manual');
    clock.arm('song');
    const first = play(clock, 0, 10, 1_000);
    clock.stop();
    expect(clock.state).toEqual({ phase: 'stopped' });
    expect(play(clock, 10, 10, first.endMs).events).toEqual([]);
    expect(clock.idle(at(first.endMs + 5_000))).toEqual([]);
    clock.arm('song');
    expect(clock.state.phase).toBe('waiting');
  });
});

function manualProject(frameRate: MtcFrameRate = '30'): LinkProject {
  const empty = createEmptyLinkProject('P1 手动跟随');
  return parseLinkProject({ ...empty, timebase: { ...empty.timebase, frameRate }, playbackSource: 'p1', rundown: [{ id: 'song', title: '歌曲', cues: [] }] });
}

function autoProject(): LinkProject {
  const project = parseLinkProject({ ...createEmptyLinkProject('P1 自动选歌'), playbackSource: 'p1', rundown: ['a', 'b'].map(id => ({
    id, title: id, cues: [], referenceAudio: { assetId: `audio-${id}`, relativePath: `assets/${id}.wav`, sha256: 'a'.repeat(64), durationMs: 30_000 }
  })) });
  project.p1AutoFollow = allocateP1TimecodeRanges(project);
  return project;
}

function at(ms: number): bigint { return BigInt(Math.round(ms * 10_000)); }

function quarterFrames(frame: number, rate: MtcFrameRate): number[][] {
  const tc = frameNumberToTimecode(frame, rate);
  const code = rate === '24' ? 0 : rate === '25' ? 1 : rate === '29.97df' ? 2 : 3;
  return [tc.frames & 15, tc.frames >> 4, tc.seconds & 15, tc.seconds >> 4, tc.minutes & 15, tc.minutes >> 4, tc.hours & 15, (tc.hours >> 4) | (code << 1)]
    .map((value, type) => [0xf1, (type << 4) | value]);
}

/** P1 playing at 30 fps on the interface's clock: eight quarter frames per two frames. */
function play(clock: P1Clock, fromFrame: number, frames: number, startMs: number): { events: P1ClockEvent[]; endMs: number; lastSampleMs: number } {
  const frameMs = 1000 / nominalFramesPerSecond('30');
  const events: P1ClockEvent[] = [];
  let lastSampleMs = startMs;
  for (let offset = 0; offset < frames; offset += 2) {
    for (const [type, piece] of quarterFrames(fromFrame + offset, '30').entries()) {
      const ms = startMs + (offset + type / 4) * frameMs;
      events.push(...clock.message(piece, at(ms)));
      if (type === 7) lastSampleMs = ms;
    }
  }
  return { events, endMs: startMs + frames * frameMs, lastSampleMs };
}
