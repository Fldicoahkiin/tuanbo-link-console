import type { LinkCue, LinkProject } from '@tb/schema';
import { actionResultLog, CueActionRunner, type CueExecutionReport, type LinkActionExecutor } from './cue-action-runner';
import { CueRuntime, type DueCue, type RuntimeUpdate } from './cue-runtime';
import { frameNumberToTimecode, millisecondsToFrameNumber, playbackFramesPerSecond, type MtcSample } from './mtc-timecode';
import { ManagedOutputRuntime, type ManagedMediaExecutionReport, type ManagedOutputRuntimeDependencies } from './managed-output-runtime';
import { MANAGED_OBS_SCENE_NAME, type ManagedMediaEvent } from './managed-media-timeline';
import type { SceneOutputTimeline } from './scene-output-timeline';

export type ObsProgramSessionDependencies = ManagedOutputRuntimeDependencies & {
  /** `canSend` is checked before every request; `dispatched` runs when one is sent. */
  guardOutput: <T>(canSend: () => boolean, operation: () => Promise<T>, dispatched?: () => void) => Promise<T>;
  prepareOutputs: (assertCurrent: () => void) => Promise<void>;
  outputNotice?: () => string | null;
  /** Returns the clip it made ready; one already past its boundary starts late (rule B). */
  prepareUpcoming?: (frame: number, assertCurrent: () => void) => Promise<ManagedMediaEvent | null>;
  releaseOutputs: () => Promise<void>;
  executor: LinkActionExecutor;
  seekMedia: (event: ManagedMediaEvent) => Promise<void>;
  /** Puts a playing clip back in step with the music; returns the drift corrected, or null. */
  correctMediaDrift?: (event: ManagedMediaEvent) => Promise<number | null>;
  cueReport: (report: CueExecutionReport) => void;
  mediaReport: (report: ManagedMediaExecutionReport) => void;
  state: (update: RuntimeUpdate) => void;
  /** A live output fault: shown in red while the channel keeps running. */
  fault: (message: string) => void;
  now: () => number;
};

/** Lateness up to this is logged; beyond it the operator sees it in red. Either way the action is sent. */
const LATE_LOG_MS = 100, LATE_FAULT_MS = 1000;
const lateText = (label: string, lateMs: number): string => `画面动作晚了 ${lateMs} ms 才发出：${label}。电脑或 OBS 当时太忙，画面已经按时间线切过去了`;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
type TimelineEntry = { frame: number; priority: number; cue: LinkCue; executionId: string } | { frame: number; priority: number; event: ManagedMediaEvent };
type SceneWork = ReturnType<SceneOutputTimeline['cross']>;
/** One clock step's timeline work, kept until all of it has been sent. `shift`:
 * how long pauses held it, which is not the computer's lateness. */
type Crossing = { from: number; due: RuntimeUpdate['dueCues']; media: ManagedMediaEvent[];
  work: SceneWork; dueAt: (frame: number) => number; earliestDueMs: number; shift: number };
/** What OBS shows as far as this session knows. `known`: the picture where the
 * first queued crossing starts. `rebuilt`: the picture at `rebuiltAt`, where a
 * rebuild left it while crossings from before it were still queued. `partial`: a
 * pause stopped a send between two of its steps. `lost`: OBS reconnected and the
 * picture is not rebuilt yet. */
type Picture = 'known' | 'rebuilt' | 'partial' | 'lost';
/** `lateMs`: the most any step went out after it was due, or null if nothing went out. */
type SendResult = { complete: boolean; lateMs: number | null };
/** A part of a rebuilt picture that did not come back: what it was, and why. */
export type ObsRecoveryMiss = { label: string; reason: string };
/** What a rebuild did: `sent` parts of the picture (cameras, shown sources, owed
 * hides, clips located), `succeeded` of them OBS carried out, `failed` what did not
 * come back and why (clips not played again included), and `failure` why the owned
 * scenes were not prepared again (null when they were). */
export type ObsRecovery = { sent: number; succeeded: number; failed: ObsRecoveryMiss[]; failure: string | null };
/** How a rebuild's parts came back, counted as they do. */
type Tally = { succeeded: number; failed: ObsRecoveryMiss[] };
/** A part sent as a Cue is back once OBS carried out each of its actions; each one it did not is a miss, with why. */
function tallyCue(tally: Tally, report: CueExecutionReport): void {
  const missed = report.results.filter(result => result.status !== 'succeeded');
  if (!missed.length) tally.succeeded++;
  for (const result of missed) tally.failed.push({ label: result.action.label, reason: result.error ?? '没有完成' });
}
/** The red text for a rebuilt picture (2026-11-09: it never says more came back
 * than did): what happened and what came back, each part that did not with why,
 * then what to do. `reconnect`: rebuilt as OBS reconnected, at the current
 * position; otherwise on the resume after it, at the resumed position. */
