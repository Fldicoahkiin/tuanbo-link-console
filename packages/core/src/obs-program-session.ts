import type { LinkCue, LinkProject } from '@tb/schema';
import { actionResultLog, CueActionRunner, type CueExecutionReport, type LinkActionExecutor } from './cue-action-runner';
import { CueRuntime, type DueCue, type RuntimeUpdate } from './cue-runtime';
import { frameNumberToTimecode, millisecondsToFrameNumber, playbackFramesPerSecond, type MtcSample } from './mtc-timecode';
import { ManagedOutputRuntime, type ManagedMediaExecutionReport, type ManagedMediaOutcome, type ManagedOutputRuntimeDependencies } from './managed-output-runtime';
import { compileManagedMediaTimeline, MANAGED_OBS_SCENE_NAME, type ManagedMediaEvent } from './managed-media-timeline';
import { ObsPictureLedger, showKey, showMayBeOn, type LedgerWrite } from './obs-picture-ledger';
import type { OnAirPicture } from './on-air-picture';
import type { RecoveryBudgetView } from './output-recovery';
import { COMPOSITION_GROUP_STARTS, DECODER_GROUP_STARTS, pictureOpWrites, planPictureReconcile, whilePaused, type PictureOp, type ReconcilePlan } from './picture-reconcile';
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
const DURATION_END = ':duration-end';
/** No repairs yet: a part OBS refused is not sent again for the same wanted picture
 * (AGENTS §4.4). Grading failures and the recovery limits come with R5. */
const NO_REPAIRS: RecoveryBudgetView = { allows: () => false };

/** A clock step that crossed a cut point, had point actions due, or rebuilt after a
 * position gap; kept until a pass sent everything it stands for. `shift`: how long
 * pauses held it, which is not the computer's lateness. */
type Tick = { from: number; to: number; points: DueCue[]; rebuild: boolean;
  dueAt: (frame: number) => number; earliestDueMs: number; shift: number };
/** Where an op goes among the steps of a pass (see `layout`). */
type Slot = 'stop' | 'before' | 'program' | 'start' | 'after';
/** One step a pass sends: a Cue (a camera, composition, shown source or point action) or
 * a clip event, with the ledger writes it stands for. `point`: the execution of a point
 * Cue, which is sent once whatever happens; `layers`: the composition it puts on program;
 * `lateMs`: a clip that became ready after its boundary and starts late. */
type Entry = { frame: number; priority: number; slot: Slot; label: string; writes: LedgerWrite[] } & (
  | { kind: 'cue'; cue: LinkCue; point: string | null; layers: readonly string[] | null }
  | { kind: 'media'; event: ManagedMediaEvent; lateMs: number | null });
type MediaEntry = Extract<Entry, { kind: 'media' }>;
/** `step`: what a clip event came to, as the output told it (R3b). Every failed kind is still
 * written into the ledger as a failure; R5 decides by the kind whether to repair. */
type Outcome = 'ok' | 'withdrawn' | { failed: string; step?: ManagedMediaOutcome };
type DecoderOp = Extract<PictureOp, { kind: 'decoder.pause' | 'decoder.resume' }>;
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
/** What a Cue's report means for the ledger: refused if any action was, answered if any went out, otherwise not sent. */
function cueOutcome(report: CueExecutionReport): Outcome {
  const failed = report.results.find(result => result.status === 'failed');
  if (failed) return { failed: failed.error ?? `${failed.action.label}没有完成` };
  return !report.results.length || report.results.some(result => result.status === 'succeeded') ? 'ok' : 'withdrawn';
}

/** Owns an immutable program and consumes device-clock observations. No renderer,
 * wall-clock playhead, or UI lifetime participates in scheduling. The host must
 * prepare resources and bind this session to a specific native audio generation.
 *
 * The picture (design 01 §4): what OBS should show is `SceneOutputTimeline.pictureAt`,
 * what OBS confirmed is the ledger, and every pass sends the difference the planner
 * works out between the two at the current position. So after OBS answered slowly
 * only the picture now goes out, a pause or reconnect leaves nothing half known, and
 * a clip already on air is never started again. Point actions (a filter on a camera
 * Cue, a Cue that is not a picture span) are not state: each goes out once when
 * crossed, never again on recovery. */
