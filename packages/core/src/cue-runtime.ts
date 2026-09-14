import type { LinkCue, LinkProject, MtcFrameRate, RundownItem } from '@tb/schema';
import { nominalFramesPerSecond, timecodeToFrameNumber, type MtcSample } from './mtc-timecode';
import { compileRundownTimelineCues, wasTimelineFrameCrossed } from './timeline-state';

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
  private previousFrame = -1;
  private lastSample: MtcSample | null = null;
  private armedAtMs: number | null = null;
  private readonly executedCueIds = new Set<string>();
  private readonly missedCueIds = new Set<string>();
  private manualTakeover = false;

  constructor(private readonly project: LinkProject) {}

  getState(): LinkRuntimeState {
    return this.state;
  }

  selectItem(itemId: string, currentFrame = -1): RuntimeUpdate {
    if (isProtectedRuntimeState(this.state)) return this.update([], `运行状态 ${this.state} 下不能切换节目`);
    const item = this.project.rundown.find((candidate) => candidate.id === itemId);
    if (!item) return this.fail(`节目不存在：${itemId}`);
    if (!item.enabled) return this.fail(`节目已停用：${item.title}`);
    this.selectedItem = item;
    this.executedCueIds.clear();
    this.missedCueIds.clear();
    this.previousFrame = currentFrame;
    for (const event of compileRundownTimelineCues(item, this.project.timebase.frameRate)) {
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
    startMode: 'immediate' | 'awaiting-external-start' = 'immediate'
  ): RuntimeUpdate {
    if (this.state !== 'preflight') return this.fail(`只有 preflight 状态可以布防，当前为 ${this.state}`);
    if (!this.selectedItem) return this.fail('尚未选择节目');
    if (currentSample && currentSample.frameRate !== this.project.timebase.frameRate) {
      return this.fail(`MTC 帧率不匹配：期望 ${this.project.timebase.frameRate}，收到 ${currentSample.frameRate}`);
    }
    this.executedCueIds.clear();
    this.missedCueIds.clear();
    this.state = 'armed';
    this.previousFrame = currentSample?.totalFrames ?? -1;
    this.lastSample = currentSample;
    this.armedAtMs = currentSample || startMode === 'awaiting-external-start' ? null : nowMs;
    this.manualTakeover = false;
    if (currentSample) this.markCuesThroughAsMissed(currentSample.totalFrames);
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
      this.selectedItem,
      this.project.timebase.frameRate,
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
    this.previousFrame = sample.totalFrames;
    this.lastSample = sample;
    this.armedAtMs = null;
    if (this.selectedItem) {
      for (const event of compileRundownTimelineCues(this.selectedItem, this.project.timebase.frameRate)) {
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
    return this.update([], reason);
  }

  resumeAutomatic(): RuntimeUpdate {
    if (this.state !== 'paused') return this.fail(`只有 paused 状态可以恢复，当前为 ${this.state}`);
    if (this.manualTakeover) return this.fail('手动接管期间不能恢复自动联动，必须停止后重新预检');
    this.state = this.lastSample ? 'running' : 'armed';
    return this.update();
  }

  resumeMedia(sample: MtcSample): RuntimeUpdate {
    if (this.state !== 'paused' || !this.lastSample || sample.frameRate !== this.lastSample.frameRate
      || Math.abs(sample.totalFrames - this.previousFrame) > nominalFramesPerSecond(sample.frameRate) / 4) {
      return this.fail('内部音频恢复位置无效，请从头重播');
    }
    this.lastSample = { ...this.lastSample, receivedAtMs: sample.receivedAtMs };
    this.state = 'running';
    return this.ingest(sample);
  }

  manualGo(cueId: string): RuntimeUpdate {
    if (!this.manualTakeover || !this.selectedItem) return this.fail('手动接管尚未确认');
    const cue = this.selectedItem.cues.find((candidate) => candidate.id === cueId);
    if (!cue) return this.fail(`Cue 不存在：${cueId}`);
    if (!cue.enabled) return this.fail(`Cue 已停用：${cue.name}`);
    if (this.executedCueIds.has(cue.id)) return this.fail(`Cue 已执行：${cue.name}`);
    const runnableCue = compileRundownTimelineCues(this.selectedItem, this.project.timebase.frameRate)
      .find((entry) => entry.cue.id === cue.id)?.cue;
    if (!runnableCue) return this.fail(`Cue 所在视觉图层已隐藏：${cue.name}`);
    this.executedCueIds.add(cue.id);
    return this.update([{ cue: runnableCue, scheduledFrame: timecodeToFrameNumber(runnableCue.timecode, this.project.timebase.frameRate), executionId: crypto.randomUUID() }]);
  }

  stop(): RuntimeUpdate {
    this.state = 'stopping';
    this.lastSample = null;
    this.armedAtMs = null;
    this.manualTakeover = false;
    return this.update([], '操作员请求停止');
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
    for (const event of compileRundownTimelineCues(this.selectedItem, this.project.timebase.frameRate)) {
      if (
        wasTimelineFrameCrossed(this.previousFrame, currentFrame, event.scheduledFrame)
        && !this.executedCueIds.has(event.cue.id)
      ) {
        this.missedCueIds.add(event.cue.id);
      }
    }
  }

  private markCuesThroughAsMissed(currentFrame: number): void {
    if (!this.selectedItem) return;
    for (const event of compileRundownTimelineCues(this.selectedItem, this.project.timebase.frameRate)) {
      if (event.scheduledFrame <= currentFrame && !this.executedCueIds.has(event.cue.id)) this.missedCueIds.add(event.cue.id);
    }
  }

  private loseTimecode(reason: string): RuntimeUpdate {
    this.state = 'timecodeLost';
    return this.update([], reason);
  }

  private fail(reason: string): RuntimeUpdate {
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
  item: RundownItem,
  frameRate: MtcFrameRate,
  previousFrame: number,
  currentFrame: number,
  executed: ReadonlySet<string>,
  missed: ReadonlySet<string>
): DueCue[] {
  return compileRundownTimelineCues(item, frameRate)
    .filter(({ cue }) => !executed.has(cue.id) && !missed.has(cue.id))
    .filter(({ scheduledFrame }) => wasTimelineFrameCrossed(previousFrame, currentFrame, scheduledFrame))
    .sort((left, right) => left.scheduledFrame - right.scheduledFrame)
    .map(({ cue, scheduledFrame }) => ({ cue, scheduledFrame, executionId: crypto.randomUUID() }));
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
