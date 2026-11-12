import type { LinkCue, LinkProject, RundownItem } from '@tb/schema';
import { nominalFramesPerSecond, type MtcSample } from './mtc-timecode';
import { compileRundownTimelineCues, type ScheduledTimelineCue } from './timeline-state';
import { liveCueEditRequestSchema, liveCueEditCommitSchema, validateLinkProjectRelations, type LiveCueEditRequest, type LiveCueEditCommit } from '@tb/schema';
import { prepareLiveCueEdit, type PreparedCueEdit, type CueEditResult } from './live-cue-edit';
import { playbackFramesPerSecond } from './mtc-timecode';

export type LinkRuntimeState = 'idle' | 'preflight' | 'armed' | 'running' | 'timecodeLost' | 'paused' | 'error' | 'stopping';
export type LinkRunMode = 'rehearsal' | 'live';

export type DueCue = {
  cue: LinkCue;
  scheduledFrame: number;
  executionId: string;
};

export type RuntimeUpdate = {
  state: LinkRuntimeState;
  dueCues: DueCue[];
  missedCueIds: string[];
  reason?: string;
  /** Internal clock gap (recovery rule B): outputs rebuild the state at this
   * frame instead of crossing the events in between. */
  rebuild?: true;
};

const MTC_LOSS_MS = 500;
const MTC_JUMP_MS = 250;
const MTC_INITIAL_LOCK_SECONDS = 2;

export class CueRuntime {
  private state: LinkRuntimeState = 'idle';
  private mode: LinkRunMode = 'rehearsal';
  private selectedItem: RundownItem | null = null;
  private scheduledCues: readonly ScheduledTimelineCue[] = [];
  private authoredCueIds: ReadonlySet<string> = new Set();
  private editSessionId = crypto.randomUUID();
  private executionRevision = 0;
  private pendingEdit: PreparedCueEdit | null = null;
  private previousFrame = -1;
  private lastSample: MtcSample | null = null;
  private readonly executedCueIds = new Set<string>();
  private readonly missedCueIds = new Set<string>();
  private executionOwner: 'local' | 'external' = 'local';

  /** `observationGapMs`: on the internal clock, a longer silence between position
   * observations is a gap to rebuild across, not a lost timecode. */
  constructor(private readonly project: LinkProject, private readonly observationGapMs = MTC_LOSS_MS) {}

  getState(): LinkRuntimeState {
    return this.state;
  }
  /** The Cues this run executed (0.5.9 R9): a newer plan of the same song keeps them executed (`carryExecuted`). */
  executedCues(): ReadonlySet<string> { return this.executedCueIds; }
  /** Marks these Cues of the song executed in this run: one sent before a newer plan arrived is not sent again in it,
   * also when the newer plan moved it behind the playhead (as action MIDI, S8b). */
  carryExecuted(cueIds: Iterable<string>): void { for (const id of cueIds) if (this.authoredCueIds.has(id)) this.executedCueIds.add(id); }

  /** Query the prepared index, never sort the whole program on a clock tick.
   * Execution identity belongs to the session, not the UI's recent reports. */
  getNextCueId(currentFrame = this.previousFrame): string | null {
    for (const { cue } of eventsBetween(this.scheduledCues, currentFrame, Infinity)) {
      if (this.authoredCueIds.has(cue.id) && !this.executedCueIds.has(cue.id) && !this.missedCueIds.has(cue.id)) return cue.id;
    }
    return null;
  }

  getCueEditContext(): { sessionId: string; programId: string; baseRevision: number } | null {
    return this.selectedItem ? { sessionId: this.editSessionId, programId: this.selectedItem.id, baseRevision: this.executionRevision } : null;
  }

  prepareCueEdit(input: LiveCueEditRequest): CueEditResult {
    const request = liveCueEditRequestSchema.parse(input);
    const invalid = this.editIdentityError(request);
    if (invalid || !this.selectedItem) return { status: 'not-applied', reason: invalid ?? '没有正在运行的节目' };
    this.pendingEdit = null; // A valid new drag/undo invalidates older preparation.
    const plan = prepareLiveCueEdit(this.selectedItem, this.project.timebase.frameRate, request);
    validateLinkProjectRelations({ ...this.project, rundown: this.project.rundown.map(item => item.id === plan.item.id ? plan.item : item) });
    if (!plan.affectedIds.length) return { status: 'not-applied', reason: '运行版本没有变化' };
    const timing = this.editBoundaryError(plan);
    if (timing) return { status: 'not-applied', reason: timing };
    this.pendingEdit = plan;
    return { status: 'awaiting-preparation', transactionId: request.transactionId,
      requiredChannels: plan.requiredChannels, latestCommitPositionMs: plan.earliestAffectedMs - 5000 };
  }