export class ObsProgramSession {
  private preloadWork: Promise<void> | null = null;
  /** Set while rebuild prepares the owned scenes again; no new decoder preparation starts. */
  private restoring = false;
  /** Clip starts OBS refused this session; a late-ready decoder may start each once. Kept
   * apart from the ledger: the song's pause and resume still go to such a clip (the
   * output answers them as not on air), which says nothing about its start. */
  private readonly refusedStarts = new Set<string>();
  /** Clips whose start failed and whose decoder became ready since: started once, late, with a red note. */
  private readonly lateReady = new Set<string>();
  /** Drift is checked every 5 s, never within 1 s of a media start, resume or seek. */
  private nextDriftCheck = -Infinity;
  private preloadFrame = -Infinity;
  private readonly runtime: CueRuntime;
  private readonly managed: ManagedOutputRuntime;
  private readonly runner: CueActionRunner;
  private readonly timeline: SceneOutputTimeline;
  private readonly ledger = new ObsPictureLedger();
  private readonly cueById: ReadonlyMap<string, LinkCue>;
  private readonly starts = new Map<string, ManagedMediaEvent>();
  private readonly stops = new Map<string, ManagedMediaEvent>();
  private readonly fps: number;
  private tail: Promise<void> = Promise.resolve();
  /** Clock steps not yet completely sent, oldest first. One goes out as crossed; several
   * (OBS answered slowly, or a pause held them) go out once as the picture now. */
  private readonly ticks: Tick[] = [];
  private drainQueued = false;
  /** The last pass stopped between two steps (a pause) or failed: the next one is merged. */
  private partial = false;
  /** OBS reconnected and the picture is not rebuilt yet. */
  private lost = false;
  /** Point Cues already sent for the queued ticks, failed or not, by execution: never sent again. */
  private readonly sentDue = new Set<string>();
  /** The Cue of each "show source" action: a span's end hides with that Cue's hide. */
  private readonly spanCue = new Map<string, string>();
  /** When the song resumed, until the pass after it measured the resume. */
  private resumedAt: number | null = null;
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
    this.timeline = this.managed.sceneTimeline!;
    this.cueById = new Map(item.cues.map(cue => [cue.id, cue]));
    for (const cue of item.cues) for (const action of cue.actions) if (action.kind === 'obs.setSceneItemEnabled') this.spanCue.set(action.id, cue.id);
    for (const event of compileManagedMediaTimeline(project, itemId).events) (event.phase === 'start' ? this.starts : this.stops).set(event.clipId, event);
    this.fps = playbackFramesPerSecond(project.timebase.frameRate);
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
      // The picture at the start position, as after a position gap: camera first,
      // then the shown sources, then the clips on air located at the music.
      const frame = sample.totalFrames, allowed = (): boolean => generation === this.generation && !this.closed;
      const entries = this.layout(this.translate(this.plan(frame, 'running', true), frame, true), [], frame, true);
      // Live: a failed camera or seek is shown in red and the rest of the picture
      // is still prepared, as from the start of the song. Only cancellation ends it.
      for (const entry of entries) {
        if (entry.kind !== 'cue') continue;
        this.requireCurrent(generation);
        await this.output(entry, allowed, allowed);
      }
      const targets = entries.filter((entry): entry is MediaEntry => entry.kind === 'media');
      // A seek may reach OBS before its acknowledgement is interrupted. Retain
      // the intended owned targets so cancellation can clean them up as well.
      this.managed.adoptSeek(targets.map(entry => entry.event), frame); this.settleMedia(frame);
      for (const entry of targets) {
        this.requireCurrent(generation);
        const [decoder, ...program] = entry.writes;
        for (const write of entry.writes) this.ledger.sent(write, this.dependencies.now());
        let outcome: Outcome = 'ok';
        try { await this.dependencies.guardOutput(allowed, () => this.dependencies.seekMedia(entry.event)); }
        catch (error) {
          if (!allowed()) { this.settle(entry.writes, 'withdrawn'); this.requireCurrent(generation); }
          outcome = { failed: errorText(error) };
          this.fault(`素材没有对准开始的位置：${entry.event.assetName}：${errorText(error)}。音乐照常播放，这个素材的画面可能和音乐对不上`);
        }
        // The decoder shows this clip once located, also when locating failed: the
        // song's pause and resume reach it and the drift check puts it in step.
        if (decoder?.element === 'decoder') this.ledger.observe({ element: 'decoder', key: decoder.key, value: decoder.value }, this.dependencies.now());
        this.settle(program, outcome);
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
      let update: RuntimeUpdate, resumed = false;
      if (this.runtime.getState() === 'paused') {
        update = this.runtime.resumeMedia(sample);
        this.requireUpdate(update);
        // The pause is not lateness: what it held is measured as if sent from here.
        for (const tick of this.ticks) tick.shift += observedAt - this.pausedAt;
        resumed = true; this.resumedAt = observedAt; this.settleMedia(Math.max(0, this.frame));
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
      if (this.managed.collectCrossed(previousFrame, sample.totalFrames).length) this.settleMedia(sample.totalFrames);
      const points = this.points(update.dueCues), cut = this.cutIn(previousFrame, sample.totalFrames);
      if (cut !== null || points.length || update.rebuild) {
        const dueAt = (scheduledFrame: number): number => observedAt
          - Math.max(0, sample.totalFrames - scheduledFrame) * 1000 / playbackFramesPerSecond(sample.frameRate);
        const first = update.rebuild ? sample.totalFrames : Math.min(cut ?? Infinity, ...points.map(entry => entry.scheduledFrame));
        this.ticks.push({ from: previousFrame, to: sample.totalFrames, points, rebuild: update.rebuild === true, dueAt, earliestDueMs: dueAt(first), shift: 0 });
      }
      // A resume with nothing newly crossed still plays the clips again and sends
      // what the pause held back, and rebuilds a picture a pause kept from being rebuilt.
      if (this.ticks.length || this.lost || resumed) this.scheduleDrain();
    } catch (error) { this.fail(error); }
  }
  /** The first cut point in (from, to], or null. */
  private cutIn(from: number, to: number): number | null {
    const cuts = this.timeline.cutPoints();
    let low = 0, high = cuts.length;
    while (low < high) { const middle = (low + high) >>> 1; if (cuts[middle]! <= from) low = middle + 1; else high = middle; }
    const cut = cuts[low];
    return cut !== undefined && cut <= to ? cut : null;
  }
  /** The point actions of due Cues: what the picture does not cover. Camera switches
   * and the shows and hides of "show source" spans are picture state, sent by the planner. */
  private points(due: readonly DueCue[]): DueCue[] {
    const spans = this.timeline.showCueIds();
    return due.flatMap(entry => {
      const id = entry.cue.id;
      if (id.endsWith(DURATION_END) && spans.has(id.slice(0, -DURATION_END.length))) return [];
      const span = spans.has(id);
      const actions = entry.cue.actions.filter(action => action.kind !== 'obs.setProgramScene'
        && !(span && action.kind === 'obs.setSceneItemEnabled' && action.enabled));
      return actions.length ? [{ ...entry, cue: { ...entry.cue, actions } }] : [];
    });
  }