export function obsRecoveryText(recovery: ObsRecovery, reconnect: boolean): string {
  const at = reconnect ? '当前位置' : '继续播放的位置', scenesLost = recovery.failure !== null;
  // What happened first: OBS came back, and whether the owned scenes were prepared again.
  const opening = !scenesLost ? (reconnect ? 'OBS 已重新连接，' : '')
    : `${reconnect ? 'OBS 已重新连接，但' : 'OBS 重新连接后'}素材场景没有重新准备好：${recovery.failure}。`;
  const picture = scenesLost ? '机位' : '画面', missed = recovery.failed;
  if (!missed.length) return `${opening}${picture}已按${at}恢复（${recovery.sent} 项）${scenesLost ? '，素材可能播不出来' : ''}`;
  const reason = (miss: ObsRecoveryMiss): string => miss.reason.replace(/[。；\s]+$/, '');
  const what = missed.length === 1 ? `${missed[0]!.label}没有完成。原因：${reason(missed[0]!)}`
    : `${missed.length} 项没有完成：${missed.map(miss => `${miss.label}（原因：${reason(miss)}）`).join('；')}`;
  const back = recovery.succeeded ? `${picture}按${at}恢复了 ${recovery.succeeded} 项，` : `${picture}没有按${at}恢复，`;
  return `${opening}${back}${what}。${scenesLost ? '素材可能播不出来，' : ''}请在 OBS 里检查${missed.length === 1 ? '这一项' : '这几项'}，需要的话手动调好`;
}
const DURATION_END = ':duration-end';
function timelineEntries(work: SceneWork): TimelineEntry[] {
  return [
    ...work.cues.map(entry => ({ frame: entry.scheduledFrame, priority: 1, cue: entry.cue, executionId: entry.executionId })),
    ...work.media.map(event => ({ frame: event.frameNumber, priority: event.phase === 'stop' ? 0 : 2, event }))
  ].sort((left, right) => left.frame - right.frame || left.priority - right.priority);
}

/** Owns an immutable program and consumes device-clock observations. No renderer,
 * wall-clock playhead, or UI lifetime participates in scheduling. The host must
 * prepare resources and bind this session to a specific native audio generation. */
export class ObsProgramSession {
  private preloadWork: Promise<void> | null = null;
  /** Set while rebuild prepares the owned scenes again; no new decoder preparation starts. */
  private restoring = false;
  /** Clip starts that failed this session; a late-ready decoder may start each once. */
  private readonly failedStarts = new Set<string>();
  /** Drift is checked every 5 s, never within 1 s of a media start, resume or seek. */
  private nextDriftCheck = -Infinity;
  private preloadFrame = -Infinity;
  private readonly runtime: CueRuntime;
  private readonly managed: ManagedOutputRuntime;
  private readonly runner: CueActionRunner;
  private tail: Promise<void> = Promise.resolve();
  /** Crossed but not yet completely sent, oldest first. Sent together as the
   * picture at the latest one: after OBS answered slowly, superseded switches are
   * not flashed one by one; after a pause, the resume restores what it cancelled. */
  private readonly crossings: Crossing[] = [];
  private drainQueued = false;
  /** `known` and `rebuilt` send what changed since the picture OBS shows; anything
   * else makes the next send the whole picture at the current position. */
  private picture: Picture = 'known';
  /** The frame of the picture a rebuild left, while `picture` is `rebuilt`. */
  private rebuiltAt = -1;
  /** What already went out for the queued crossings, failed or not, so the picture
   * sent for them later does not send it again: point Cues by execution, clip
   * events by id, and the shows the reconnect rebuild sent again, by Cue. */
  private readonly sentDue = new Set<string>();
  private readonly attemptedMedia = new Set<string>();
  private readonly maybeShown = new Set<string>();
  /** Set by an OBS reconnect until the owned scenes are prepared again; a pause leaves it for the resume. */
  private pendingRestore: (() => Promise<void>) | null = null;
  /** Reconnect rebuilds queued behind the work in flight and not started yet: the
   * picture is rebuilt once, by the latest reconnect, not first by a drain queued
   * before it. Such a drain leaves the picture to them and does not wait in a loop:
   * each rebuild sends what is still queued once it is done. */
  private queuedRebuilds = 0;
  /** Why the last restore failed, until the rebuild after it reports it. */
  private restoreFailure: string | null = null;
  /** Counts reconnects: a send that started before one does not mark the picture known. */
  private losses = 0;
  /** Shows that went out and whose hide has not, by show Cue: a stop hides them. */
  private readonly openShows = new Map<string, LinkCue>();
  /** Inputs a play request may have reached after the pause went out: paused once it settled. */
  private readonly startedWhilePaused = new Set<string>();
  private pausedAt = 0;
  private generation = 0;
  private queued = 0;
  private frame = -1;
  private prepared = false;
  private preparing = false;
  private advancing = false;
  private failure: Error | null = null;
  private closed = false;
  private stopping: Promise<void> | null = null;

  constructor(private readonly project: LinkProject, projectPath: string, private readonly itemId: string,
    private readonly dependencies: ObsProgramSessionDependencies) {
    if (project.playbackSource !== 'internal') throw new Error('后台画面只支持“联动台播放”的工程');
    const item = project.rundown.find(entry => entry.id === itemId);
    if (!item) throw new Error('后台画面节目不存在');
    // Other outputs belong to independent channels, never pretend that an OBS
    // executor sent MIDI or a console action.
    if (item.cues.some(cue => cue.actions.some(action => !action.kind.startsWith('obs.')))) throw new Error('后台画面快照含非 OBS 动作，必须先分配到对应输出通道');
    // Picture actions have a 100 ms execution boundary; any longer silence between
    // device observations is a gap rebuilt at the current position (rule B).
    this.runtime = new CueRuntime(project, 100);
    this.managed = new ManagedOutputRuntime(project, projectPath, dependencies);
    // Live mode: a failed action is reported in red and later actions still run.
    // No time limit on a whole action: the OBS request scheduler limits each of
    // its requests, so a slow action ends in order instead of being reported
    // timed out while its last requests still go out after a newer switch.
    this.runner = new CueActionRunner([dependencies.executor], { now: dependencies.now, obsTimeoutMs: null,
      onStatus: event => {
        const entry = actionResultLog(event);
        return entry ? dependencies.recordLog({ ...entry, category: 'action', projectId: project.projectId, itemId,
          cueId: event.cueId, actionId: event.actionId, executionId: event.executionId, device: 'obs' }).then(() => undefined) : Promise.resolve();
      }
    });
    this.requireUpdate(this.runtime.selectItem(itemId));
    this.managed.selectItem(itemId);
  }

