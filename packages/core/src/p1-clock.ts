import type { LinkProject } from '@tb/schema';
import { MtcQuarterFrameDecoder, nominalFramesPerSecond, playbackFramesPerSecond, type MtcSample } from './mtc-timecode';
import { locateP1Sample, validateP1TimecodeRanges } from './p1-auto-follow';
import type { ProgramClock } from './program-clock';

/*
 * The one place that decides, for P1 follow, whether the timecode is running, lost, jumped or
 * started another song (AGENTS §4.9; design 03 §4.1.2). Pure: every time is the MIDI interface's
 * own timestamp (`at100ns` of the native input, and its `idle` heartbeat), never the moment a main
 * process or a page got around to handling it. A batch that arrives late but whose timestamps kept
 * time is not a loss. Not wired yet: CueRuntime and the page's P1 path stay as they are until P3/P4.
 *
 * The numbers are moved unchanged from `cue-runtime.ts` (lines as of bfc8a766):
 * - MTC_LOSS_MS = 500 (L28; used in `ingest` L220 and `tick` L258)
 * - MTC_JUMP_MS = 250 (L29; `isUnexpectedJump` L527–534)
 * - MTC_INITIAL_LOCK_SECONDS = 2 (L30; "starts from the song's head" in `ingest` L207–215)
 * - resume within fps/4 frames, never backwards (`resumeP1` L282–291)
 * and from the page: resync needs a sample at most 500 ms old (`link-runtime-coordinator.ts` L165),
 * a new auto-follow session starts only within the first 2 s (`p1-auto-follow-controller.ts` L40, L62).
 */

const MTC_LOSS_MS = 500;
const MTC_JUMP_MS = 250;
const MTC_INITIAL_LOCK_SECONDS = 2;

export type P1FollowMode = 'manual' | 'auto';

/** Why automatic Cues froze. Only the operator (manual) or P1 itself (auto) moves on from here. */
export type P1FreezeCause = 'lost' | 'jump' | 'unknown-range' | 'not-from-start' | 'frame-rate';

/**
 * What P1 is doing while it runs: a `ProgramClock` (design 03 §4.1.1) from P1, always running and always observed at
 * the interface time (ms) of the quarter frame that completed this position. Auto-follow subtracts the song's P1 range
 * start, manual follows MTC as is. A session is one follow of one song (a new arm, a new song in auto-follow, or a
 * rearm from the start); the generation goes up on every new session, resume and resync.
 */
export type P1ClockObservation = ProgramClock & { source: 'p1'; state: 'running'; observedAtMs: number; reason: null };

export type P1FollowState =
  | { phase: 'idle' }
  /** Armed; waiting for P1 to play from the song's head (auto: any song, itemId null). */
  | { phase: 'waiting'; itemId: string | null; reason: string }
  | { phase: 'running'; clock: P1ClockObservation }
  | { phase: 'frozen'; itemId: string | null; positionMs: number; cause: P1FreezeCause; reason: string }
  | { phase: 'stopped' };

export type P1ClockEvent =
  | { kind: 'clock'; clock: P1ClockObservation }
  /** Auto-follow: P1 played another song, or this one again, from its head. */
  | { kind: 'song'; itemId: string; sessionId: string }
  | { kind: 'frozen'; cause: P1FreezeCause; reason: string }
  /** Auto-follow: P1 went on from where it stopped (within fps/4 frames). */
  | { kind: 'resumed'; clock: P1ClockObservation }
  /** Manual: the operator resynced to the current timecode. */
  | { kind: 'resynced'; clock: P1ClockObservation };

type Position = { itemId: string; sample: MtcSample };

export class P1Clock {
  private readonly decoder = new MtcQuarterFrameDecoder();
  private current: P1FollowState = { phase: 'idle' };
  /** The interface's "now": the later of the newest message and heartbeat timestamps. */
  private nowMs: number | null = null;
  /** Last position that kept time while running; a freeze keeps it for the resume check. */
  private last: Position | null = null;
  /** Latest position seen at all (also while frozen), for resync and auto-follow's new-song check. */
  private observed: Position | null = null;
  /** Auto-follow: frozen in a way only P1 playing a song from its head can end. */
  private needsRestart = false;
  private sessionId = '';
  private generation = 0;

  constructor(private readonly project: LinkProject, private readonly mode: P1FollowMode) {
    if (project.playbackSource === 'internal') throw new Error('这个工程由联动台播放，不跟随 P1');
    if (mode === 'auto') {
      if (!project.p1AutoFollow?.enabled) throw new Error('这个工程还没生成 P1 点歌联动');
      validateP1TimecodeRanges(project);
    }
  }

  get state(): P1FollowState { return this.current; }

