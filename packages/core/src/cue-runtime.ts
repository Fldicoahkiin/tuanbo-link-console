import type { LinkCue, LinkProject, RundownItem } from '@tb/schema';
import { nominalFramesPerSecond, timecodeToFrameNumber, type MtcSample } from './mtc-timecode';
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
  manualTakeover: boolean;
  dueCues: DueCue[];
  missedCueIds: string[];
  reason?: string;
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
  private armedAtMs: number | null = null;
  private readonly executedCueIds = new Set<string>();
  private readonly missedCueIds = new Set<string>();
  private manualTakeover = false;
  private executionOwner: 'local' | 'external' = 'local';

  constructor(private readonly project: LinkProject) {}

  getState(): LinkRuntimeState {
    return this.state;
  }

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
      if (confirmation?.state !== 'ready') return { status: 'not-applied', reason: confirmation?.reason ?? `${channel} 尚未完成此次修改的准备` };
    }
    this.selectedItem = plan.item; this.scheduledCues = plan.events;
    this.authoredCueIds = new Set(plan.item.cues.map(cue => cue.id)); this.executionRevision++;
    return { status: 'applied', revision: this.executionRevision };
  }

  private editIdentityError(request: Pick<LiveCueEditRequest, 'sessionId' | 'programId' | 'baseRevision'>): string | null {
    if (this.state !== 'armed' && this.state !== 'running') return '当前不在可以接收未来修改的播放会话中';
    if (request.sessionId !== this.editSessionId || request.programId !== this.selectedItem?.id) return '播放会话或节目已经改变';
    if (request.baseRevision !== this.executionRevision) return '修改依据的运行版本已经过期';
    return null;
  }

  private editBoundaryError(plan: PreparedCueEdit): string | null {
    const positionMs = Math.max(0, this.previousFrame) * 1000 / playbackFramesPerSecond(this.project.timebase.frameRate);
    if (plan.earliestAffectedMs <= positionMs + 5000 || plan.affectedIds.some(id => this.executedCueIds.has(id) || this.missedCueIds.has(id))) {
      return '修改涉及过去、已执行或未来 5 秒保护窗口内的 Cue，本轮未应用';
    }
    return null;
  }

  selectItem(itemId: string, currentFrame = -1): RuntimeUpdate {
    if (isProtectedRuntimeState(this.state)) return this.update([], `运行状态 ${this.state} 下不能切换节目`);
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
    if (isProtectedRuntimeState(this.state)) return this.fail(`运行状态 ${this.state} 下不能重新预检`);
    this.mode = mode;
    this.state = 'preflight';
    return this.update();
  }

  arm(
    nowMs = performance.now(),
    currentSample: MtcSample | null = null,
    startMode: 'immediate' | 'awaiting-external-start' = 'immediate',
    executionOwner: 'local' | 'external' = 'local'
  ): RuntimeUpdate {
    if (this.state !== 'preflight') return this.fail(`只有 preflight 状态可以布防，当前为 ${this.state}`);
    if (!this.selectedItem) return this.fail('尚未选择节目');
    if (executionOwner === 'external' && (this.project.playbackSource !== 'internal'
      || this.scheduledCues.some(entry => entry.cue.actions.some(action => action.kind.startsWith('midi.'))))) {
      return this.fail('外部执行状态观察不能接管 P1 输入或本地 MIDI Cue');
    }
    this.executionOwner = executionOwner;
    if (currentSample && currentSample.frameRate !== this.project.timebase.frameRate) {
      return this.fail(`MTC 帧率不匹配：期望 ${this.project.timebase.frameRate}，收到 ${currentSample.frameRate}`);
    }
    this.executedCueIds.clear();
    this.missedCueIds.clear();
    this.state = 'armed';
    this.pendingEdit = null; this.editSessionId = crypto.randomUUID();
    this.previousFrame = currentSample?.totalFrames ?? -1;
    this.lastSample = currentSample;
    this.armedAtMs = currentSample || startMode === 'awaiting-external-start' ? null : nowMs;
    this.manualTakeover = false;
    if (currentSample && executionOwner === 'local') this.markCuesThroughAsMissed(currentSample.totalFrames);
    return this.update();
  }

  ingest(sample: MtcSample): RuntimeUpdate {
    if (this.state === 'idle' || this.state === 'preflight' || this.state === 'error' || this.state === 'stopping') {
      return this.update();
    }
    if (!this.selectedItem) return this.fail('尚未选择节目');
    if (sample.frameRate !== this.project.timebase.frameRate) {
      return this.fail(`MTC 帧率不匹配：期望 ${this.project.timebase.frameRate}，收到 ${sample.frameRate}`);
    }
    // This is a display of a separately validated native playback session. UI
    // delivery gaps say nothing about that device clock or its background outputs.
    // Never generate actions, executed confirmations or missed-Cue claims here.
    if (this.executionOwner === 'external') {
      if (this.state !== 'armed' && this.state !== 'running') return this.update();
      this.lastSample = sample; this.previousFrame = sample.totalFrames;
      this.armedAtMs = null; this.state = 'running';
      return this.update();
    }
    if (this.state === 'paused' && !this.manualTakeover) {
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
      this.armedAtMs = null;
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
      return this.loseTimecode('MTC 首帧未从节目开头开始');
    }
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
    this.armedAtMs = null;
    this.state = 'running';
    return this.update(dueCues);
  }

  tick(nowMs: number): RuntimeUpdate {
    if (this.executionOwner === 'external') return this.update();
    if (
      (this.state === 'armed' || (this.state === 'paused' && !this.manualTakeover))
      && this.lastSample === null
      && this.armedAtMs !== null
      && nowMs - this.armedAtMs > MTC_LOSS_MS
    ) {
      return this.loseTimecode('MTC 信号中断');
    }
    if (
      (this.state === 'armed' || this.state === 'running' || (this.state === 'paused' && !this.manualTakeover))
      && this.lastSample
      && nowMs - this.lastSample.receivedAtMs > MTC_LOSS_MS
    ) {
      return this.loseTimecode('MTC 信号中断');
    }
    return this.update();
  }

  resync(sample: MtcSample): RuntimeUpdate {
    if (this.state !== 'timecodeLost') return this.fail(`只有 timecodeLost 状态可以重同步，当前为 ${this.state}`);
    this.pendingEdit = null; this.editSessionId = crypto.randomUUID();
    this.previousFrame = sample.totalFrames;
    this.lastSample = sample;
    this.armedAtMs = null;
    if (this.selectedItem) {
      for (const event of eventsBetween(this.scheduledCues, -1, sample.totalFrames)) {
        if (event.scheduledFrame <= sample.totalFrames && !this.executedCueIds.has(event.cue.id)) {
          this.missedCueIds.add(event.cue.id);
        }
      }
    }
    this.state = 'running';
    return this.update();
  }

  resumeP1(sample: MtcSample): RuntimeUpdate {
    if (this.state !== 'timecodeLost' || !this.lastSample) return this.fail('P1 恢复前没有可验证的暂停位置');
    const delta = sample.totalFrames - this.previousFrame;
    if (sample.frameRate !== this.lastSample.frameRate || delta < 0 || delta > nominalFramesPerSecond(sample.frameRate) / 4) {
      return this.fail('P1 恢复位置发生跳变，请从歌曲开头重新播放');
    }
    this.lastSample = { ...this.lastSample, receivedAtMs: sample.receivedAtMs - delta * 1000 / nominalFramesPerSecond(sample.frameRate) };
    this.state = 'running';
    return this.ingest(sample);
  }

  rearmFromStart(nowMs = performance.now()): RuntimeUpdate {
    if (this.state !== 'timecodeLost') return this.fail(`只有 timecodeLost 状态可以从头重新布防，当前为 ${this.state}`);
    this.pendingEdit = null; this.editSessionId = crypto.randomUUID();
    this.executedCueIds.clear();
    this.missedCueIds.clear();
    this.previousFrame = -1;
    this.lastSample = null;
    this.armedAtMs = nowMs;
    this.manualTakeover = false;
    this.state = 'armed';
    return this.update();
  }

  enableManualTakeover(currentSample: MtcSample | null = null): RuntimeUpdate {
    if (this.state !== 'timecodeLost') return this.fail(`只有 timecodeLost 状态可以进入手动接管，当前为 ${this.state}`);
    if (currentSample) {
      this.markCuesThroughAsMissed(currentSample.totalFrames);
      this.previousFrame = currentSample.totalFrames;
      this.lastSample = currentSample;
    }
    this.manualTakeover = true;
    this.state = 'paused';
    return this.update();
  }

  pauseAutomatic(reason = '操作员暂停自动联动'): RuntimeUpdate {
    if (this.state !== 'armed' && this.state !== 'running') {
      return this.fail(`只有 armed 或 running 状态可以暂停，当前为 ${this.state}`);
    }
    this.state = 'paused';
    this.pendingEdit = null; this.editSessionId = crypto.randomUUID();
    return this.update([], reason);
  }

  resumeAutomatic(): RuntimeUpdate {
    if (this.state !== 'paused') return this.fail(`只有 paused 状态可以恢复，当前为 ${this.state}`);
    if (this.manualTakeover) return this.fail('手动接管期间不能恢复自动联动，必须停止后重新预检');
    this.state = this.lastSample ? 'running' : 'armed';
    return this.update();
  }

  resumeMedia(sample: MtcSample): RuntimeUpdate {
    if (this.executionOwner === 'external' && this.state === 'paused') {
      this.state = 'running'; return this.ingest(sample);
    }
    if (this.project.playbackSource === 'internal' && this.state === 'paused' && !this.lastSample && this.previousFrame === -1) {
      // Prepared at zero and paused before any audio was emitted. The first real
      // playback observation executes the opening boundary, never preparation.
      this.state = 'armed'; return this.ingest(sample);
    }
    if (this.state !== 'paused' || !this.lastSample || sample.frameRate !== this.lastSample.frameRate
      || Math.abs(sample.totalFrames - this.previousFrame) > nominalFramesPerSecond(sample.frameRate) / 4) {
      return this.fail('内部音频恢复位置无效，请从头重播');
    }
    this.lastSample = { ...this.lastSample, receivedAtMs: sample.receivedAtMs };
    this.state = 'running';
    return this.ingest(sample);
  }

  /** Audio has not advanced while its output/OBS transport was being prepared. */
  anchorMediaClock(sample: MtcSample): RuntimeUpdate {
    if (this.executionOwner === 'external' && this.project.playbackSource === 'internal' && ['armed', 'running'].includes(this.state)) return this.ingest(sample);
    if (this.project.playbackSource !== 'internal' || !['armed', 'running'].includes(this.state)
      || !this.lastSample || sample.frameRate !== this.lastSample.frameRate
      || sample.totalFrames < this.previousFrame
      || sample.totalFrames - this.previousFrame > nominalFramesPerSecond(sample.frameRate) / 4) {
      return this.fail('本机播放起点与准备位置不一致，请重新定位后播放');
    }
    const elapsed = (sample.totalFrames - this.previousFrame) * 1000 / nominalFramesPerSecond(sample.frameRate);
    this.lastSample = { ...this.lastSample, receivedAtMs: sample.receivedAtMs - elapsed };
    return this.update();
  }

  manualGo(cueId: string): RuntimeUpdate {
    if (this.executionOwner === 'external') return this.update([], '该会话由后台执行，界面观察器不能发送 Cue');
    if (!this.manualTakeover || !this.selectedItem) return this.fail('手动接管尚未确认');
    const cue = this.selectedItem.cues.find((candidate) => candidate.id === cueId);
    if (!cue) return this.fail(`Cue 不存在：${cueId}`);
    if (!cue.enabled) return this.fail(`Cue 已停用：${cue.name}`);
    if (this.executedCueIds.has(cue.id)) return this.fail(`Cue 已执行：${cue.name}`);
    const runnableCue = this.scheduledCues
      .find((entry) => entry.cue.id === cue.id)?.cue;
    if (!runnableCue) return this.fail(`Cue 所在视觉图层已隐藏：${cue.name}`);
    this.executedCueIds.add(cue.id);
    return this.update([{ cue: runnableCue, scheduledFrame: timecodeToFrameNumber(runnableCue.timecode, this.project.timebase.frameRate), executionId: crypto.randomUUID() }]);
  }

  stop(reason = '操作员请求停止'): RuntimeUpdate {
    this.pendingEdit = null; this.editSessionId = crypto.randomUUID();
    this.state = 'stopping';
    this.lastSample = null;
    this.armedAtMs = null;
    this.manualTakeover = false;
    return this.update([], reason);
  }

  abortStart(reason: string): RuntimeUpdate {
    if (this.state !== 'armed') return this.fail(`只有 armed 状态可以中止 P1 启动，当前为 ${this.state}`);
    this.lastSample = null;
    this.armedAtMs = null;
    this.state = 'error';
    return this.update([], reason);
  }

  failExecution(reason: string): RuntimeUpdate {
    this.lastSample = null;
    this.armedAtMs = null;
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
      manualTakeover: this.manualTakeover,
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
    if (!executed.has(cue.id) && !missed.has(cue.id)) due.push({ cue, scheduledFrame, executionId: crypto.randomUUID() });
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