  get error(): Error | null { return this.failure; }
  get pendingCount(): number { return this.queued; }
  get nextCueId(): string | null { return this.runtime.getNextCueId(this.frame); }
  settled(): Promise<void> { return this.tail; }
  abort(reason: string): void { this.fail(new Error(reason)); }

  async prepare(positionMs: number): Promise<void> {
    if (this.prepared || this.preparing || this.closed) throw new Error('画面会话已准备或关闭');
    this.preparing = true;
    const operation = this.prepareSession(positionMs);
    this.tail = operation.catch(error => { if (!this.closed) this.fail(error); });
    try { await operation; } finally { this.preparing = false; }
  }
  private async prepareSession(positionMs: number): Promise<void> {
    const generation = ++this.generation;
    this.requireUpdate(this.runtime.beginPreflight('live'));
    await this.dependencies.guardOutput(() => generation === this.generation && !this.closed && !this.failure,
      () => this.dependencies.prepareOutputs(() => this.requireCurrent(generation)));
    this.requireCurrent(generation);
    const sample = this.sample(positionMs);
    this.requireUpdate(this.runtime.arm(this.dependencies.now(), positionMs > 0 ? sample : null, 'awaiting-external-start'));
    this.frame = positionMs > 0 ? sample.totalFrames : -1;
    if (positionMs > 0) {
      // Shown sources are state, as after a position gap: a show whose span covers
      // the start goes out now, after the camera, and its end hides it on time.
      const work = this.managed.sceneTimeline!.restore(sample.totalFrames, this.runtime.shownSourcesAt(sample.totalFrames));
      const allowed = (): boolean => generation === this.generation && !this.closed;
      // Live: a failed camera or seek is shown in red and the rest of the picture
      // is still prepared, as from the start of the song. Only cancellation ends it.
      for (const entry of work.cues) {
        this.requireCurrent(generation);
        await this.cue(entry.cue, allowed);
      }
      const targets = work.media.map(event => this.managed.alignEvent(event, sample.totalFrames));
      // A seek may reach OBS before its acknowledgement is interrupted. Retain
      // the intended owned targets so cancellation can clean them up as well.
      this.managed.adoptSeek(targets, sample.totalFrames); this.settleMedia(sample.totalFrames);
      for (const event of targets) {
        this.requireCurrent(generation);
        try { await this.dependencies.guardOutput(allowed, () => this.dependencies.seekMedia(event)); }
        catch (error) {
          this.requireCurrent(generation);
          this.fault(`素材没有对准开始的位置：${event.assetName}：${errorText(error)}。音乐照常播放，这个素材的画面可能和音乐对不上`);
        }
      }
      this.requireCurrent(generation);
    }
    this.requireCurrent(generation);
    this.prepared = true;
  }

  /** Called only for playing/ended observations from the bound device. A late
   * observation still counts: what it crossed is sent now (2026-11-09: a switch
   * on the timeline must never be skipped because the computer or OBS was busy). */
  clock(positionMs: number, observedAt = this.dependencies.now()): void {
    if (!this.prepared || this.closed || this.failure) return;
    try {
      const age = this.dependencies.now() - observedAt;
      if (!Number.isFinite(age) || age < 0) throw new Error(`播放位置的时间无效（已过 ${age} ms），画面联动已停止`);
      const sample = this.sample(positionMs, observedAt), previousFrame = this.frame;
      let update: RuntimeUpdate;
      if (this.runtime.getState() === 'paused') {
        update = this.runtime.resumeMedia(sample);
        this.requireUpdate(update);
        // The pause is not lateness: what it held is measured as if sent from here.
        for (const crossing of this.crossings) crossing.shift += observedAt - this.pausedAt;
        // A picture still to be rebuilt plays its clips itself, once they are located.
        if (this.picture !== 'lost') this.enqueueTransport('start', observedAt);
      } else {
        if (!this.advancing && previousFrame >= 0) this.requireUpdate(this.runtime.anchorMediaClock(sample));
        update = this.runtime.ingest(sample);
        this.requireUpdate(update);
        // A rebuild after stalled position updates is always reported.
        if (update.state === 'running' && update.reason) this.fault(update.reason);
      }
      this.advancing = true; this.frame = sample.totalFrames;
      if (update.state !== 'running') return;
      this.preload(sample.totalFrames); this.watchDrift(sample.totalFrames);
      const media = this.managed.collectCrossed(previousFrame, sample.totalFrames);
      const work = update.rebuild ? this.managed.sceneTimeline!.rebuild(previousFrame, sample.totalFrames, update.dueCues, media)
        : this.managed.sceneTimeline!.cross(previousFrame, sample.totalFrames, update.dueCues, media);
      if (work.cues.length || work.media.length) {
        if (work.media.length) this.settleMedia(sample.totalFrames);
        const dueAt = (scheduledFrame: number): number => observedAt
          - Math.max(0, sample.totalFrames - scheduledFrame) * 1000 / playbackFramesPerSecond(sample.frameRate);
        this.crossings.push({ from: previousFrame, due: update.dueCues, media, work, dueAt,
          earliestDueMs: dueAt(timelineEntries(work)[0]!.frame), shift: 0 });
      }
      // A resume with nothing newly crossed still sends what the pause held back,
      // and rebuilds a picture that a pause kept from being rebuilt.
      if (this.crossings.length || this.picture === 'lost') this.scheduleDrain();
    } catch (error) { this.fail(error); }
  }