  /** One MIDI message from the P1 input with the interface's timestamp. Quarter frames carry the
   * position; a Full Frame relocates, so pieces collected before it are dropped. */
  message(bytes: readonly number[], at100ns: bigint): P1ClockEvent[] {
    const atMs = this.advance(at100ns);
    const events = this.checkLoss();
    if (isFullFrame(bytes)) { this.decoder.reset(); return events; }
    if (bytes.length !== 2 || bytes[0] !== 0xf1) return events;
    if (this.current.phase === 'idle' || this.current.phase === 'stopped') return events;
    const sample = this.decoder.push(bytes[1]!, atMs);
    if (!sample) return events;
    return [...events, ...(this.mode === 'auto' ? this.autoSample(sample) : this.manualSample(sample))];
  }

  /** The native input's heartbeat: nothing arrived, and this is the interface's time now. */
  idle(at100ns: bigint): P1ClockEvent[] {
    this.advance(at100ns);
    return this.checkLoss();
  }

  /** Manual: follow this song from its head. Auto: `null`, P1 picks the song. */
  arm(itemId: string | null): void {
    if (this.current.phase !== 'idle' && this.current.phase !== 'stopped') throw new Error('正在跟随 P1，先停止再重新待命');
    if (this.mode === 'auto' && itemId !== null) throw new Error('自动选歌由 P1 点歌决定放哪首');
    if (this.mode === 'manual') {
      const item = this.project.rundown.find(candidate => candidate.id === itemId);
      if (!item) throw new Error(`节目不存在：${itemId ?? '未选择'}`);
      if (!item.enabled) throw new Error(`节目已停用：${item.title}`);
    }
    this.waitFromStart(itemId);
  }

  /** Manual: the operator resyncs to where P1 is now. Only while frozen and while the timecode is
   * coming in. Auto-follow never resyncs: only P1 playing a song from its head, or going on from
   * where it stopped, ends a freeze there. */
  resync(): P1ClockEvent[] {
    const frozen = this.current;
    if (this.mode !== 'manual') throw new Error('自动选歌由 P1 恢复：在 P1 从歌曲开头播放，或从停下的位置继续');
    if (frozen.phase !== 'frozen') throw new Error('只有时间码中断后才能重新同步');
    const latest = this.observed;
    if (!latest || this.nowMs === null || this.nowMs - latest.sample.receivedAtMs > MTC_LOSS_MS) {
      throw new Error('MTC 时间码还没恢复稳定，暂时不能按当前时间重新同步');
    }
    if (latest.sample.frameRate !== this.project.timebase.frameRate) throw new Error(frameRateReason(this.project, latest.sample));
    this.generation += 1;
    const clock = this.run(latest);
    return [{ kind: 'resynced', clock }];
  }

  /** Start over from the song's head (manual), or listen for P1's next song (auto). */
  rearmFromStart(): void {
    if (this.current.phase !== 'frozen') throw new Error('只有时间码中断后才能从头重新待命');
    this.waitFromStart(this.mode === 'manual' ? this.current.itemId : null);
  }

  stop(): void {
    this.decoder.reset();
    this.last = null; this.observed = null; this.needsRestart = false;
    this.current = { phase: 'stopped' };
  }

  private waitFromStart(itemId: string | null): void {
    this.decoder.reset();
    this.last = null; this.observed = null; this.needsRestart = false;
    if (this.mode === 'manual') this.newSession();
    this.current = { phase: 'waiting', itemId, reason: this.mode === 'auto' ? '等 P1 点歌，从歌曲开头播放' : '等 P1 从歌曲开头播放' };
  }

  private advance(at100ns: bigint): number {
    if (at100ns < 0n) throw new Error('MIDI 接口时间无效');
    const atMs = Number(at100ns) / 10_000;
    // A message read just after a heartbeat may carry a slightly earlier time: it reached the driver before the heartbeat
    // was written (native-midi-input.ts). That is normal, so "now" is the later of the two and nothing is refused.
    if (this.nowMs === null || atMs > this.nowMs) this.nowMs = atMs;
    return atMs;
  }

  /** Lost: interface time since the last position that kept time is over MTC_LOSS_MS. */
  private checkLoss(): P1ClockEvent[] {
    if (this.current.phase !== 'running' || !this.last || this.nowMs === null) return [];
    if (this.nowMs - this.last.sample.receivedAtMs <= MTC_LOSS_MS) return [];
    return [this.freeze('lost', 'MTC 信号中断', false)];
  }

  private manualSample(sample: MtcSample): P1ClockEvent[] {
    const itemId = this.itemIdOf(this.current);
    if (itemId === null) return [];
    const position = { itemId, sample };
    this.observed = position;
    if (this.current.phase === 'frozen') return [];
    if (sample.frameRate !== this.project.timebase.frameRate) return [this.freeze('frame-rate', frameRateReason(this.project, sample), false)];
    if (this.current.phase === 'waiting') {
      if (!fromHead(sample)) return [this.freeze('not-from-start', 'MTC 不是从节目开头开始的', false)];
      return [{ kind: 'clock', clock: this.run(position) }];
    }
    return this.continueRunning(position);
  }