  /** At most one waiting drain: it takes every tick present when it runs. */
  private scheduleDrain(): void {
    if (this.drainQueued || this.closed || this.failure) return;
    this.drainQueued = true; this.queued++;
    this.tail = this.tail.then(() => { this.drainQueued = false; return this.drain(); })
      .catch(error => this.fault(`画面动作出错：${error instanceof Error ? error.message : String(error)}`)).finally(() => { this.queued--; });
  }
  /** One pass: the picture now against what OBS confirmed. One tick goes out as
   * crossed, each step measured against its own boundary. Several (OBS answered
   * slowly, or a pause held them) go out once as the picture now: a switch already
   * superseded is not shown, a clip that started and ended meanwhile does not start,
   * and the late time is reported once (2026-11-09: what the timeline shows now is
   * never skipped). Ticks leave only once completely sent; no point Cue that went out,
   * failed or not, is sent again. A picture lost to an OBS reconnect is rebuilt
   * first, once: by that reconnect's own rebuild while it is still queued. */
  private async drain(): Promise<void> {
    if (!this.playing()) return;
    if (this.lost) {
      // A reconnect queued behind this drain rebuilds the picture, reports it
      // once and then sends what is still queued (see rebuild).
      if (this.queuedRebuilds) return;
      let rebuilt: ObsRecovery | null;
      // Not tried again by itself: the next send is the whole picture then.
      try { rebuilt = await this.recover(); }
      catch (error) { this.dropQueued(); this.lost = false; this.partial = true; this.fault(`画面动作出错：${errorText(error)}`); return; }
      finally { this.restoring = this.lost; }
      if (!rebuilt) return;
      this.fault(obsRecoveryText(rebuilt, false));
      if (!this.playing() || this.lost) return;
    }
    const generation = this.generation, losses = this.losses;
    const current = (): boolean => generation === this.generation && !this.closed && !this.failure;
    try {
      const taken = this.ticks.slice(), only = taken.length === 1 && !this.partial && !taken[0]!.rebuild ? taken[0]! : null;
      const frame = this.frame, planned = this.plan(frame, 'running', !only);
      // The clips play again with the music first, measured from the resume.
      const since = this.resumedAt ?? this.dependencies.now(); this.resumedAt = null;
      const resumes = planned.plan.ops.filter((op): op is DecoderOp => op.kind === 'decoder.resume');
      if (resumes.length) await this.transport('start', resumes, [], generation, since);
      const opFrame = only ? this.cutIn(only.from, only.to) ?? only.to : frame;
      const points = taken.flatMap(tick => tick.points).filter(entry => !this.sentDue.has(entry.executionId));
      const entries = this.layout(this.translate(planned, frame, !only), points, opFrame, !only);
      // Merged: every step is measured from the earliest time the backlog was due,
      // when it goes out, and reported once; its own answer time is not counted.
      const earliest = Math.min(...taken.map(tick => tick.earliestDueMs + tick.shift));
      const sent = await this.send(entries, current, only ? at => only.dueAt(at) + only.shift : taken.length ? () => earliest : null, Boolean(only));
      // A reconnect meanwhile: what OBS shows is lost, whatever this send did.
      if (losses !== this.losses) return;
      // A pause came between two steps. The rest goes out on resume as part of the picture then.
      if (!sent.complete) { this.partial = true; return; }
      this.ticks.splice(0, taken.length); this.sentDue.clear(); this.partial = false;
      if (only || !taken.length || sent.lateMs === null || sent.lateMs <= LATE_LOG_MS) return;
      // `taken.length` counts the clock steps that crossed a cut point or had point actions due since the last send.
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
    this.ticks.length = 0; this.sentDue.clear();
    if (!this.lost) this.partial = true;
  }
  private playing(): boolean { return !this.closed && !this.failure && this.runtime.getState() === 'running'; }

  /** The planner's ops for the picture at `frame` against the ledger. `merged`: several
   * cuts in one pass (or none, or a rebuild), so shown sources go after the switch. */
  private plan(frame: number, transport: 'running' | 'paused', merged: boolean): { picture: OnAirPicture; plan: ReconcilePlan } {
    const picture = this.timeline.pictureAt(frame);
    return { picture, plan: planPictureReconcile(picture, this.ledger.state(), { mode: 'live', transport, now: this.dependencies.now(),
      ready: () => 'ready', budget: NO_REPAIRS, holding: false, merged }) };
  }
  /** The steps that carry out the planner's ops, through the same Cues and clip events
   * as before: a camera as its Cue's switch, a composition as the owned composition Cue,
   * a clip's start through the preloaded decoder (its own scene in the same step when it
   * is the whole picture), a shown source as its span's show or hide. Pauses and resumes
   * are sent apart, as one media action each. */
  private translate({ picture, plan }: { picture: OnAirPicture; plan: ReconcilePlan }, frame: number, merged: boolean): Entry[] {
    const target = picture.target, entries: Entry[] = [];
    const composition = plan.ops.find(op => op.kind === 'composition.update');
    const compositionCue = (writes: LedgerWrite[]): Entry | null => target.kind !== 'composition' ? null : this.cueEntry('program', {
      id: `timeline-composition:${this.itemId}`, name: '更新时间线叠加', enabled: true, notes: '', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
      actions: [{ id: `timeline-composition:${this.itemId}:scene`, label: '按轨道顺序叠加', kind: 'obs.setProgramScene', sceneName: target.sceneName, sceneLayers: target.layers.map(layer => layer.sceneName) }]
    }, writes, target.layers.map(layer => layer.sceneName));
    for (const op of plan.ops) {
      switch (op.kind) {
        case 'decoder.pause': case 'decoder.resume': break;
        case 'decoder.stop': {
          const clipId = op.write.element === 'decoder' ? op.write.value.clipId : '';
          const start = this.starts.get(clipId), event = this.stops.get(clipId)
            ?? (start ? { ...start, id: `${start.id}:stop`, phase: 'stop' as const } : undefined);
          if (event) entries.push({ kind: 'media', slot: 'stop', frame: 0, priority: 0, label: event.assetName, writes: [op.write], event, lateMs: null });
          break;
        }
        case 'composition.update': {
          const program = plan.ops.find(other => other.kind === 'program.switch' && other.sceneName === op.sceneName);
          const entry = compositionCue([op.write, ...program ? [program.write] : []]);
          if (entry) entries.push(entry);
          break;
        }
        case 'program.switch': {
          if (target.kind === 'composition') {
            const entry = composition ? null : compositionCue([op.write]);
            if (entry) entries.push(entry);
          } else if (target.kind === 'clip') {
            // The clip already plays on its decoder (a camera over it ended): only its scene comes back on program.
            entries.push(this.cueEntry('program', { id: `timeline-selection:${this.itemId}`, name: '显示持续播放的素材', enabled: true, notes: '',
              timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
              actions: [{ id: `timeline-selection:${this.itemId}:scene`, label: '恢复底层画面', kind: 'obs.setProgramScene', sceneName: op.sceneName }] }, [op.write]));
          } else {
            // The camera's switch only; its other actions are point actions, sent once when crossed.
            const cue = target.cueId === null ? undefined : this.cueById.get(target.cueId);
            if (cue) entries.push(this.cueEntry('program', { ...cue, actions: cue.actions.filter(action => action.kind === 'obs.setProgramScene') }, [op.write]));
          }
          break;
        }
        case 'decoder.start': case 'decoder.handover': {
          const start = this.starts.get(op.clip.clipId);
          if (!start) break;
          // A handover goes out as the later half's start: the output carries its predecessor's decoder on (no seek, no restart).
          // Only the clip that is the whole picture switches the program to its own scene; any
          // other start (a composition layer, a sound) leaves the program to the switch.
          const event = this.managed.alignEvent({ ...start, deferSceneSwitch: !(target.kind === 'clip' && target.clipId === op.clip.clipId) }, frame);
          const lateMs = this.lateReady.has(start.clipId) ? Math.round(Math.max(0, frame - start.frameNumber) * 1000 / this.fps) : null;
          entries.push({ kind: 'media', slot: 'start', frame: 0, priority: 0, label: start.assetName, writes: pictureOpWrites(op), event, lateMs });
          break;
        }
        case 'show.set': {
          // As the planner ordered it: newly due before the switch, restored or merged after it.
          const slot: Slot = op.reason === 'restore' || merged ? 'after' : 'before';
          const entry = op.enabled ? this.showEntry(picture, op, slot) : this.hideEntry(op, slot);
          if (entry) entries.push(entry);
          break;
        }
      }
    }
    return entries;
  }
  private cueEntry(slot: Slot, cue: LinkCue, writes: LedgerWrite[], layers: readonly string[] | null = null): Entry {
    return { kind: 'cue', slot, frame: 0, priority: 0, label: cue.name, writes, cue, point: null, layers };
  }
  private showEntry(picture: OnAirPicture, op: Extract<PictureOp, { kind: 'show.set' }>, slot: Slot): Entry | null {
    const key = op.write.element === 'show' ? op.write.key : null, show = picture.shows.find(entry => showKey(entry) === key);
    const cue = show && this.cueById.get(show.cueId), action = cue?.actions.find(entry => entry.id === show?.actionId);
    if (!show || !cue || !action) return null;
    return this.cueEntry(slot, { ...cue, actions: [action] }, [op.write]);
  }
  /** A shown source is hidden with the hide of the span that showed it. */
  private hideEntry(op: Extract<PictureOp, { kind: 'show.set' }>, slot: Slot): Entry | null {
    const span = op.write.element === 'show' ? op.write.value.span : null, cueId = span === null ? undefined : this.spanCue.get(span);
    const end = cueId === undefined ? null : this.runtime.durationEnd(cueId);
    const hide = end?.actions.find(action => action.id === `${span}${DURATION_END}`);
    if (end && hide) return this.cueEntry(slot, { ...end, actions: [hide] }, [op.write]);
    if (op.sceneName === null) return null;
    const key = op.write.element === 'show' ? op.write.key : op.sourceName;
    const id = `picture-hide:${key}`, label = `隐藏来源 · ${op.sourceName}`;
    return this.cueEntry(slot, { id, name: label, enabled: true, notes: '', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
      actions: [{ id: `${id}:hide`, label, kind: 'obs.setSceneItemEnabled', sceneName: op.sceneName, sourceName: op.sourceName, enabled: false }] }, [op.write]);
  }
  /** Orders a pass, as the timeline always sent it. One tick: at the cut, stops, then
   * point actions and newly due shows (on the scene that was live), the switch, the
   * starts; restored shows a frame later; point actions at their own frames. Merged,
   * a rebuild or a start from the middle: stops, switch and starts at the frame, then
   * point actions and every shown source a frame later, on the scene now on program. */
  private layout(steps: Entry[], points: DueCue[], frame: number, merged: boolean): Entry[] {
    const place = (slot: Slot, at: number, priority: number): Entry[] => steps.filter(entry => entry.slot === slot)
      .map(entry => ({ ...entry, frame: at, priority }));
    const pointEntries = (at: number | null): Entry[] => points.map(entry => ({ kind: 'cue', slot: 'before', frame: at ?? entry.scheduledFrame, priority: 1,
      label: entry.cue.name, writes: [], cue: entry.cue, point: entry.executionId, layers: null }));
    if (merged) return [...place('stop', frame, 0), ...place('program', frame, 1), ...place('start', frame, 2),
      ...pointEntries(frame + 1), ...place('before', frame + 1, 1), ...place('after', frame + 1, 1)];
    return [...place('stop', frame, 0), ...pointEntries(null), ...place('before', frame, 1), ...place('program', frame, 1),
      ...place('start', frame, 2), ...place('after', frame + 1, 1)].sort((left, right) => left.frame - right.frame || left.priority - right.priority);
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
    this.lost = true; this.losses++; this.pendingRestore = restore; this.restoring = true; this.queuedRebuilds++;
    this.ledger.invalidate('OBS 重新连接');
    const operation = this.tail.then(async () => {
      this.queuedRebuilds--;
      try { return await this.recover(); }
      catch (error) {
        // Not tried again by itself: the next send is the whole picture then.
        if (this.lost && !this.pendingRestore) { this.lost = false; this.partial = true; }
        throw error;
      } finally {
        this.restoring = this.lost;
        // What a drain left to this rebuild goes out after it, without waiting for the next position.
        if (this.ticks.length) this.scheduleDrain();
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
   * whoever reports the rebuild says it once. Ticks still queued go out after this
   * as what changed since this picture, so their point Cues are not lost. Null when
   * a pause or stop came first: the picture stays lost, and unknown. */
  private async rebuildPicture(current: () => boolean): Promise<Omit<ObsRecovery, 'failure'> | null> {
    if (!current()) return null;
    const losses = this.losses;
    const cancelled = (): null => { this.ledger.invalidate('OBS 重新连接后恢复画面被打断'); return null; };
    this.refusedStarts.clear(); this.lateReady.clear(); this.preloadFrame = -Infinity;
    this.ledger.invalidate('OBS 重新连接');
    const frame = this.frame, entries = this.layout(this.translate(this.plan(frame, 'running', true), frame, true), [], frame, true);
    const targets = entries.filter((entry): entry is MediaEntry => entry.kind === 'media' && entry.event.phase === 'start');
    const parts = entries.filter(entry => !targets.includes(entry as MediaEntry));
    this.managed.adoptSeek(targets.map(entry => entry.event), frame); this.settleMedia(frame);
    const tally: Tally = { succeeded: 0, failed: [] };
    if (!(await this.send(parts, current, null, false, tally)).complete) return cancelled();
    for (const entry of targets) {
      if (!current()) return cancelled();
      for (const write of entry.writes) this.ledger.sent(write, this.dependencies.now());
      const [, ...program] = entry.writes;
      try { await this.dependencies.guardOutput(current, () => this.dependencies.seekMedia(entry.event)); tally.succeeded++; this.settle(program, 'ok'); }
      catch (error) {
        if (!current()) return cancelled();
        tally.failed.push({ label: `素材“${entry.event.assetName}”对准音乐的位置`, reason: errorText(error) });
        this.settle(entry.writes, { failed: errorText(error) });
      }
    }
    const playing = targets.filter(entry => entry.event.assetKind !== 'image');
    for (const entry of targets) if (entry.event.assetKind === 'image') this.settle(entry.writes.slice(0, 1), 'ok');
    if (playing.length && current()) {
      let report: CueExecutionReport;
      try {
        report = await this.dependencies.guardOutput(current, () => this.runner.run({ id: 'transport-start', name: '同步画面播放状态', notes: '', enabled: true,
          timecode: frameNumberToTimecode(frame, this.project.timebase.frameRate), actions: this.managed.transportActions('start', playing.map(entry => entry.event.sourceName)) }, 'live', current));
      } catch (error) {
        // Located but whether they play is not known: the next pass starts them again.
        for (const entry of playing) if (entry.writes[0]) this.ledger.unanswered(entry.writes[0], errorText(error));
        if (!current()) return cancelled();
        throw error;
      }
      this.dependencies.cueReport(report);
      for (const entry of playing) {
        const result = report.results.find(each => each.action.kind === 'obs.mediaAction' && each.action.inputName === entry.event.sourceName);
        const [decoder] = entry.writes;
        if (result?.status === 'succeeded') {
          // Played, also when locating it failed: the drift check puts it in step.
          if (decoder?.element === 'decoder') this.ledger.observe({ element: 'decoder', key: decoder.key, value: decoder.value }, this.dependencies.now());
          continue;
        }
        if (decoder) this.ledger.fail(decoder, result?.error ?? '没有完成');
        tally.failed.push({ label: `素材“${entry.event.assetName}”继续播放`, reason: result?.error ?? '没有完成' });
      }
    }
    if (!current()) return cancelled();
    if (losses === this.losses) {
      // Ticks queued meanwhile go out after this as what changed since this picture.
      this.lost = false; this.partial = this.ticks.length > 0;
    }
    return { sent: parts.length + targets.length, ...tally };
  }

  /** Sends in timeline order. Lateness never drops an action. A step that started
   * goes out whole even if a pause comes meanwhile, so what went out is exactly
   * known; a pause stops the send before the next step, stop or a failure at once.
   * Each step is measured against `dueAt` when it goes out; `each` reports it
   * there, otherwise the caller reports the largest once. With a `tally` (a
   * rebuild), how each part came back is counted there instead of reported. */
  private async send(entries: Entry[], current: () => boolean, dueAt: ((frame: number) => number) | null, each: boolean, tally?: Tally): Promise<SendResult> {
    const sending = (): boolean => !this.closed && !this.failure;
    let lateMs: number | null = null;
    for (let index = 0; index < entries.length;) {
      const entry = entries[index]!;
      if (!current()) return { complete: false, lateMs };
      const group = this.group(entries, index);
      const late = dueAt ? Math.round(this.dependencies.now() - dueAt(entry.frame)) : 0;
      lateMs = Math.max(lateMs ?? late, late);
      const results = await Promise.allSettled(group.map(member => this.output(member, sending, current)));
      results.forEach((result, member) => {
        if (result.status === 'fulfilled') { if (tally && result.value) tallyCue(tally, result.value); return; }
        const part = group[member]!;
        if (tally) tally.failed.push({ label: part.label, reason: errorText(result.reason) });
        else this.fault(`画面动作出错：${entry.label}：${String(result.reason)}`);
      });
      if (each && late > LATE_LOG_MS) this.late(late, lateText(entry.label, late));
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

  /** Steps that share one event boundary and are sent together: a composition and up
   * to 8 starts of its layers, so its acknowledgement does not hold the starts back;
   * otherwise up to 4 starts of layers in one composed frame, one render tick for all.
   * Never scene changes together, stops, or two steps on the same input. */
  private group(entries: Entry[], index: number): Entry[] {
    const entry = entries[index]!, group = [entry];
    const joins = (next: Entry | undefined): next is MediaEntry => next?.kind === 'media' && next.frame === entry.frame
      && next.event.phase === 'start' && next.event.deferSceneSwitch === true;
    if (entry.kind === 'cue' && !entry.layers) return group;
    if (entry.kind === 'media' && !joins(entry)) return group;
    const layers = entry.kind === 'cue' ? entry.layers : null, limit = layers ? 1 + COMPOSITION_GROUP_STARTS : DECODER_GROUP_STARTS;
    const sources = new Set(entry.kind === 'media' ? [entry.event.sourceName] : []);
    for (let next = entries[index + group.length]; group.length < limit && joins(next)
      && !sources.has(next.event.sourceName) && (!layers || layers.includes(next.event.sceneName)); next = entries[index + group.length]) {
      group.push(next); sources.add(next.event.sourceName);
    }
    return group;
  }

  /** Sends one step and writes what came back into the ledger: answered, refused, or
   * not sent after all (a pause or stop came before it went out). Failed results reach
   * the host as red reports; nothing here ends the channel. Resolves with the report
   * of the Cue it sent, or null for a clip event (reported to the host as a clip). */
  private async output(entry: Entry, canSend: () => boolean, current: () => boolean): Promise<CueExecutionReport | null> {
    for (const write of entry.writes) this.ledger.sent(write, this.dependencies.now());
    try {
      if (entry.kind === 'cue') {
        if (entry.point) this.sentDue.add(entry.point);
        const report = await this.cue(entry.cue, canSend);
        this.settle(entry.writes, cueOutcome(report));
        return report;
      }
      const event = entry.event, absent = event.phase === 'stop' && !this.managed.isActiveMedia(event);
      const report = await this.dependencies.guardOutput(canSend, () => this.managed.executeMedia(event, 'live', canSend));
      // A clip this run never started has nothing to stop.
      if (absent && report.status === 'skipped') for (const write of entry.writes) {
        if (write.element === 'decoder') this.ledger.observe({ element: 'decoder', key: write.key, value: write.value }, this.dependencies.now());
      } else this.settle(entry.writes, report.status === 'succeeded' ? 'ok' : report.status === 'failed'
        ? { failed: report.error ?? '素材动作没有完成', ...(report.outcome ? { step: report.outcome } : {}) } : 'withdrawn');
      this.dependencies.mediaReport(report);
      if (event.phase === 'start' && report.status === 'failed') this.refusedStarts.add(event.clipId);
      if (entry.lateMs !== null && report.status !== 'skipped') this.lateReady.delete(event.clipId);
      if (entry.lateMs !== null && report.status === 'succeeded') this.fault(`素材准备得晚了，已按当前位置开始播放：${event.assetName}（晚了 ${entry.lateMs} ms）`);
      return null;
    } catch (error) {
      this.settle(entry.writes, current() ? { failed: errorText(error) } : 'withdrawn');
      throw error;
    }
  }
  private settle(writes: readonly LedgerWrite[], outcome: Outcome): void {
    const now = this.dependencies.now();
    for (const write of writes) {
      if (outcome === 'ok') this.ledger.ack(write, now);
      else if (outcome === 'withdrawn') this.ledger.withdraw(write);
      else this.ledger.fail(write, outcome.failed);
    }
  }

  private preload(frame: number): void {
    const prepare = this.dependencies.prepareUpcoming;
    if (!prepare || this.restoring || this.preloadWork || frame - this.preloadFrame < this.fps / 10) return;
    this.preloadFrame = frame;
    const allowed = (): boolean => !this.closed && !this.failure;
    this.preloadWork = this.dependencies.guardOutput(allowed, () => prepare(frame, () => {
      if (!allowed()) throw new Error('后续素材准备已取消');
    })).then(prepared => { if (prepared) this.startLate(prepared); }).catch(error => { if (!this.closed && !this.failure) this.fault(`准备后面的素材失败：${error instanceof Error ? error.message : String(error)}；不会重试，到时候这个素材可能播不出来`); })
      .finally(() => { this.preloadWork = null; });
  }

  private settleMedia(frame: number): void {
    this.nextDriftCheck = Math.max(this.nextDriftCheck, frame + this.fps);
  }
  /** Recovery rule B for OBS video drifting from the music over a long clip. */
  private watchDrift(frame: number): void {
    const correct = this.dependencies.correctMediaDrift;
    if (!correct || frame < this.nextDriftCheck) return;
    this.nextDriftCheck = frame + 5 * this.fps;
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

  /** Recovery rule B for a decoder that missed its boundary: once it is ready, what
   * OBS holds of it is no longer the refusal, and the next pass starts the clip at the
   * current position if it should be on air now. Once per refused start. */
  private startLate(prepared: ManagedMediaEvent): void {
    const known = this.ledger.state().decoders.get(prepared.sourceName);
    if (!known || known.state === 'pending' || !this.refusedStarts.delete(prepared.clipId)) return;
    const value = known.state === 'unknown' ? known.last : known.value;
    if (value?.clipId !== prepared.clipId) return;
    this.ledger.forget({ element: 'decoder', key: prepared.sourceName, value, target: '' }, '素材准备好了');
    this.lateReady.add(prepared.clipId); this.settleMedia(Math.max(0, this.frame));
    this.scheduleDrain();
  }

  async pause(): Promise<void> {
    if (!this.prepared || this.closed || this.failure) return;
    if (this.runtime.getState() === 'paused') return;
    const generation = ++this.generation; this.advancing = false; this.pausedAt = this.dependencies.now();
    // What has not gone out waits for the resume, which then shows the picture at
    // the resumed position (docs/OBS_SCENE_WORKFLOW.md: 继续时再恢复当前有效画面).
    this.requireUpdate(this.runtime.pauseAutomatic());
    this.settleMedia(Math.max(0, this.frame));
    if (this.lost) {
      // OBS is being prepared again: the clips it may still play pause after that.
      this.enqueue(() => this.pauseDecoders(generation, false));
    } else {
      // The clips pause with the music, not after the step in flight, which goes
      // out whole so that what went out stays known. A clip that step plays
      // meanwhile is paused once it settled, unless the song plays again by then.
      const pausing = this.pauseDecoders(generation, true).catch(error => this.fault(`画面动作出错：${errorText(error)}`));
      this.enqueue(async () => { await pausing; await this.pauseDecoders(generation, false); });
    }
    await this.tail;
    const failure = this.error;
    if (failure) throw failure;
  }
  /** While paused only the decoders pause (2026-11-09); everything else waits for the
   * resume. `stopping`: a decoder whose stop is in flight is paused too, without
   * touching the ledger, since the stop's answer decides what it holds. A decoder
   * whose start is in flight is paused by the step after it, once that start answered. */
  private async pauseDecoders(generation: number, stopping: boolean): Promise<void> {
    const ops = whilePaused(this.plan(Math.max(0, this.frame), 'paused', true).plan).ops
      .filter((op): op is DecoderOp => op.kind === 'decoder.pause' && this.starts.get(op.clipId)?.assetKind !== 'image');
    const extra = stopping ? [...this.ledger.state().decoders].flatMap(([sourceName, known]) =>
      known.state === 'pending' && known.value.mode === 'stopped' ? [sourceName] : []) : [];
    await this.transport('pause', ops, extra, generation, this.pausedAt);
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
    const hides = [...this.ledger.state().shows].flatMap(([key, known]) => {
      const value = known.state === 'unknown' ? known.last : known.value;
      if (!value || value.sceneName === MANAGED_OBS_SCENE_NAME || !showMayBeOn(known)) return [];
      const entry = this.hideEntry({ kind: 'show.set', sceneName: value.sceneName, sourceName: value.sourceName, enabled: false, reason: 'cut',
        write: { element: 'show', key, value: { ...value, enabled: false }, target: 'off' } }, 'after');
      return entry?.kind === 'cue' ? [entry.cue] : [];
    });
    for (const cue of [...cleanup.cameraCues, ...hides]) {
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
    return report;
  }
  /** Plays or pauses these decoders as one media action each, unless the song changed
   * state meanwhile, and writes each answer into the ledger. `extra`: inputs paused
   * without a ledger write. Late is measured from `since`: logged, and shown in red
   * when the audience notices. A late resume is still sent: a clip left paused is
   * worse than one that starts late, and the drift check puts it back in step. */
  private async transport(action: 'start' | 'pause', ops: readonly DecoderOp[], extra: readonly string[], generation: number, since: number): Promise<void> {
    const current = (): boolean => generation === this.generation && !this.closed && !this.failure;
    const sources = [...new Set([...ops.map(op => op.sourceName), ...extra])];
    if (!sources.length || !current() || this.runtime.getState() !== (action === 'pause' ? 'paused' : 'running')) return;
    const cue = { id: `transport-${action}`, name: '同步画面播放状态', notes: '', enabled: true,
      timecode: frameNumberToTimecode(Math.max(0, this.frame), this.project.timebase.frameRate), actions: this.managed.transportActions(action, sources) };
    const lateMs = Math.round(this.dependencies.now() - since);
    for (const op of ops) this.ledger.sent(op.write, this.dependencies.now());
    let report: CueExecutionReport;
    try { report = await this.dependencies.guardOutput(current, () => this.runner.run(cue, 'live', current)); }
    catch (error) { this.settle(ops.map(op => op.write), current() ? { failed: errorText(error) } : 'withdrawn'); throw error; }
    this.dependencies.cueReport(report);
    for (const op of ops) {
      const result = report.results.find(each => each.action.kind === 'obs.mediaAction' && each.action.inputName === op.sourceName);
      this.settle([op.write], result?.status === 'succeeded' ? 'ok' : result?.status === 'failed' ? { failed: result.error ?? '没有完成' } : 'withdrawn');
    }
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