  /** At most one waiting drain: it takes every crossing present when it runs. */
  private scheduleDrain(): void {
    if (this.drainQueued || this.closed || this.failure) return;
    this.drainQueued = true; this.queued++;
    this.tail = this.tail.then(() => { this.drainQueued = false; return this.drain(); })
      .catch(error => this.fault(`画面动作出错：${error instanceof Error ? error.message : String(error)}`)).finally(() => { this.queued--; });
  }
  /** One crossing goes out as computed. Several (OBS answered slowly, or a pause
   * held them) go out once as the picture now: a switch already superseded is
   * not shown, a clip that started and ended meanwhile does not start, and the
   * late time is reported once (2026-11-09: what the timeline shows now is never
   * skipped). Crossings leave only once completely sent; nothing that went out,
   * failed or not, is sent again. A picture lost to an OBS reconnect is rebuilt
   * first, once: by that reconnect's own rebuild while it is still queued. */
  private async drain(): Promise<void> {
    if (!this.playing()) return;
    if (this.picture === 'lost') {
      // A reconnect queued behind this drain rebuilds the picture, reports it
      // once and then sends what is still queued (see rebuild).
      if (this.queuedRebuilds) return;
      let rebuilt: ObsRecovery | null;
      // Not tried again by itself: the next send is the whole picture then.
      try { rebuilt = await this.recover(); }
      catch (error) { this.dropQueued(); this.picture = 'partial'; this.fault(`画面动作出错：${errorText(error)}`); return; }
      finally { this.restoring = this.picture === 'lost'; }
      if (!rebuilt) return;
      this.fault(obsRecoveryText(rebuilt, false));
      if (!this.playing() || this.picture === 'lost') return;
    }
    const generation = this.generation, losses = this.losses;
    const current = (): boolean => generation === this.generation && !this.closed && !this.failure;
    try {
      if (!this.crossings.length) return;
      const taken = this.crossings.slice(), only = taken.length === 1 && this.picture === 'known' ? taken[0]! : null;
      const entries = timelineEntries(only ? only.work : this.catchUp(taken));
      // Merged: every step is measured from the earliest time the backlog was due,
      // when it goes out, and reported once; its own answer time is not counted.
      const earliest = Math.min(...taken.map(crossing => crossing.earliestDueMs + crossing.shift));
      const sent = await this.send(entries, current, only ? frame => only.dueAt(frame) + only.shift : () => earliest, Boolean(only));
      // A reconnect meanwhile: what OBS shows is lost, whatever this send did.
      if (losses !== this.losses) return;
      // A pause came between two steps. The rest goes out on resume as part of the picture then.
      if (!sent.complete) { this.picture = 'partial'; return; }
      this.crossings.splice(0, taken.length); this.forgetSent(); this.picture = 'known';
      if (only || sent.lateMs === null || sent.lateMs <= LATE_LOG_MS) return;
      this.late(sent.lateMs, `画面晚了 ${sent.lateMs} ms：电脑或 OBS 当时太忙，${taken.length > 1
        ? `积压的 ${taken.length} 批画面动作已合并，` : ''}直接切到了现在该有的画面`);
    } catch (error) {
      // Reported once, not again on every clock step: what this drain took is
      // dropped, and the next send is the whole picture at that time.
      if (losses === this.losses) this.dropQueued();
      this.fault(`画面动作出错：${errorText(error)}`);
    }
  }
  private dropQueued(): void {
    this.crossings.length = 0; this.forgetSent();
    if (this.picture !== 'lost') this.picture = 'partial';
  }
  private forgetSent(): void { this.sentDue.clear(); this.attemptedMedia.clear(); this.maybeShown.clear(); }
  private playing(): boolean { return !this.closed && !this.failure && this.runtime.getState() === 'running'; }
  /** The picture at the current position for queued crossings: what changed since
   * the picture OBS shows (everything, when that is not known), the stops of
   * clips OBS still plays, then the point Cues not yet sent, in order. A show
   * whose span ended on the way does not appear; its hide is dropped with it
   * only when the show surely never reached OBS, as after a position gap. A show
   * the reconnect rebuild already sent again is not sent a second time. */
  private catchUp(taken: Crossing[]): SceneWork {
    const due = taken.flatMap(crossing => crossing.due).filter(entry => !this.sentDue.has(entry.executionId));
    const ids = new Set(due.map(entry => entry.cue.id)), end = DURATION_END;
    const kept = due.filter(entry => {
      if (!entry.cue.id.endsWith(end)) return !ids.has(`${entry.cue.id}${end}`) && !this.maybeShown.has(entry.cue.id);
      const show = entry.cue.id.slice(0, -end.length);
      return !ids.has(show) || this.maybeShown.has(show);
    });
    const stops = taken.flatMap(crossing => crossing.media)
      .filter(event => event.phase === 'stop' && this.managed.isActiveMedia(event) && !this.attemptedMedia.has(event.id));
    const timeline = this.managed.sceneTimeline!;
    if (this.picture === 'known') return timeline.rebuild(taken[0]!.from, this.frame, kept, stops);
    // A rebuild already put back the picture at its frame: the camera, shown
    // sources and clips on air then are not sent again, only what came after.
    if (this.picture === 'rebuilt') return timeline.rebuild(this.rebuiltAt, this.frame, kept, stops);
    const work = timeline.restore(this.frame, kept, stops);
    // A clip start that already went out and failed is not sent again.
    return { cues: work.cues, media: work.media.filter(event => event.phase !== 'start'
      || !this.attemptedMedia.has(event.id) || this.managed.isActiveMedia(event)) };
  }