  commitCueEdit(input: LiveCueEditCommit): CueEditResult {
    const request = liveCueEditCommitSchema.parse(input), plan = this.pendingEdit;
    const invalid = this.editIdentityError(request);
    if (invalid) return { status: 'not-applied', reason: invalid };
    if (!plan || plan.request.transactionId !== request.transactionId) return { status: 'not-applied', reason: '修改已被新的修订或播放操作替代' };
    this.pendingEdit = null;
    const timing = this.editBoundaryError(plan);
    if (timing) return { status: 'not-applied', reason: timing };
    for (const channel of plan.requiredChannels) {
      const confirmation = request.channels.find(entry => entry.channel === channel);
      if (confirmation?.state !== 'ready') return { status: 'not-applied', reason: confirmation?.reason ?? `${channel} 还没准备好这次修改` };
    }
    this.selectedItem = plan.item; this.scheduledCues = plan.events;
    this.authoredCueIds = new Set(plan.item.cues.map(cue => cue.id)); this.executionRevision++;
    return { status: 'applied', revision: this.executionRevision };
  }

  private editIdentityError(request: Pick<LiveCueEditRequest, 'sessionId' | 'programId' | 'baseRevision'>): string | null {
    if (this.state !== 'armed' && this.state !== 'running') return '当前播放不能接收后面的修改';
    if (request.sessionId !== this.editSessionId || request.programId !== this.selectedItem?.id) return '播放或节目已经变了';
    if (request.baseRevision !== this.executionRevision) return '修改依据的版本已经过期';
    return null;
  }

  private editBoundaryError(plan: PreparedCueEdit): string | null {
    const positionMs = Math.max(0, this.previousFrame) * 1000 / playbackFramesPerSecond(this.project.timebase.frameRate);
    if (plan.earliestAffectedMs <= positionMs + 5000 || plan.affectedIds.some(id => this.executedCueIds.has(id) || this.missedCueIds.has(id))) {
      return '修改涉及已经播过、已执行或 5 秒内就要执行的 Cue，这一轮没有应用';
    }
    return null;
  }

  selectItem(itemId: string, currentFrame = -1): RuntimeUpdate {
    if (isProtectedRuntimeState(this.state)) return this.update([], `当前状态（${this.state}）不能切换节目`);
    const item = this.project.rundown.find((candidate) => candidate.id === itemId);
    if (!item) return this.fail(`节目不存在：${itemId}`);
    if (!item.enabled) return this.fail(`节目已停用：${item.title}`);
    this.selectedItem = item;
    this.pendingEdit = null; this.editSessionId = crypto.randomUUID(); this.executionRevision = 0;
    this.scheduledCues = compileRundownTimelineCues(item, this.project.timebase.frameRate);
    this.authoredCueIds = new Set(item.cues.map(cue => cue.id));
    this.executedCueIds.clear();
    this.missedCueIds.clear();
    this.previousFrame = currentFrame;
    for (const event of eventsBetween(this.scheduledCues, -1, currentFrame)) {
      if (event.scheduledFrame <= currentFrame) {
        this.missedCueIds.add(event.cue.id);
      }
    }
    this.state = 'idle';
    return this.update();
  }

  beginPreflight(mode: LinkRunMode): RuntimeUpdate {
    if (isProtectedRuntimeState(this.state)) return this.fail(`当前状态（${this.state}）不能重新做开播前检查`);
    this.mode = mode;
    this.state = 'preflight';
    return this.update();
  }

  /** Armed at `currentSample`, or at the song's head when there is none, until the first position comes. */
  arm(currentSample: MtcSample | null = null, executionOwner: 'local' | 'external' = 'local'): RuntimeUpdate {
    if (this.state !== 'preflight') return this.fail(`只有开播前检查完成后才能待命，当前状态：${this.state}`);
    if (!this.selectedItem) return this.fail('还没选择节目');
    if (executionOwner === 'external' && this.scheduledCues.some(entry => entry.cue.actions.some(action => action.kind.startsWith('midi.')))) {
      return this.fail('外部执行状态观察不能接管本地 MIDI Cue');
    }
    this.executionOwner = executionOwner;
    if (currentSample && currentSample.frameRate !== this.project.timebase.frameRate) {
      return this.fail(`MTC 帧率不一致：应为 ${this.project.timebase.frameRate}，收到的是 ${currentSample.frameRate}`);
    }
    this.executedCueIds.clear();
    this.missedCueIds.clear();
    this.state = 'armed';
    this.pendingEdit = null; this.editSessionId = crypto.randomUUID();
    this.previousFrame = currentSample?.totalFrames ?? -1;
    this.lastSample = currentSample;
    if (currentSample && executionOwner === 'local') this.markCuesThroughAsMissed(currentSample.totalFrames);
    return this.update();
  }