  private autoSample(raw: MtcSample): P1ClockEvent[] {
    const located = locateP1Sample(this.project, raw);
    if (!located) {
      if (this.current.phase === 'frozen' && this.needsRestart) return [];
      return [this.freeze('unknown-range', '收到的 P1 时间码对不上任何歌曲，或帧率不一致。请在 P1 打开这个工程生成的联动 .hia，再从歌曲开头播放。', true)];
    }
    const previous = this.observed;
    const position = { itemId: located.itemId, sample: located.sample };
    this.observed = position;
    const newStart = !previous || previous.itemId !== position.itemId || position.sample.totalFrames < previous.sample.totalFrames;
    if (newStart) {
      if (!fromHead(position.sample)) {
        if (this.current.phase === 'frozen' && this.needsRestart) return [];
        return [this.freeze('not-from-start', '请在 P1 从歌曲开头播放，自动联动才能开始；从中途播放无法判断歌曲起点', true)];
      }
      this.newSession();
      return [{ kind: 'song', itemId: position.itemId, sessionId: this.sessionId }, { kind: 'clock', clock: this.run(position) }];
    }
    if (this.current.phase === 'waiting' || (this.current.phase === 'frozen' && this.needsRestart)) return [];
    if (this.current.phase === 'frozen') return this.resume(position);
    return this.continueRunning(position);
  }

  /** Auto-follow: P1 went on from where it froze. Within fps/4 frames forward it is the same play. */
  private resume(position: Position): P1ClockEvent[] {
    const last = this.last;
    const fps = nominalFramesPerSecond(position.sample.frameRate);
    const delta = last ? position.sample.totalFrames - last.sample.totalFrames : -1;
    if (!last || last.itemId !== position.itemId || position.sample.frameRate !== last.sample.frameRate || delta < 0 || delta > fps / 4) {
      return [this.freeze('jump', 'P1 恢复位置发生跳变，请从歌曲开头重新播放', true)];
    }
    this.generation += 1;
    return [{ kind: 'resumed', clock: this.run(position) }];
  }

  private continueRunning(position: Position): P1ClockEvent[] {
    const last = this.last;
    if (last && isUnexpectedJump(last.sample, position.sample)) {
      const wentBackwards = position.sample.totalFrames < last.sample.totalFrames;
      return [this.freeze('jump', wentBackwards ? 'MTC 时间倒退' : 'MTC 时间跳变', false)];
    }
    return [{ kind: 'clock', clock: this.run(position) }];
  }

  private run(position: Position): P1ClockObservation {
    this.last = position;
    this.needsRestart = false;
    const clock: P1ClockObservation = {
      source: 'p1', sessionId: this.sessionId, generation: this.generation, itemId: position.itemId, state: 'running',
      positionMs: position.sample.totalFrames * 1000 / playbackFramesPerSecond(position.sample.frameRate),
      observedAtMs: position.sample.receivedAtMs, reason: null
    };
    this.current = { phase: 'running', clock };
    return clock;
  }

  /** Freeze automatic Cues at the last position that kept time. Nothing in between is guessed or sent later. */
  private freeze(cause: P1FreezeCause, reason: string, needsRestart: boolean): P1ClockEvent {
    const itemId = this.itemIdOf(this.current);
    const positionMs = this.current.phase === 'running' ? this.current.clock.positionMs : this.current.phase === 'frozen' ? this.current.positionMs : 0;
    this.needsRestart = needsRestart;
    this.current = { phase: 'frozen', itemId, positionMs, cause, reason };
    return { kind: 'frozen', cause, reason };
  }

  private newSession(): void {
    this.sessionId = crypto.randomUUID();
    this.generation += 1;
  }

  private itemIdOf(state: P1FollowState): string | null {
    switch (state.phase) {
      case 'waiting': return state.itemId;
      case 'running': return state.clock.itemId;
      case 'frozen': return state.itemId;
      case 'idle': case 'stopped': return null;
    }
  }
}

function fromHead(sample: MtcSample): boolean {
  return sample.totalFrames <= nominalFramesPerSecond(sample.frameRate) * MTC_INITIAL_LOCK_SECONDS;
}

function frameRateReason(project: LinkProject, sample: MtcSample): string {
  return `MTC 帧率不一致：应为 ${project.timebase.frameRate}，收到的是 ${sample.frameRate}`;
}

/** MTC Full Frame: F0 7F <device> 01 01 hr mn sc fr F7. */
function isFullFrame(bytes: readonly number[]): boolean {
  return bytes.length === 10 && bytes[0] === 0xf0 && bytes[1] === 0x7f && bytes[3] === 0x01 && bytes[4] === 0x01 && bytes[9] === 0xf7;
}

/** Moved unchanged from `cue-runtime.ts` L527–534 (`isUnexpectedJump`); the times are interface times here. */
function isUnexpectedJump(previous: MtcSample, current: MtcSample): boolean {
  if (current.totalFrames < previous.totalFrames) return true;
  const fps = nominalFramesPerSecond(current.frameRate);
  const elapsedMs = current.receivedAtMs - previous.receivedAtMs;
  const expectedFrames = elapsedMs * fps / 1000;
  const deviationMs = Math.abs(current.totalFrames - previous.totalFrames - expectedFrames) * 1000 / fps;
  return deviationMs > MTC_JUMP_MS;
}