  /** Recovery rule B after OBS reconnects: from now on what OBS shows is unknown,
   * and it forgot the owned scenes. Once in-flight decoder preparation settles,
   * `restore` prepares the owned scenes again and the picture is rebuilt at the
   * latest position, while the song plays: a pause cancels them and the resume
   * does them, in that order. Resolves with what was rebuilt, or null when a
   * pause or stop came first. A restore that fails is not tried again: the
   * cameras and shown sources are rebuilt anyway and the result says why the
   * scenes were not prepared. The channel keeps running. */
  rebuild(restore: () => Promise<void>): Promise<ObsRecovery | null> {
    const state = this.runtime.getState();
    if (!this.prepared || this.closed || this.failure || (state !== 'running' && state !== 'paused')) return Promise.resolve({ sent: 0, succeeded: 0, failed: [], failure: null });
    this.picture = 'lost'; this.losses++; this.pendingRestore = restore; this.restoring = true; this.queuedRebuilds++;
    const operation = this.tail.then(async () => {
      this.queuedRebuilds--;
      try { return await this.recover(); }
      catch (error) {
        // Not tried again by itself: the next send is the whole picture then.
        if (this.picture === 'lost' && !this.pendingRestore) this.picture = 'partial';
        throw error;
      } finally {
        this.restoring = this.picture === 'lost';
        // What a drain left to this rebuild goes out after it, without waiting for the next position.
        if (this.crossings.length) this.scheduleDrain();
      }
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  /** Prepares the owned scenes again when a reconnect left that to do, then
   * rebuilds the picture, only while the song plays. A pause cancels either step;
   * the resume starts again from the step it cancelled. A failed restore is
   * reported and not tried again; the picture is still rebuilt. */
  private async recover(): Promise<ObsRecovery | null> {
    await this.preloadWork;
    while (this.playing()) {
      const restore = this.pendingRestore;
      if (restore) {
        const generation = this.generation;
        try { await restore(); }
        catch (error) {
          // A pause came first (the host refuses while paused): done again once the song plays.
          if (generation !== this.generation || !this.playing()) continue;
          this.restoreFailure = errorText(error);
        }
        if (this.pendingRestore === restore) this.pendingRestore = null;
      }
      const generation = this.generation;
      const rebuilt = await this.rebuildPicture(() => generation === this.generation && this.playing());
      if (rebuilt === null) continue;
      const failure = this.restoreFailure; this.restoreFailure = null;
      return { ...rebuilt, failure };
    }
    return null;
  }
  /** The picture at the current position from nothing, like a start from the
   * middle: camera and shown sources first, clips on air located at the music,
   * then played together. A part that does not come back (a clip that cannot be
   * located among them) does not stop the rest; the result says which and why, and
   * whoever reports the rebuild says it once. Crossings still queued go out after
   * this as what changed since this picture, so their point Cues are not lost.
   * Null when a pause or stop came first: the picture stays lost. */
  private async rebuildPicture(current: () => boolean): Promise<Omit<ObsRecovery, 'failure'> | null> {
    if (!current()) return null;
    const losses = this.losses;
    this.failedStarts.clear(); this.preloadFrame = -Infinity;
    const frame = this.frame, shown = this.runtime.shownSourcesAt(frame);
    for (const entry of shown) this.maybeShown.add(entry.cue.id);
    const owed = this.owedHides(frame, shown);
    const work = this.managed.sceneTimeline!.restore(frame, shown);
    const targets = work.media.filter(event => event.phase === 'start').map(event => this.managed.alignEvent(event, frame));
    this.managed.adoptSeek(targets, frame); this.settleMedia(frame);
    const tally: Tally = { succeeded: 0, failed: [] };
    if (!(await this.send(timelineEntries({ cues: [...work.cues, ...owed], media: [] }), current, null, false, tally)).complete) return null;
    for (const event of targets) {
      if (!current()) return null;
      try { await this.dependencies.guardOutput(current, () => this.dependencies.seekMedia(event)); tally.succeeded++; }
      catch (error) {
        if (!current()) return null;
        tally.failed.push({ label: `素材“${event.assetName}”对准音乐的位置`, reason: errorText(error) });
      }
    }
    const sources = this.managed.transportSources('start');
    if (sources.length && current()) {
      const report = await this.dependencies.guardOutput(current, () => this.runner.run({ id: 'transport-start', name: '同步画面播放状态', notes: '', enabled: true,
        timecode: frameNumberToTimecode(frame, this.project.timebase.frameRate), actions: this.managed.transportActions('start', sources) }, 'live', current));
      this.dependencies.cueReport(report);
      for (const result of report.results) if (result.status !== 'succeeded') {
        const input = result.action.kind === 'obs.mediaAction' ? result.action.inputName : null;
        tally.failed.push({ label: input === null ? result.action.label : `素材“${targets.find(event => event.sourceName === input)?.assetName ?? input}”继续播放`,
          reason: result.error ?? '没有完成' });
      }
      this.played(sources);
    }
    if (!current()) return null;
    if (losses === this.losses) {
      // Crossings queued meanwhile go out as what changed since this picture.
      this.picture = this.crossings.length ? 'rebuilt' : 'known'; this.rebuiltAt = frame;
    }
    return { sent: work.cues.length + owed.length + targets.length, ...tally };
  }
  /** The hides a rebuild owes: a show OBS accepted whose span ended while the
   * connection was gone, so its hide failed then. They go out with the rebuilt
   * picture, and the same hide still queued is not sent a second time. */
  private owedHides(frame: number, shown: DueCue[]): DueCue[] {
    const showing = new Set(shown.map(entry => entry.cue.id));
    const owed = [...this.openShows].filter(([show]) => !showing.has(show)).map(([, cue]) => cue);
    const ids = new Set(owed.map(cue => cue.id));
    for (const crossing of this.crossings) for (const entry of crossing.due) if (ids.has(entry.cue.id)) this.sentDue.add(entry.executionId);
    return owed.map(cue => ({ cue, scheduledFrame: frame, executionId: crypto.randomUUID() }));
  }

  /** Sends in timeline order. Lateness never drops an action: the next crossing
   * only sends what changed since this one, so a skipped switch would leave the
   * picture wrong until the following boundary. A step that started goes out
   * whole even if a pause comes meanwhile, so what went out is exactly known;
   * a pause stops the send before the next step, stop or a failure at once.
   * Each step is measured against `dueAt` when it goes out; `each` reports it
   * there, otherwise the caller reports the largest once. With a `tally` (a
   * rebuild), how each part came back is counted there instead of reported. */
  private async send(entries: TimelineEntry[], current: () => boolean, dueAt: ((frame: number) => number) | null, each: boolean, tally?: Tally): Promise<SendResult> {
    const sending = (): boolean => !this.closed && !this.failure;
    let lateMs: number | null = null;
    for (let index = 0; index < entries.length;) {
      const entry = entries[index]!;
      // A covered decoder keeps running. The preceding composition already
      // restored its visibility; there is no command left to send here.
      if ('event' in entry && entry.event.phase === 'start' && entry.event.deferSceneSwitch
        && this.managed.isActiveMedia(entry.event)) { index++; continue; }
      if (!current()) return { complete: false, lateMs };
      const group = this.group(entries, index);
      const label = 'cue' in entry ? entry.cue.name : entry.event.assetName;
      const late = dueAt ? Math.round(this.dependencies.now() - dueAt(entry.frame)) : 0;
      lateMs = Math.max(lateMs ?? late, late);
      const results = await Promise.allSettled(group.map(member => this.output(member, sending)));
      results.forEach((result, member) => {
        if (result.status === 'fulfilled') { if (tally && result.value) tallyCue(tally, result.value); return; }
        const part = group[member]!;
        if (tally) tally.failed.push({ label: 'cue' in part ? part.cue.name : part.event.assetName, reason: errorText(result.reason) });
        else this.fault(`画面动作出错：${label}：${String(result.reason)}`);
      });
      if (each && late > LATE_LOG_MS) this.late(late, lateText(label, late));
      index += group.length;
    }
    return { complete: true, lateMs };
  }
  /** Sent late: logged, and shown in red once it is late enough for the audience to notice. */
  private late(lateMs: number, message: string): void {
    if (lateMs > LATE_FAULT_MS) this.fault(message);
    void this.dependencies.recordLog({ level: 'warning', category: 'action', message, projectId: this.project.projectId, itemId: this.itemId, device: 'obs',
      details: { lateMs } }).catch(error => this.fault(`记录画面动作晚到失败：${String(error)}`));
  }

  /** Members that share one event boundary and are sent together. */
  private group(entries: TimelineEntry[], index: number): TimelineEntry[] {
    const entry = entries[index]!, group = [entry];
    if ('cue' in entry) {
      const action = entry.cue.actions.length === 1 ? entry.cue.actions[0] : undefined;
      if (entry.cue.id !== `timeline-composition:${this.itemId}` || action?.kind !== 'obs.setProgramScene' || !action.sceneLayers) return group;
      // These owned decoders and their prepared composition share one event
      // boundary. Do not spend the entire deadline waiting for a scene
      // acknowledgement before issuing the media starts.
      const sources = new Set<string>();
      while (group.length < 9) {
        const next = entries[index + group.length];
        if (!next || !('event' in next) || next.frame !== entry.frame || next.event.phase !== 'start'
          || !next.event.deferSceneSwitch || !action.sceneLayers.includes(next.event.sceneName)
          || sources.has(next.event.sourceName) || this.managed.isActiveMedia(next.event)) break;
        group.push(next); sources.add(next.event.sourceName);
      }
      return group;
    }
    // Layers in one composed frame are independent inputs. Start them together
    // instead of spending one render tick per decoder. Never parallelize scene
    // changes, stops, a restore, or two actions on the same input.
    if (entry.event.phase !== 'start' || !entry.event.deferSceneSwitch || this.managed.isActiveMedia(entry.event)) return group;
    const sources = new Set([entry.event.sourceName]);
    while (group.length < 4) {
      const next = entries[index + group.length];
      if (!next || !('event' in next) || next.frame !== entry.frame || next.event.phase !== 'start'
        || !next.event.deferSceneSwitch || sources.has(next.event.sourceName) || this.managed.isActiveMedia(next.event)) break;
      group.push(next); sources.add(next.event.sourceName);
    }
    return group;
  }

  /** Failed results reach the host as red reports; nothing here ends the channel.
   * What goes out is recorded first, so a later send for the same crossings
   * does not send it again. Resolves with the report of the Cue it sent, or null
   * for a clip event (reported to the host as a clip). */
  private async output(entry: TimelineEntry, canSend: () => boolean): Promise<CueExecutionReport | null> {
    if ('cue' in entry) { this.sentDue.add(entry.executionId); return this.cue(entry.cue, canSend); }
    const event = entry.event;
    // A camera only covers these decoders; composition restores their
    // visibility. Repositioning them here interrupts a live media clock.
    if (event.phase === 'start' && this.managed.isActiveMedia(event)) {
      return event.deferSceneSwitch ? null : this.cue({
        id: `restore:${event.id}`, name: '恢复持续播放的素材', enabled: true, notes: '',
        timecode: frameNumberToTimecode(entry.frame, this.project.timebase.frameRate),
        actions: [{ id: `restore:${event.id}:scene`, label: '恢复底层画面', kind: 'obs.setProgramScene', sceneName: event.sceneName }]
      }, canSend);
    }
    const report = await this.dependencies.guardOutput(canSend,
      () => this.managed.executeMedia(this.managed.alignEvent(event, this.frame), 'live', canSend));
    if (report.status !== 'skipped') this.attemptedMedia.add(event.id);
    if (event.phase === 'start' && report.status !== 'skipped') this.played([event.sourceName]);
    if (event.phase === 'start' && report.status === 'failed') this.failedStarts.add(event.clipId);
    this.dependencies.mediaReport(report);
    return null;
  }
  /** A play request for these inputs ended while the song is paused: it may have
   * reached OBS after the pause did, so they are paused once the step settles. */
  private played(sources: string[]): void {
    if (this.runtime.getState() === 'paused') for (const source of sources) this.startedWhilePaused.add(source);
  }

  private preload(frame: number): void {
    const prepare = this.dependencies.prepareUpcoming;
    if (!prepare || this.restoring || this.preloadWork || frame - this.preloadFrame < playbackFramesPerSecond(this.project.timebase.frameRate) / 10) return;
    this.preloadFrame = frame;
    const allowed = (): boolean => !this.closed && !this.failure;
    this.preloadWork = this.dependencies.guardOutput(allowed, () => prepare(frame, () => {
      if (!allowed()) throw new Error('后续素材准备已取消');
    })).then(prepared => { if (prepared) this.startLate(prepared); }).catch(error => { if (!this.closed && !this.failure) this.fault(`准备后面的素材失败：${error instanceof Error ? error.message : String(error)}；不会重试，到时候这个素材可能播不出来`); })
      .finally(() => { this.preloadWork = null; });
  }

  private settleMedia(frame: number): void {
    this.nextDriftCheck = Math.max(this.nextDriftCheck, frame + playbackFramesPerSecond(this.project.timebase.frameRate));
  }
  /** Recovery rule B for OBS video drifting from the music over a long clip. */
  private watchDrift(frame: number): void {
    const correct = this.dependencies.correctMediaDrift;
    if (!correct || frame < this.nextDriftCheck) return;
    this.nextDriftCheck = frame + 5 * playbackFramesPerSecond(this.project.timebase.frameRate);
    const generation = this.generation;
    this.enqueue(async () => {
      for (const event of this.managed.activeMedia()) {
        const current = (): boolean => generation === this.generation && !this.closed && !this.failure && this.runtime.getState() === 'running';
        if (event.assetKind === 'image' || !current()) continue;
        const drift = await this.dependencies.guardOutput(current, () => correct(this.managed.alignEvent(event, this.frame)));
        if (drift !== null) this.fault(`素材和音乐差了 ${drift} ms，已按当前位置校正：${event.assetName}`);
      }
    });
  }

  /** Recovery rule B for a decoder that missed its boundary: once it is ready,
   * the clip starts at the current position if it should be on air now. */
  private startLate(prepared: ManagedMediaEvent): void {
    const generation = this.generation;
    this.enqueue(async () => {
      if (this.runtime.getState() !== 'running' || !this.failedStarts.delete(prepared.clipId)) return;
      const event = this.managed.sceneTimeline!.at(this.frame).media.find(entry => entry.clipId === prepared.clipId);
      if (!event) return;
      const current = (): boolean => generation === this.generation && !this.closed && !this.failure;
      const lateMs = Math.round((this.frame - event.frameNumber) * 1000 / playbackFramesPerSecond(this.project.timebase.frameRate));
      this.settleMedia(this.frame);
      const report = await this.dependencies.guardOutput(current, () => this.managed.executeMedia(this.managed.alignEvent(event, this.frame), 'live', current));
      if (report.status !== 'skipped') this.played([event.sourceName]);
      this.dependencies.mediaReport(report);
      if (report.status === 'succeeded') this.fault(`素材准备得晚了，已按当前位置开始播放：${event.assetName}（晚了 ${lateMs} ms）`);
    });
  }

  async pause(): Promise<void> {
    if (!this.prepared || this.closed || this.failure) return;
    if (this.runtime.getState() === 'paused') return;
    const generation = ++this.generation; this.advancing = false; this.pausedAt = this.dependencies.now();
    // What has not gone out waits for the resume, which then shows the picture at
    // the resumed position (docs/OBS_SCENE_WORKFLOW.md: 继续时再恢复当前有效画面).
    this.requireUpdate(this.runtime.pauseAutomatic());
    this.settleMedia(Math.max(0, this.frame));
    if (this.picture === 'lost') {
      // OBS is being prepared again: the clips it may still play pause after that.
      this.enqueue(() => this.transport('pause', this.managed.transportSources('pause'), generation, this.pausedAt));
    } else {
      // The clips pause with the music, not after the step in flight, which goes
      // out whole so that what went out stays known. A clip that step plays
      // meanwhile is paused once it settled, unless the song plays again by then.
      this.startedWhilePaused.clear();
      const playing = this.managed.transportSources('pause');
      const pausing = this.transport('pause', playing, generation, this.pausedAt)
        .catch(error => this.fault(`画面动作出错：${errorText(error)}`));
      this.enqueue(async () => {
        await pausing;
        const rest = this.managed.transportSources('pause').filter(source => !playing.includes(source) || this.startedWhilePaused.has(source));
        await this.transport('pause', rest, generation, this.pausedAt);
      });
    }
    await this.tail;
    const failure = this.error;
    if (failure) throw failure;
  }

  /** Invalidate first; already sent network work may finish, but no queued action
   * from this generation is allowed to follow it. Cleanup uses only owned state. */
  stop(): Promise<void> {
    this.stopping ??= this.stopSession();
    return this.stopping;
  }
  private async stopSession(): Promise<void> {
    this.closed = true; ++this.generation; this.dependencies.state(this.runtime.stop());
    await this.tail;
    await this.preloadWork;
    const errors: string[] = [], cleanup = this.managed.takeCleanup();
    for (const event of cleanup.mediaEvents) {
      try {
        const report = await this.managed.executeMedia(event, 'live'); this.dependencies.mediaReport(report);
        if (report.status === 'failed') errors.push(report.error ?? '停止素材失败');
      } catch (error) { errors.push(errorText(error)); }
    }
    // A shown source whose span the song did not reach the end of is hidden with
    // the song, like its clips; a later start from the middle shows it again.
    for (const cue of [...cleanup.cameraCues, ...this.openShows.values()]) {
      try {
        const failed = (await this.cue(cue, () => true)).results.find(result => result.status === 'failed');
        if (failed) errors.push(failed.error ?? `${failed.action.label}没有完成`);
      } catch (error) { errors.push(errorText(error)); }
    }
    try { await this.dependencies.releaseOutputs(); } catch (error) { errors.push(errorText(error)); }
    if (errors.length) { const error = new Error(`画面没有清理干净：${errors.join('；')}`); this.fail(error); throw error; }
    this.dependencies.state(this.runtime.completeStop());
  }

  private enqueue(operation: () => Promise<void>): void {
    if (this.closed || this.failure) return;
    if (this.queued >= 64) { this.fault('OBS 积压了超过 64 批画面动作，这一批没有发送；画面联动继续'); return; }
    const generation = this.generation; this.queued++;
    this.tail = this.tail.then(async () => {
      if (generation !== this.generation || this.closed || this.failure) return;
      await operation();
    }).catch(error => this.fault(`画面动作出错：${error instanceof Error ? error.message : String(error)}`)).finally(() => { this.queued--; });
  }
  private async cue(cue: LinkCue, canExecute: () => boolean): Promise<CueExecutionReport> {
    const compiled = this.managed.compileVisualCue(cue);
    for (const action of compiled.actions) this.managed.trackVisualActionAttempt(cue.id, action);
    const report = await this.dependencies.guardOutput(canExecute, () => this.runner.run(compiled, 'live', canExecute));
    this.managed.applyVisualCueResult(cue, compiled, report.results); this.dependencies.cueReport(report);
    this.trackShow(cue, report);
    return report;
  }
  /** A span's show counts as on air once OBS accepted it, and off once its hide was
   * accepted; the stop hides what is left. Old managed-scene shows have their own cleanup. */
  private trackShow(cue: LinkCue, report: CueExecutionReport): void {
    const accepted = report.results.some(result => result.status === 'succeeded' && result.action.kind === 'obs.setSceneItemEnabled'
      && result.action.sceneName !== MANAGED_OBS_SCENE_NAME);
    if (!accepted) return;
    if (cue.id.endsWith(DURATION_END)) { this.openShows.delete(cue.id.slice(0, -DURATION_END.length)); return; }
    const hide = this.runtime.durationEnd(cue.id);
    if (hide) this.openShows.set(cue.id, hide);
  }
  /** A late resume is still sent: a clip left paused is worse than one that starts
   * late, and the drift check puts it back in step with the music. */
  private enqueueTransport(action: 'start', observedAt: number): void {
    const generation = this.generation; this.settleMedia(Math.max(0, this.frame));
    this.enqueue(async () => {
      const sources = this.managed.transportSources(action);
      await this.transport(action, sources, generation, observedAt);
      this.played(sources);
    });
  }
  /** Plays or pauses these clip inputs, unless the song changed state meanwhile.
   * Late is measured from `since`: logged, and shown in red when the audience notices. */
  private async transport(action: 'start' | 'pause', sources: string[], generation: number, since: number): Promise<void> {
    const current = (): boolean => generation === this.generation && !this.closed && !this.failure;
    if (!sources.length || !current() || this.runtime.getState() !== (action === 'pause' ? 'paused' : 'running')) return;
    const cue = { id: `transport-${action}`, name: '同步画面播放状态', notes: '', enabled: true,
      timecode: frameNumberToTimecode(Math.max(0, this.frame), this.project.timebase.frameRate), actions: this.managed.transportActions(action, sources) };
    const lateMs = Math.round(this.dependencies.now() - since);
    this.dependencies.cueReport(await this.dependencies.guardOutput(current, () => this.runner.run(cue, 'live', current)));
    if (lateMs <= LATE_LOG_MS || !current()) return;
    this.late(lateMs, action === 'start' ? lateText('素材继续播放', lateMs)
      : `素材暂停晚了 ${lateMs} ms：电脑或 OBS 当时太忙，音乐停了素材还多播了一会儿。继续播放后会按音乐的位置校正`);
  }
  private sample(positionMs: number, observedAt = this.dependencies.now()): MtcSample {
    if (!Number.isFinite(positionMs) || positionMs < 0 || positionMs >= 86400000) throw new Error('实际音频位置无效');
    const frameRate = this.project.timebase.frameRate, totalFrames = millisecondsToFrameNumber(positionMs, frameRate);
    return { frameRate, totalFrames, timecode: frameNumberToTimecode(totalFrames, frameRate), direction: 'forward', receivedAtMs: observedAt };
  }
  private requireCurrent(generation: number): void {
    if (generation !== this.generation || this.closed || this.failure) throw new Error('画面准备已取消');
  }
  private requireUpdate(update: RuntimeUpdate): void {
    this.dependencies.state(update);
    if (update.state === 'error' || update.state === 'timecodeLost') throw new Error(update.reason ?? '画面计时已失效');
  }
  private fault(message: string): void {
    if (this.closed || this.failure) return;
    this.dependencies.fault(message);
  }
  private fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error)); ++this.generation;
    this.dependencies.state(this.runtime.failExecution(this.failure.message));
  }
}