  /** Armed and not started yet: the start moves to `sample`, ahead of where it was armed. A picture prepared while the
   * music went on joins it there (0.5.9 R7); what lies before it is not executed. */
  moveStart(sample: MtcSample): RuntimeUpdate {
    if (this.state !== 'armed' || this.executionOwner !== 'local') return this.fail(`只有待命时才能改开始的位置，当前状态：${this.state}`);
    if (sample.frameRate !== this.project.timebase.frameRate) return this.fail(`MTC 帧率不一致：应为 ${this.project.timebase.frameRate}，收到的是 ${sample.frameRate}`);
    if (sample.totalFrames < this.previousFrame) return this.fail('播放起点和准备的位置对不上，请重新定位后播放');
    this.previousFrame = sample.totalFrames; this.lastSample = sample;
    this.markCuesThroughAsMissed(sample.totalFrames);
    return this.update();
  }

  ingest(sample: MtcSample): RuntimeUpdate {
    if (this.state === 'idle' || this.state === 'preflight' || this.state === 'error' || this.state === 'stopping') {
      return this.update();
    }
    if (!this.selectedItem) return this.fail('还没选择节目');
    if (sample.frameRate !== this.project.timebase.frameRate) {
      return this.fail(`MTC 帧率不一致：应为 ${this.project.timebase.frameRate}，收到的是 ${sample.frameRate}`);
    }
    // This is a display of a separately validated native playback session. UI
    // delivery gaps say nothing about that device clock or its background outputs.
    // Never generate actions, executed confirmations or missed-Cue claims here.
    if (this.executionOwner === 'external') {
      if (this.state !== 'armed' && this.state !== 'running') return this.update();
      this.lastSample = sample; this.previousFrame = sample.totalFrames;
      this.state = 'running';
      return this.update();
    }
    if (this.state === 'paused') {
      if (this.lastSample && sample.receivedAtMs - this.lastSample.receivedAtMs > MTC_LOSS_MS) {
        this.lastSample = sample;
        return this.loseTimecode('MTC 信号中断');
      }
      if (this.lastSample && isUnexpectedJump(this.lastSample, sample)) {
        const wentBackwards = sample.totalFrames < this.lastSample.totalFrames;
        this.lastSample = sample;
        return this.loseTimecode(wentBackwards ? 'MTC 时间倒退' : 'MTC 时间跳变');
      }
      this.markCrossedCuesAsMissed(sample.totalFrames);
      this.previousFrame = sample.totalFrames;
      this.lastSample = sample;
      return this.update();
    }
    if (this.state !== 'armed' && this.state !== 'running') return this.update();
    if (
      this.state === 'armed'
      && this.previousFrame === -1
      && this.lastSample === null
      && sample.totalFrames > nominalFramesPerSecond(sample.frameRate) * MTC_INITIAL_LOCK_SECONDS
    ) {
      this.lastSample = sample;
      return this.loseTimecode('MTC 不是从节目开头开始的');
    }
    // The formal audio clock is the timeline itself. A late observation whose
    // position kept time is a gap in watching, not a lost timecode.
    if (this.lastSample && sample.receivedAtMs - this.lastSample.receivedAtMs > this.observationGapMs
      && !isUnexpectedJump(this.lastSample, sample)) return this.rebuildAt(sample);
    if (this.lastSample && sample.receivedAtMs - this.lastSample.receivedAtMs > MTC_LOSS_MS) {
      this.lastSample = sample;
      return this.loseTimecode('MTC 信号中断');
    }
    if (this.lastSample && isUnexpectedJump(this.lastSample, sample)) {
      const wentBackwards = sample.totalFrames < this.lastSample.totalFrames;
      this.lastSample = sample;
      return this.loseTimecode(wentBackwards ? 'MTC 时间倒退' : 'MTC 时间跳变');
    }

    const dueCues = collectDueCues(
      this.scheduledCues,
      this.previousFrame,
      sample.totalFrames,
      this.executedCueIds,
      this.missedCueIds
    );
    for (const due of dueCues) this.executedCueIds.add(due.cue.id);
    this.previousFrame = sample.totalFrames;
    this.lastSample = sample;
    this.state = 'running';
    return this.update(dueCues);
  }

  pauseAutomatic(reason = '操作员暂停自动联动'): RuntimeUpdate {
    if (this.state !== 'armed' && this.state !== 'running') {
      return this.fail(`只有待命或运行中才能暂停，当前状态：${this.state}`);
    }
    this.state = 'paused';
    this.pendingEdit = null; this.editSessionId = crypto.randomUUID();
    return this.update([], reason);
  }

  resumeMedia(sample: MtcSample): RuntimeUpdate {
    if (this.executionOwner === 'external' && this.state === 'paused') {
      this.state = 'running'; return this.ingest(sample);
    }
    if (this.state === 'paused' && !this.lastSample && this.previousFrame === -1) {
      // Prepared at zero and paused before any audio was emitted. The first real
      // playback observation executes the opening boundary, never preparation.
      this.state = 'armed'; return this.ingest(sample);
    }
    if (this.state !== 'paused' || !this.lastSample || sample.frameRate !== this.lastSample.frameRate
      || Math.abs(sample.totalFrames - this.previousFrame) > nominalFramesPerSecond(sample.frameRate) / 4) {
      return this.fail('音频恢复位置无效，请从头重播');
    }
    this.lastSample = { ...this.lastSample, receivedAtMs: sample.receivedAtMs };
    this.state = 'running';
    return this.ingest(sample);
  }

  /** Audio has not advanced while its output/OBS transport was being prepared. */
  anchorMediaClock(sample: MtcSample): RuntimeUpdate {
    if (this.executionOwner === 'external' && ['armed', 'running'].includes(this.state)) return this.ingest(sample);
    if (!['armed', 'running'].includes(this.state)
      || !this.lastSample || sample.frameRate !== this.lastSample.frameRate
      || sample.totalFrames < this.previousFrame
      || sample.totalFrames - this.previousFrame > nominalFramesPerSecond(sample.frameRate) / 4) {
      return this.fail('播放起点和准备的位置对不上，请重新定位后播放');
    }
    const elapsed = (sample.totalFrames - this.previousFrame) * 1000 / nominalFramesPerSecond(sample.frameRate);
    this.lastSample = { ...this.lastSample, receivedAtMs: sample.receivedAtMs - elapsed };
    return this.update();
  }

  stop(reason = '操作员请求停止'): RuntimeUpdate {
    this.pendingEdit = null; this.editSessionId = crypto.randomUUID();
    this.state = 'stopping';
    this.lastSample = null;
    return this.update([], reason);
  }

  failExecution(reason: string): RuntimeUpdate {
    this.lastSample = null;
    return this.fail(reason);
  }

  completeStop(): RuntimeUpdate {
    if (this.state !== 'stopping') return this.update();
    this.state = 'idle';
    return this.update();
  }

  getMode(): LinkRunMode {
    return this.mode;
  }

  /** The hide that ends a show-source Cue's span; null for any other Cue. */
  durationEnd(cueId: string): LinkCue | null {
    return cueId.endsWith(':duration-end') ? null : this.scheduledCues.find(entry => entry.cue.id === `${cueId}:duration-end`)?.cue ?? null;
  }

  /** Recovery rule B: shown sources are state, so a show still within its span
   * goes out now and a hide whose show went out is sent; a show whose span ended
   * inside the gap is skipped with its hide. The song's own audio kept time, so
   * the gap is known, not guessed: point actions in it are sent now, in order
   * (2026-11-09: nothing on the timeline may be skipped). Everything is due at the current frame. */
  private rebuildAt(sample: MtcSample): RuntimeUpdate {
    const gapMs = Math.round(sample.receivedAtMs - this.lastSample!.receivedAtMs), frame = sample.totalFrames;
    const due: DueCue[] = []; let late = 0;
    const now = (cue: LinkCue): void => { due.push({ cue, scheduledFrame: frame, executionId: crypto.randomUUID() }); this.executedCueIds.add(cue.id); };
    if (this.selectedItem) for (const { cue } of eventsBetween(this.scheduledCues, this.previousFrame, frame)) {
      if (this.executedCueIds.has(cue.id) || this.missedCueIds.has(cue.id)) continue;
      if (cue.id.endsWith(':duration-end')) { if (this.executedCueIds.has(cue.id.slice(0, -':duration-end'.length))) now(cue); continue; }
      const end = this.scheduledCues.find(entry => entry.cue.id === `${cue.id}:duration-end`)?.scheduledFrame;
      if (end !== undefined && end > frame) { now(cue); continue; }
      if (end !== undefined) { this.executedCueIds.add(cue.id); this.executedCueIds.add(`${cue.id}:duration-end`); continue; }
      // The scene timeline rebuilds camera switches itself.
      if (cue.actions.length && cue.actions.every(action => action.kind === 'obs.setProgramScene')) { this.executedCueIds.add(cue.id); continue; }
      now(cue); late += 1;
    }
    this.previousFrame = frame; this.lastSample = sample; this.state = 'running';
    return { ...this.update(due, `播放位置更新中断了 ${gapMs} ms，画面已按当前位置恢复${late ? `，期间的 ${late} 个联动 Cue 现在补发` : ''}`), rebuild: true };
  }

  private markCrossedCuesAsMissed(currentFrame: number): void {
    if (!this.selectedItem) return;
    for (const event of eventsBetween(this.scheduledCues, this.previousFrame, currentFrame)) {
      if (!this.executedCueIds.has(event.cue.id)) {
        this.missedCueIds.add(event.cue.id);
      }
    }
  }

  private markCuesThroughAsMissed(currentFrame: number): void {
    if (!this.selectedItem) return;
    for (const event of eventsBetween(this.scheduledCues, -1, currentFrame)) {
      if (event.scheduledFrame <= currentFrame && !this.executedCueIds.has(event.cue.id)) this.missedCueIds.add(event.cue.id);
    }
  }

  private loseTimecode(reason: string): RuntimeUpdate {
    this.pendingEdit = null; this.editSessionId = crypto.randomUUID();
    this.state = 'timecodeLost';
    return this.update([], reason);
  }

  private fail(reason: string): RuntimeUpdate {
    this.pendingEdit = null; this.editSessionId = crypto.randomUUID();
    this.state = 'error';
    return this.update([], reason);
  }

  private update(dueCues: DueCue[] = [], reason?: string): RuntimeUpdate {
    return {
      state: this.state,
      dueCues,
      missedCueIds: [...this.missedCueIds],
      ...(reason ? { reason } : {})
    };
  }
}

function collectDueCues(
  events: readonly ScheduledTimelineCue[],
  previousFrame: number,
  currentFrame: number,
  executed: ReadonlySet<string>,
  missed: ReadonlySet<string>
): DueCue[] {
  const due: DueCue[] = [];
  for (const { cue, scheduledFrame } of eventsBetween(events, previousFrame, currentFrame)) {
    if (executed.has(cue.id) || missed.has(cue.id)) continue;
    // A duration end only hides what its own start showed. After a missed start
    // there is nothing to undo, and that miss was already reported.
    if (cue.id.endsWith(':duration-end') && !executed.has(cue.id.slice(0, -':duration-end'.length))) continue;
    due.push({ cue, scheduledFrame, executionId: crypto.randomUUID() });
  }
  return due;
}

/** The compiler already orders equal-frame end boundaries before starts. Keep
 * that order and visit only this clock interval, without recompiling or sorting. */
function* eventsBetween(events: readonly ScheduledTimelineCue[], previousFrame: number, currentFrame: number): Iterable<ScheduledTimelineCue> {
  let low = 0, high = events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (events[middle]!.scheduledFrame <= previousFrame) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < events.length && events[index]!.scheduledFrame <= currentFrame; index++) yield events[index]!;
}

function isUnexpectedJump(previous: MtcSample, current: MtcSample): boolean {
  if (current.totalFrames < previous.totalFrames) return true;
  const fps = nominalFramesPerSecond(current.frameRate);
  const elapsedMs = current.receivedAtMs - previous.receivedAtMs;
  const expectedFrames = elapsedMs * fps / 1000;
  const deviationMs = Math.abs(current.totalFrames - previous.totalFrames - expectedFrames) * 1000 / fps;
  return deviationMs > MTC_JUMP_MS;
}

export function isMtcSampleContinuous(previous: MtcSample, current: MtcSample): boolean {
  return current.frameRate === previous.frameRate
    && current.receivedAtMs >= previous.receivedAtMs
    && current.receivedAtMs - previous.receivedAtMs <= MTC_LOSS_MS
    && !isUnexpectedJump(previous, current);
}

function isProtectedRuntimeState(state: LinkRuntimeState): boolean {
  return state === 'armed'
    || state === 'running'
    || state === 'timecodeLost'
    || state === 'paused'
    || state === 'error'
    || state === 'stopping';
}
