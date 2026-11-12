import type { LinkCue, LinkProject, ObsPictureItem, ObsRecoveryCount, RundownItem } from '@tb/schema';
import { actionResultLog, CueActionRunner, type CueExecutionReport, type LinkActionExecutor } from './cue-action-runner';
import { CueRuntime, type DueCue, type RuntimeUpdate } from './cue-runtime';
import { frameNumberToTimecode, millisecondsToFrameNumber, playbackFramesPerSecond, type MtcSample } from './mtc-timecode';
import { alignManagedMediaEvent, ManagedOutputRuntime, MEDIA_NOT_STARTED, mediaTransportActions, type ManagedMediaExecutionReport, type ManagedMediaOutcome,
  type ManagedOutputRuntimeDependencies } from './managed-output-runtime';
import { compileManagedMediaTimeline, MANAGED_OBS_SCENE_NAME, type ManagedMediaEvent } from './managed-media-timeline';
import { ObsPictureLedger, pictureElementKey, showKey, showMayBeOn, type DecoderState, type Known, type LedgerWrite, type PictureLedgerState as PictureLedger } from './obs-picture-ledger';
import type { OnAirPicture } from './on-air-picture';
import { OUTPUT_RECOVERY_RULES, OutputRecovery, pictureRepairAllowed, pictureRepairKey, recordPictureRepair, type RecoveryBudgetView, type RecoveryResult, type RecoveryRow } from './output-recovery';
import { driftedDecoders, isHandSwitch, materialPositionMs, musicMissingText, nextPictureFollow, PICTURE_FOLLOW_SETTLE_MS, PICTURE_FOLLOW_START, PICTURE_READ_DECODERS, pictureFollowVerdict,
  type PictureFollow, type PictureFollowTarget, type PictureReading } from './picture-follow';
import { COMPOSITION_GROUP_STARTS, DECODER_GROUP_STARTS, decoderTarget, pictureOpWrites, pictureProgram, planPictureReconcile, programSignature, whilePaused, type PictureOp,
  type ReconcilePlan } from './picture-reconcile';
import { SceneOutputTimeline } from './scene-output-timeline';

export type ObsProgramSessionDependencies = ManagedOutputRuntimeDependencies & {
  /** `canSend` is checked before every request; `dispatched` runs when one is sent. */
  guardOutput: <T>(canSend: () => boolean, operation: () => Promise<T>, dispatched?: () => void) => Promise<T>;
  prepareOutputs: (assertCurrent: () => void) => Promise<void>;
  outputNotice?: () => string | null;
  /** Returns the clip it made ready; one already past its boundary starts late (rule B). `spaced` false: the song does
   * not play (paused, or prepared at a position), so preparations need not be spread over clock steps (R9). */
  prepareUpcoming?: (frame: number, assertCurrent: () => void, spaced?: boolean) => Promise<ManagedMediaEvent | null>;
  releaseOutputs: () => Promise<void>;
  /** The song stopped (R14): lets go of everything but the decoders of these clips, which hold its last frame until
   * `releaseOutputs` stops and hides them (less any a later song took over meanwhile). */
  holdOutputs: (held: readonly { sourceName: string; clipId: string }[]) => Promise<void>;
  /** The clips (by id) whose last frame the stopped song still holds, as the outputs know it: less those a later song
   * took over. Without it, every clip the ledger has on air. */
  heldClipIds?: () => ReadonlySet<string>;
  executor: LinkActionExecutor;
  /** Shows and locates a clip from the middle. Resolves with why its look could not be set (it is shown and located all
   * the same, 0.5.9 E16), or nothing. */
  seekMedia: (event: ManagedMediaEvent) => Promise<string | null | void>;
  /** A newer plan of the song arrived while it plays (0.5.9 R9): the outputs take it before its pass (new materials are
   * prepared in the background; our music item goes into scenes the song did not use, the one due at `frame` before
   * this resolves). Failures are the outputs' own to report: the picture goes on. `settled` is called each time a new
   * material is prepared or could not be. */
  retargetOutputs?: (project: LinkProject, frame: number, settled: () => void) => Promise<void>;
  /** Whether the decoder of a clip a newer plan brought is ready (0.5.9 R9); until it is, its part waits and what is on
   * air stays. Without it every clip counts as ready. */
  clipReady?: (event: ManagedMediaEvent) => 'ready' | 'preparing' | 'failed';
  /** Puts the decoder of a playing clip in step with the place a newer plan gives it (0.5.9 R9: moved, or its start
   * trimmed), where it plays now: no restart. */
  moveMedia?: (event: ManagedMediaEvent) => Promise<void>;
  /** Writes the look a newer plan gives the clip on air on its decoder (0.5.9 R9, E16). Resolves with why it could not
   * be set, or null. */
  relookMedia?: (event: ManagedMediaEvent) => Promise<string | null>;
  /** The pass of the plan of `revision` went out (0.5.9 R9), whatever each of its parts came to. */
  pictureApplied?: (revision: number) => void;
  /** Puts a playing clip back in step with the music; returns the drift corrected, or null. `mayCorrect`
   * is asked with the drift found before anything is corrected: false leaves the clip as it is. */
  correctMediaDrift?: (event: ManagedMediaEvent, mayCorrect: (driftMs: number) => boolean) => Promise<number | null>;
  /** Reads back what OBS shows now (R8): the program scene and these materials' decoders, each against where the music
   * has it when OBS answers (`positionAt`, on `now`'s clock). Read requests only, on the request scheduler's `control`
   * lane: a picture switch never waits for it. Without it nothing is read back and no drift is corrected. */
  readPicture?: (request: PictureReadRequest) => Promise<PictureReading>;
  /** Whether the picture follows the timeline as last read back, and the hand switch it waits for, whenever either changes. */
  pictureFollow?: (follow: PictureFollow, takeover: { sceneName: string } | null) => void;
  /** The lookahead may prepare this clip once more after its preparation failed (0.5.9 R5). */
  prepareAgain?: (clipId: string) => void;
  /** Whether OBS is connected now. Nothing is repaired while it is not: that is the connection's failure. */
  connected?: () => boolean;
  cueReport: (report: CueExecutionReport) => void;
  mediaReport: (report: ManagedMediaExecutionReport) => void;
  state: (update: RuntimeUpdate) => void;
  /** A live output fault: shown in red while the channel keeps running. */
  fault: (message: string) => void;
  /** The red text `message` no longer applies: the part of the picture it was about is right again. */
  clearFault?: (message: string) => void;
  /** Each part of the picture with something to report, and the song's recovery counts, whenever they change. */
  pictureItems?: (items: ObsPictureItem[], recoveries: ObsRecoveryCount[]) => void;
  now: () => number;
};

/** What a read-back asks OBS for (R8): each material by its name, with where it should be at the moment `at`. */
export type PictureReadRequest = { decoders: { sourceName: string; positionAt: (at: number) => number }[] };

/** A clip whose preparation did not succeed, from the output's lookahead: the session decides whether
 * it is prepared once more (`prepareAgain`), within the recovery limits. The message is the failure's. */
export class MediaPreparationFailed extends Error {
  constructor(readonly event: ManagedMediaEvent, message: string, options?: ErrorOptions) { super(message, options); }
}

/** Lateness up to this is logged; beyond it the operator sees it in red. Either way the action is sent. */
const LATE_LOG_MS = 100, LATE_FAULT_MS = 1000;
const lateText = (label: string, lateMs: number): string => `画面动作晚了 ${lateMs} ms 才发出：${label}。电脑或 OBS 当时太忙，画面已经按时间线切过去了`;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** A reason to follow “原因：” or to sit in brackets: without its own closing punctuation. */
const trimReason = (reason: string): string => reason.replace(/[。.；;\s]+$/u, '');
const DURATION_END = ':duration-end';
/** While OBS is not connected nothing is repaired: the connection is what failed (design 01 §4.5). */
const OFFLINE: RecoveryBudgetView = { allows: () => false };
/** How many times `row` allows, for the texts; null for a limit in time. */
const rowMax = (row: RecoveryRow): number | null => { const limit = OUTPUT_RECOVERY_RULES[row].limit; return limit.kind === 'duration' ? null : limit.max; };
/** The item of a clip's preparation and of a clip not in step with the music. */
const preparationItem = (clipId: string): string => `preload:${clipId}`;
const driftItem = (clipId: string): string => `drift:${clipId}`;
/** The item of a clip whose look could not be set as it was located or as a newer plan changed it (0.5.9 R9). */
const lookItem = (clipId: string): string => `look:${clipId}`;
/** The item of a playing clip that could not be put where a newer plan has it (0.5.9 R9). */
const moveItem = (clipId: string): string => `move:${clipId}`;
const formerKey = (sourceName: string, clipId: string): string => `${sourceName}\u0000${clipId}`;
/** Where in its file a clip is at song time zero: two plans with the same value play it in the same place. */
const alignmentMs = (event: ManagedMediaEvent, fps: number): number => event.sourceOffsetMs - event.frameNumber * 1000 / fps;

/** The song as this session can play it (the item there, only OBS actions); why not, in plain words. Checked as a
 * session opens and as a newer plan arrives (0.5.9 R9). Whatever drives the song's clock, the internal player or P1's
 * timecode, the session plays it the same way: it only ever sees positions (0.5.9, P1 picture). */
function pictureItem(project: LinkProject, itemId: string): RundownItem {
  const item = project.rundown.find(entry => entry.id === itemId);
  if (!item) throw new Error('后台画面节目不存在');
  // Other outputs belong to independent channels, never pretend that an OBS
  // executor sent MIDI or a console action.
  if (item.cues.some(cue => cue.actions.some(action => !action.kind.startsWith('obs.')))) throw new Error('后台画面快照含非 OBS 动作，必须先分配到对应输出通道');
  return item;
}
/** A newer version of the held song's picture plan that its picture cannot take (0.5.9 R9): the picture ends with this
 * reason, said the same wherever the version is refused (the picture session, or the host before it). */
export function unusablePictureVersionText(reason: string): string {
  return `这次修改的画面用不上：${trimReason(reason)}。音乐和时间码照常，这首歌停下重播时按新的样子放`;
}
/** The item of the music missing from the scene on program (R8). */
const MUSIC_ITEM = 'music';

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
 * `lateMs`: a clip that became ready after its boundary and starts late. `repairs`: the writes of the
 * ops it carries that send a failed or unknown part once more (0.5.9 R5), counted when it goes out. */
type Entry = { frame: number; priority: number; slot: Slot; label: string; writes: LedgerWrite[]; repairs?: LedgerWrite[] } & (
  | { kind: 'cue'; cue: LinkCue; point: string | null; layers: readonly string[] | null }
  | { kind: 'media'; event: ManagedMediaEvent; lateMs: number | null });
type MediaEntry = Extract<Entry, { kind: 'media' }>;
/** `step`: what a clip event came to, as the output told it (R3b); `settle` writes the ledger by it. */
type Outcome = 'ok' | 'withdrawn' | { failed: string; step?: ManagedMediaOutcome };
/** What a step's outcome means for the ledger (0.5.9 R5): carried out (also a clip on the picture all
 * the same, `aligned` false when it is not in step with the music), not sent, refused with nothing of it
 * sent, or sent and not known whether OBS carried it out (not answered, or stopped part way: a clip not
 * known to be on air may be all the same, R3b). */
type Verdict = { kind: 'ok'; aligned: boolean } | { kind: 'withdrawn' } | { kind: 'failed' | 'uncertain'; reason: string };
function verdictOf(outcome: Outcome): Verdict {
  if (outcome === 'ok') return { kind: 'ok', aligned: true };
  if (outcome === 'withdrawn') return { kind: 'withdrawn' };
  const step = outcome.step;
  if (!step || step.kind === 'done') return { kind: 'failed', reason: outcome.failed };
  switch (step.kind) {
    case 'withdrawn': return { kind: 'withdrawn' };
    case 'unanswered': return { kind: 'uncertain', reason: outcome.failed };
    case 'failed': return step.onAir ? { kind: 'ok', aligned: !step.outOfStep } : { kind: step.sent ? 'uncertain' : 'failed', reason: outcome.failed };
  }
}
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
 * position; otherwise on the resume after it, at the resumed position. `cause`:
 * what made the rebuild at the current position, when it was not a reconnect (a
 * picture joining music that started before it was ready). */
export function obsRecoveryText(recovery: ObsRecovery, reconnect: boolean, cause = 'OBS 已重新连接'): string {
  const at = reconnect ? '当前位置' : '继续播放的位置', scenesLost = recovery.failure !== null;
  // What happened first: OBS came back, and whether the owned scenes were prepared again.
  const opening = !scenesLost ? (reconnect ? `${cause}，` : '')
    : `${reconnect ? `${cause}，但` : 'OBS 重新连接后'}素材场景没有重新准备好：${recovery.failure}。`;
  const picture = scenesLost ? '机位' : '画面', missed = recovery.failed;
  if (!missed.length) return `${opening}${picture}已按${at}恢复（${recovery.sent} 项）${scenesLost ? '，素材可能播不出来' : ''}`;
  const reason = (miss: ObsRecoveryMiss): string => miss.reason.replace(/[。；\s]+$/, '');
  const what = missed.length === 1 ? `${missed[0]!.label}没有完成。原因：${reason(missed[0]!)}`
    : `${missed.length} 项没有完成：${missed.map(miss => `${miss.label}（原因：${reason(miss)}）`).join('；')}`;
  const back = recovery.succeeded ? `${picture}按${at}恢复了 ${recovery.succeeded} 项，` : `${picture}没有按${at}恢复，`;
  return `${opening}${back}${what}。${scenesLost ? '素材可能播不出来，' : ''}请在 OBS 里检查${missed.length === 1 ? '这一项' : '这几项'}，需要的话手动调好`;
}
/** The clip a decoder may still play or hold paused, as far as the ledger knows: one it
 * confirmed or was sent; one whose start, pause, resume or stop OBS refused (it may be on
 * air all the same); after a reconnect or a request not answered, the last one written, also
 * a stop that was not confirmed. A confirmed stop holds nothing, also after a reconnect (the ledger keeps it). */
function mayHold(known: Known<DecoderState> | undefined): string | null {
  if (!known) return null;
  switch (known.state) {
    case 'confirmed': case 'pending': return known.value.mode === 'stopped' ? null : known.value.clipId;
    case 'failed': return known.value.clipId;
    case 'unknown': return known.last ? known.last.clipId : null;
  }
}
/** A clip's decoder located and kept paused (OBS reconnected while the song was paused): the same clip and place, not playing. */
function pausedDecoder(write: LedgerWrite | undefined): LedgerWrite | undefined {
  if (write?.element !== 'decoder' || write.value.mode === 'stopped') return write;
  return { ...write, value: { ...write.value, mode: 'paused' }, target: decoderTarget(write.value.clipId, 'paused') };
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
  /** No material's position is judged within 1 s of a media start, resume or seek. */
  private nextDriftCheck = -Infinity;
  /** The read-back (R8): one in flight at most, about once a second while the song plays; `readTurn` rotates which
   * materials it reads when more are on air than one reading takes. */
  private reading = false;
  private nextRead = -Infinity;
  private readTurn = 0;
  private follow: PictureFollow = PICTURE_FOLLOW_START;
  /** Clips whose drift correction is queued: one at a time each. */
  private readonly correcting = new Set<string>();
  /** The last device clock observation: where the music is between two of them. */
  private lastClock: { positionMs: number; observedAt: number } | null = null;
  private preloadFrame = -Infinity;
  private runtime: CueRuntime;
  private readonly managed: ManagedOutputRuntime;
  private readonly runner: CueActionRunner;
  private timeline: SceneOutputTimeline;
  private readonly ledger = new ObsPictureLedger();
  /** This song's automatic recoveries and their limits (2026-11-10 decision 2): the counts are the table's. */
  private readonly recovery = new OutputRecovery();
  /** Each part of the picture with something to report, by element (or `preload:`/`drift:` and the clip). */
  private readonly items = new Map<string, ObsPictureItem>();
  /** Limits already reported, by element and wanted state: each said once. */
  private readonly limitsShown = new Set<string>();
  /** A part failed or is not known: the next device clock observation runs a pass that may repair it. */
  private repairDue = false;
  private cueById: ReadonlyMap<string, LinkCue>;
  private readonly starts = new Map<string, ManagedMediaEvent>();
  private readonly stops = new Map<string, ManagedMediaEvent>();
  /** Every clip event of the song, for the boundaries a clock step crossed. */
  private mediaEvents: readonly ManagedMediaEvent[];
  /** Clip starts of earlier plans whose decoder may still hold them (0.5.9 R9): its stop, pause, labels and cleanup. */
  private readonly former = new Map<string, ManagedMediaEvent>();
  /** Clips a newer plan brought or moved to another material: they wait for their decoder (`clipReady`). */
  private readonly introduced = new Set<string>();
  /** The newest plan to take, while one is queued (one at a time, newest only). */
  private wantedPlan: { project: LinkProject; revision: number } | null = null;
  private retargetQueued = false;
  /** A pass at the current position is due without a newer plan (`queuePass`), or one was cut short. */
  private passDue = false;
  /** A plan taken whose pass has not gone out: OBS was away (the restore sends it) or the song not started yet (its
   * first clock does). */
  private unapplied: number | null = null;
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
  private releasing: Promise<void> | null = null;
  /** The next clock starts the song where the music is then (`joinNextClock`). */
  private joining = false;

  constructor(private project: LinkProject, projectPath: string, private readonly itemId: string,
    private readonly dependencies: ObsProgramSessionDependencies) {
    const item = pictureItem(project, itemId);
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
    this.mediaEvents = compileManagedMediaTimeline(project, itemId).events;
    for (const event of this.mediaEvents) (event.phase === 'start' ? this.starts : this.stops).set(event.clipId, event);
    this.fps = playbackFramesPerSecond(project.timebase.frameRate);
  }

  get error(): Error | null { return this.failure; }
  get pendingCount(): number { return this.queued; }
  get nextCueId(): string | null { return this.runtime.getNextCueId(this.frame); }
  settled(): Promise<void> { return this.tail; }
  /** Prepared while the music went on (OBS came back, or the music started first; R7): the next clock starts the song
   * where the music is then, not where it was prepared, with nothing before it sent. The caller then rebuilds the
   * picture there (`recover`). */
  joinNextClock(): void { if (this.prepared && !this.closed && !this.failure && this.runtime.getState() === 'armed') this.joining = true; }
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
      this.locate(targets, [], frame);
      for (const entry of targets) {
        this.requireCurrent(generation);
        const [decoder, ...program] = entry.writes;
        for (const write of entry.writes) this.ledger.sent(write, this.dependencies.now());
        let outcome: Outcome = 'ok';
        try { this.lookProblem(entry.event, await this.dependencies.guardOutput(allowed, () => this.dependencies.seekMedia(entry.event))); }
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
      const sample = this.sample(positionMs, observedAt);
      this.lastClock = { positionMs, observedAt };
      if (this.joining) { this.joining = false; this.requireUpdate(this.runtime.moveStart(sample)); this.frame = sample.totalFrames; this.settleMedia(sample.totalFrames); }
      const previousFrame = this.frame;
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
      this.preload(sample.totalFrames); this.readBack(sample.totalFrames);
      // A plan taken before the song's first clock goes out as the picture now with it (R9).
      if (this.unapplied !== null && !this.lost && this.online()) this.queueRetarget();
      if (this.crossedMedia(previousFrame, sample.totalFrames)) this.settleMedia(sample.totalFrames);
      const points = this.points(update.dueCues), cut = this.cutIn(previousFrame, sample.totalFrames);
      if (cut !== null || points.length || update.rebuild) {
        const dueAt = (scheduledFrame: number): number => observedAt
          - Math.max(0, sample.totalFrames - scheduledFrame) * 1000 / playbackFramesPerSecond(sample.frameRate);
        const first = update.rebuild ? sample.totalFrames : Math.min(cut ?? Infinity, ...points.map(entry => entry.scheduledFrame));
        this.ticks.push({ from: previousFrame, to: sample.totalFrames, points, rebuild: update.rebuild === true, dueAt, earliestDueMs: dueAt(first), shift: 0 });
      }
      // A resume with nothing newly crossed still plays the clips again and sends
      // what the pause held back, and rebuilds a picture a pause kept from being rebuilt.
      // A part that failed or is not known is repaired by the pass after it, as the picture now.
      if (this.ticks.length || this.lost || resumed || this.repairDue && this.online()) this.scheduleDrain();
    } catch (error) { this.fail(error); }
  }
  /** Whether a clip starts or ends in (from, to]. The position only moves forward here: a
   * step back freezes the channel (`CueRuntime`), so no boundary is crossed twice. */
  private crossedMedia(from: number, to: number): boolean {
    return this.mediaEvents.some(event => from < event.frameNumber && event.frameNumber <= to);
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
      try { rebuilt = await this.restorePicture(); }
      catch (error) { this.dropQueued(); this.lost = false; this.partial = true; this.fault(`画面动作出错：${errorText(error)}`); return; }
      finally { this.restoring = this.lost; }
      if (!rebuilt) return;
      this.fault(obsRecoveryText(rebuilt, false));
      if (!this.playing() || this.lost) return;
    }
    const generation = this.generation, losses = this.losses;
    const current = (): boolean => generation === this.generation && !this.closed && !this.failure;
    this.repairDue = false;
    try {
      const taken = this.ticks.slice(), only = taken.length === 1 && !this.partial && !taken[0]!.rebuild ? taken[0]! : null;
      const frame = this.frame, planned = this.plan(frame, 'running', !only);
      this.review(planned.plan);
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
  private plan(frame: number, transport: 'running' | 'paused', merged: boolean, trigger?: 'retarget'): { picture: OnAirPicture; plan: ReconcilePlan } {
    const picture = this.timeline.pictureAt(frame);
    // Only a clip a newer plan brought can be waited for (R9): every other one is ready as before, and one whose decoder
    // missed its boundary goes the late road (`startLate`).
    const ready = (clip: { clipId: string }): 'ready' | 'preparing' | 'failed' => {
      const start = this.introduced.has(clip.clipId) ? this.starts.get(clip.clipId) : undefined;
      return start ? this.dependencies.clipReady?.(start) ?? 'ready' : 'ready';
    };
    // Live only: this session never runs a rehearsal, where the planner would hold everything after a failure instead.
    return { picture, plan: planPictureReconcile(picture, this.ledger.state(), { mode: 'live', transport, now: this.dependencies.now(),
      ready, budget: this.online() ? this.recovery : OFFLINE, holding: false, merged, trigger,
      // What an edit took off the picture (a clip deleted, or put on another material) stays while its replacement prepares.
      editedAway: (sourceName, clipId) => this.former.has(formerKey(sourceName, clipId)) }) };
  }
  private online(): boolean { return this.dependencies.connected?.() ?? true; }

  /** What a pass's plan says about the parts with something to report: one the plan sends afresh (a cut
   * passed, so its wanted state changed) or no longer mentions is right again, or no longer matters (one
   * it repairs, restores, waits for or holds stays listed until OBS answers); one
   * held at its limit is reported once, in red. Not while OBS is offline (nothing is repaired then). */
  private review(plan: ReconcilePlan): void {
    if (!this.online()) return;
    const mentioned = new Set([...plan.waiting.map(entry => entry.element), ...plan.suppressed.map(entry => entry.element),
      ...plan.ops.filter(op => op.reason === 'repair' || op.reason === 'restore').flatMap(op => pictureOpWrites(op).map(pictureElementKey))]);
    for (const [id, item] of this.items) if (!this.special(id) && item.scope !== 'channel' && !mentioned.has(id)) this.clearItem(id);
    for (const entry of plan.suppressed) if (entry.kind === 'repair-limit') this.repairLimit(entry.element, entry.target);
  }
  private special(id: string): boolean { return ['preload:', 'drift:', 'look:', 'move:'].some(prefix => id.startsWith(prefix)) || id === MUSIC_ITEM; }
  /** The steps that carry out the planner's ops, through the same Cues and clip events
   * as before: a camera as its Cue's switch, a composition as the owned composition Cue,
   * a clip's start through the preloaded decoder (its own scene in the same step when it
   * is the whole picture), a shown source as its span's show or hide. Pauses and resumes
   * are sent apart, as one media action each. */
  private translate({ picture, plan }: { picture: OnAirPicture; plan: ReconcilePlan }, frame: number, merged: boolean): Entry[] {
    const target = picture.target, steps: Entry[] = [];
    // Each step knows which of its ops repair a part, so that it is counted when it goes out.
    const entries = { push: (entry: Entry, ...ops: (PictureOp | undefined)[]): void => {
      const repairs = ops.filter((op): op is PictureOp => op?.reason === 'repair').map(op => op.write);
      steps.push(repairs.length ? { ...entry, repairs } : entry);
    } };
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
          // The clip as the decoder holds it: of an earlier plan when a newer one put the clip on another material (R9).
          const start = this.startOn(op.sourceName, clipId), stop = this.stops.get(clipId);
          const event = stop?.sourceName === op.sourceName ? stop : start ? { ...start, id: `${start.id}:stop`, phase: 'stop' as const } : undefined;
          if (event) entries.push({ kind: 'media', slot: 'stop', frame: 0, priority: 0, label: event.assetName, writes: [op.write], event, lateMs: null }, op);
          break;
        }
        case 'composition.update': {
          const program = plan.ops.find(other => other.kind === 'program.switch' && other.sceneName === op.sceneName);
          const entry = compositionCue([op.write, ...program ? [program.write] : []]);
          if (entry) entries.push(entry, op, program);
          break;
        }
        case 'program.switch': {
          if (target.kind === 'composition') {
            const entry = composition ? null : compositionCue([op.write]);
            if (entry) entries.push(entry, op);
          } else if (target.kind === 'clip') {
            // The clip already plays on its decoder (a camera over it ended): only its scene comes back on program.
            entries.push(this.cueEntry('program', { id: `timeline-selection:${this.itemId}`, name: '显示持续播放的素材', enabled: true, notes: '',
              timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
              actions: [{ id: `timeline-selection:${this.itemId}:scene`, label: '恢复底层画面', kind: 'obs.setProgramScene', sceneName: op.sceneName }] }, [op.write]), op);
          } else {
            // The camera's switch only; its other actions are point actions, sent once when crossed.
            const cue = target.cueId === null ? undefined : this.cueById.get(target.cueId);
            if (cue) entries.push(this.cueEntry('program', { ...cue, actions: cue.actions.filter(action => action.kind === 'obs.setProgramScene') }, [op.write]), op);
          }
          break;
        }
        case 'decoder.start': case 'decoder.handover': {
          const start = this.starts.get(op.clip.clipId);
          // A start OBS refused before any of it went out waits for its decoder to be ready: once it
          // is, the clip starts late at the current position, which is its repair (`startLate`).
          if (!start || op.reason === 'repair' && this.refusedStarts.has(start.clipId)) break;
          // A handover goes out as the later half's start: the output carries its predecessor's decoder on (no seek, no restart).
          // Only the clip that is the whole picture switches the program to its own scene; any
          // other start (a composition layer, a sound) leaves the program to the switch.
          const event = this.align({ ...start, deferSceneSwitch: !(target.kind === 'clip' && target.clipId === op.clip.clipId) }, frame);
          const lateMs = this.lateReady.has(start.clipId) ? Math.round(Math.max(0, frame - start.frameNumber) * 1000 / this.fps) : null;
          entries.push({ kind: 'media', slot: 'start', frame: 0, priority: 0, label: start.assetName, writes: pictureOpWrites(op), event, lateMs }, op);
          break;
        }
        case 'show.set': {
          // As the planner ordered it: newly due before the switch, restored or merged after it.
          const slot: Slot = op.reason === 'restore' || merged ? 'after' : 'before';
          const entry = op.enabled ? this.showEntry(picture, op, slot) : this.hideEntry(op, slot);
          if (entry) entries.push(entry, op);
          break;
        }
      }
    }
    return steps;
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

  /** A newer version of the song's picture plan while it plays, is paused, or is prepared at a position and not started
   * (0.5.9 R9, 2026-11-10 decision 1: “这一遍立即生效”). Throws, taking nothing, when the session cannot play it (why, in
   * plain words). Otherwise it is taken inside the session's own queue, between two passes, one at a time and newest
   * only: a version overtaken while it waited is dropped. What the session derives from the project is built first and
   * then replaced in one step; a plan it cannot be built from fails the picture, with why (`unusablePictureVersionText`).
   * What OBS has (the ledger), the recovery counts, the hand takeover, the read-back and the last frame held stay. Then one
   * pass brings the picture to what the new plan has at the current position: only the difference with the ledger goes
   * out, nothing between the two plans is replayed. Not playing, the clips are located and not played (paused while
   * paused; as a preparation at a position locates them before the first clock), and a clip the plan brought is prepared
   * at once. A pause or resume that cuts the pass short runs it again for the song's new state. While OBS is away the
   * plan is taken and nothing is sent: the restore after the reconnect sends it. `pictureApplied` says when its pass went
   * out. */
  retarget(project: LinkProject, revision: number): void {
    if (this.closed || this.failure) return;
    pictureItem(project, this.itemId);
    if (project.timebase.frameRate !== this.project.timebase.frameRate) throw new Error('这次修改改了工程的帧率，正在播的歌不能中途换过去');
    this.wantedPlan = { project, revision };
    this.queueRetarget();
  }
  /** Paused, or prepared at a position and not started: no clock drives the session, so the passes of a plan run by
   * themselves (R9). */
  private stillHeld(): boolean {
    const state = this.runtime.getState();
    return !this.closed && !this.failure && this.prepared && (state === 'paused' || state === 'armed' && this.frame >= 0);
  }
  /** The pass at the current position runs again without a newer plan (R9): a clip a plan brought became ready or could
   * not be, or its material was prepared or could not be. Only while the song is held: while it plays, the drain after
   * the next clock does it. */
  private queuePass(): void {
    if (!this.stillHeld()) return;
    this.passDue = true; this.queueRetarget();
  }
  private queueRetarget(): void {
    if (this.retargetQueued || this.closed || this.failure) return;
    this.retargetQueued = true; this.queued++;
    this.tail = this.tail.then(() => { this.retargetQueued = false; return this.retargetStep(); })
      .catch(error => this.fault(`画面没有完全换成这次修改的样子：${errorText(error)}`)).finally(() => { this.queued--; });
  }
  private async retargetStep(): Promise<void> {
    if (this.closed || this.failure) return;
    const wanted = this.wantedPlan;
    if (wanted) {
      this.wantedPlan = null;
      // Nothing of it was taken: the picture ends, as for a version refused before the queue (the music plays on).
      try { this.adopt(wanted.project); }
      catch (error) { this.fail(new Error(unusablePictureVersionText(errorText(error)))); return; }
      this.unapplied = wanted.revision;
    }
    if (this.unapplied === null && !this.passDue || !this.prepared) return;
    const state = this.runtime.getState();
    // Nothing of the song is on air yet: its first clock plays the new plan, with the outputs of that plan.
    if (state === 'armed' && this.frame < 0) {
      this.passDue = false;
      await this.outputsFor(0);
      if (!this.closed && !this.failure) this.reportApplied();
      return;
    }
    // Not started, or OBS away: sent by the first clock, or by the restore after the reconnect.
    if (state !== 'running' && state !== 'paused' && state !== 'armed' || this.lost || this.restoring || !this.online()) return;
    this.passDue = false;
    await this.retargetPass(state);
  }
  /** The plan of `project` replaces the one the session runs (see `retarget`). Everything derived from it is built
   * first; the swap after that cannot throw, so a plan that cannot be built leaves the session as it was. */
  private adopt(project: LinkProject): void {
    const item = pictureItem(project, this.itemId), state = this.runtime.getState();
    // The Cue runtime starts over where the song is, as when it joins music already playing: the Cues at or before the
    // playhead are not due, those after it are, and the ones this run already sent stay sent.
    const runtime = new CueRuntime(project, 100), now = this.dependencies.now();
    const sample = this.frame >= 0 ? this.sample((this.frame + 0.5) * 1000 / this.fps, this.lastClock?.observedAt ?? now) : null;
    for (const update of [runtime.selectItem(this.itemId), runtime.beginPreflight('live'), runtime.arm(now, sample, 'awaiting-external-start')]) {
      if (update.state === 'error') throw new Error(update.reason ?? '新的画面计划不能用');
    }
    runtime.carryExecuted(this.runtime.executedCues());
    const moved = state === 'running' && sample ? runtime.ingest(sample) : state === 'paused' ? runtime.pauseAutomatic() : null;
    if (moved?.state === 'error') throw new Error(moved.reason ?? '新的画面计划不能用');
    const events = compileManagedMediaTimeline(project, this.itemId).events;
    const timeline = new SceneOutputTimeline(project, this.itemId, events);
    const cueById = new Map(item.cues.map(cue => [cue.id, cue]));
    const spans = item.cues.flatMap(cue => cue.actions.flatMap(action => action.kind === 'obs.setSceneItemEnabled' ? [[action.id, cue.id] as const] : []));
    const before = new Map(this.starts);
    // The swap.
    this.runtime = runtime; this.project = project; this.plans++;
    this.managed.retarget(project, this.itemId, events, timeline);
    this.timeline = timeline; this.cueById = cueById; this.mediaEvents = events;
    this.spanCue.clear();
    for (const [actionId, cueId] of spans) this.spanCue.set(actionId, cueId);
    this.starts.clear(); this.stops.clear();
    for (const event of events) (event.phase === 'start' ? this.starts : this.stops).set(event.clipId, event);
    // What a decoder may still hold of an earlier plan stays known by that plan's event; a clip whose start changed is
    // judged afresh (its refusal and late readiness were about the old one).
    for (const [clipId, old] of before) {
      const next = this.starts.get(clipId);
      if (next?.sourceName !== old.sourceName) this.former.set(formerKey(old.sourceName, clipId), old);
      if (!next || next.sourceName !== old.sourceName || next.frameNumber !== old.frameNumber || next.sourceOffsetMs !== old.sourceOffsetMs) {
        this.refusedStarts.delete(clipId); this.lateReady.delete(clipId);
      }
    }
    for (const [clipId, next] of this.starts) if (before.get(clipId)?.sourceName !== next.sourceName) this.introduced.add(clipId);
    for (const clipId of [...this.introduced]) if (!this.starts.has(clipId)) this.introduced.delete(clipId);
    // A queued point Cue goes only if the new plan still has it there; with the new plan's actions.
    for (const tick of this.ticks) tick.points = tick.points.flatMap(entry => {
      const cue = this.cueById.get(entry.cue.id);
      return cue && cue.enabled && JSON.stringify(cue.timecode) === JSON.stringify(entry.cue.timecode) ? this.points([{ ...entry, cue }]) : [];
    });
    // Parts of clips the new plan no longer has are no longer this song's to report.
    for (const id of [...this.items.keys()]) {
      const [kind, ...rest] = id.split(':'), clipId = rest.join(':');
      if (['preload', 'drift', 'look', 'move'].includes(kind!) && !this.starts.has(clipId)) this.clearItem(id);
    }
    this.preloadFrame = -Infinity;
    // Accumulated until a pass carried the move out: versions taken while OBS was away compare with what was last on air.
    for (const [clipId, old] of before) {
      const next = this.starts.get(clipId);
      if (next?.sourceName === old.sourceName && !this.moved.has(clipId)) this.moved.set(clipId, old);
    }
    for (const clipId of [...this.moved.keys()]) if (this.starts.get(clipId)?.sourceName !== this.moved.get(clipId)!.sourceName) this.moved.delete(clipId);
  }
  /** Each clip that kept its material across the plan changes since its move last went out, with its event before them. */
  private readonly moved = new Map<string, ManagedMediaEvent>();
  /** Counts the plans taken (`adopt`): a reading sent under an earlier plan is not judged against a later one. */
  private plans = 0;
  /** The pass of a newer plan at the current position (see `retarget`). `state`: how the song is as it starts; a pause
   * or resume meanwhile cuts it short and it runs again for the new state (a seek or stop closes the session, a loss of
   * OBS is the restore's). */
  private async retargetPass(state: 'running' | 'paused' | 'armed'): Promise<void> {
    const revision = this.unapplied, generation = this.generation, losses = this.losses;
    const current = (): boolean => generation === this.generation && !this.closed && !this.failure && this.runtime.getState() === state;
    const again = (): void => {
      if (this.closed || this.failure || losses !== this.losses || this.lost) return;
      this.passDue = true; this.queueRetarget();
    };
    await this.outputsFor(Math.max(0, this.frame));
    if (!current()) { again(); return; }
    // Where the music is now: the outputs may have waited a round trip or two for OBS.
    const frame = Math.max(0, this.frame);
    if (!await this.retouch(frame, state, current)) { again(); return; }
    // Paused, a clip on air is compared by its place too (the planner locates one the new plan moved).
    const planned = this.plan(frame, state === 'paused' ? 'paused' : 'running', true, 'retarget');
    this.review(planned.plan);
    const entries = this.layout(this.translate(planned, frame, true), [], frame, true);
    // Not playing, the clips the new plan puts on air are located and not played: kept paused while paused; before the
    // first clock as a preparation at a position locates them (`prepareSession`), which the first clock plays.
    const targets = state === 'running' ? [] : entries.filter((entry): entry is MediaEntry => entry.kind === 'media' && entry.event.phase === 'start');
    const sent = await this.send(entries.filter(entry => !targets.includes(entry as MediaEntry)), current, null, false);
    if (losses !== this.losses) return;
    if (!sent.complete) { this.partial = true; again(); return; }
    for (const entry of targets) {
      if (!current()) { again(); return; }
      if (!await this.locateTarget(entry, state === 'paused', current)) { again(); return; }
    }
    if (losses !== this.losses) return;
    if (revision !== null && this.unapplied === revision) this.reportApplied();
    // A clip the plan brought that is wanted where the song stands: no clock drives the lookahead, so it is prepared now.
    if (state !== 'running') this.prepareHeld();
  }
  /** The outputs take the plan the session runs now (`retargetOutputs`), the scene due at `frame` first. */
  private async outputsFor(frame: number): Promise<void> {
    try { await this.dependencies.retargetOutputs?.(this.project, frame, () => this.queuePass()); }
    catch (error) { this.fault(`画面没有完全换成这次修改的样子：${errorText(error)}`); }
  }
  /** One clip a pass puts on air while the song does not play, located there: kept paused (`paused`), or, prepared at a
   * position and not started, counted as playing from there, as `prepareSession` locates it, so that the first clock plays
   * it and a pause after it pauses it. False when the song changed state first. */
  private async locateTarget(entry: MediaEntry, paused: boolean, current: () => boolean): Promise<boolean> {
    const [decoder, ...program] = entry.writes, located = paused && entry.event.assetKind !== 'image' ? pausedDecoder(decoder) : decoder;
    const writes = [located, ...program].filter((write): write is LedgerWrite => write !== undefined);
    for (const write of writes) this.ledger.sent(write, this.dependencies.now());
    if (paused) {
      try { this.lookProblem(entry.event, await this.dependencies.guardOutput(current, () => this.dependencies.seekMedia(entry.event))); this.settle(writes, 'ok'); }
      catch (error) { this.settle(writes, current() ? { failed: errorText(error) } : 'withdrawn'); }
      return current();
    }
    let outcome: Outcome = 'ok';
    try { this.lookProblem(entry.event, await this.dependencies.guardOutput(current, () => this.dependencies.seekMedia(entry.event))); }
    catch (error) {
      if (!current()) { this.settle(writes, 'withdrawn'); return false; }
      outcome = { failed: errorText(error) };
      this.fault(`素材没有对准改过的位置：${entry.event.assetName}：${errorText(error)}。音乐照常播放，这个素材的画面可能和音乐对不上`);
    }
    // As `prepareSession`: the decoder shows this clip once located, also when locating failed.
    if (decoder?.element === 'decoder') this.ledger.observe({ element: 'decoder', key: decoder.key, value: decoder.value }, this.dependencies.now());
    this.settle(program, outcome);
    return current();
  }
  /** Clips on air that kept their material: one the new plan moved (or whose start it trimmed) by a frame or more is put
   * in step: where it plays, with no restart; paused or not started yet, located there again and left so. One whose
   * look changed gets its new look on its decoder. Neither is a recovery: nothing is counted. Each entry leaves once its
   * move went out; one a pause or resume cut short stays for the pass after it. False when the song changed state
   * first. */
  private async retouch(frame: number, state: 'running' | 'paused' | 'armed', current: () => boolean): Promise<boolean> {
    const picture = this.timeline.pictureAt(frame), frameMs = 1000 / this.fps;
    const wanted = new Map([...picture.clips, ...picture.covered, ...picture.sounds].map(clip => [clip.clipId, clip]));
    for (const old of [...this.moved.values()]) {
      const next = this.starts.get(old.clipId), known = next && this.ledger.state().decoders.get(next.sourceName), clip = next && wanted.get(next.clipId);
      if (!next || !clip || known?.state !== 'confirmed' || known.value.clipId !== next.clipId || known.value.mode === 'stopped') { this.moved.delete(old.clipId); continue; }
      const event = this.align({ ...next, deferSceneSwitch: true }, frame);
      const shifted = next.assetKind !== 'image' && Math.abs(alignmentMs(next, this.fps) - alignmentMs(old, this.fps)) >= frameMs - 0.5;
      const relook = JSON.stringify(next.transform ?? null) !== JSON.stringify(old.transform ?? null);
      if (shifted && state === 'running' && this.dependencies.moveMedia) {
        try { await this.dependencies.guardOutput(current, () => this.dependencies.moveMedia!(event)); this.clearItem(moveItem(next.clipId)); this.settleMedia(frame); }
        catch (error) {
          if (!current()) return false;
          this.moveFailed(next, error);
        }
      }
      // Not playing: located there with its look and left as it is (paused, or not started yet), as a preparation at a
      // position locates it. The same one-frame threshold as while it plays; the planner then finds it in place.
      const located = shifted && state !== 'running';
      if (located) {
        try {
          this.lookProblem(next, await this.dependencies.guardOutput(current, () => this.dependencies.seekMedia(event)));
          this.clearItem(moveItem(next.clipId));
          this.ledger.observe({ element: 'decoder', key: next.sourceName, value: { ...known.value, offsetMs: clip.offsetMs } }, this.dependencies.now());
        } catch (error) {
          if (!current()) return false;
          this.moveFailed(next, error);
        }
      }
      if (relook && !located && this.dependencies.relookMedia) {
        try { this.lookProblem(next, await this.dependencies.guardOutput(current, () => this.dependencies.relookMedia!(event))); }
        catch (error) { if (current()) this.lookProblem(next, errorText(error)); }
      }
      if (!current()) return false;
      this.moved.delete(old.clipId);
    }
    return true;
  }
  private moveFailed(event: ManagedMediaEvent, error: unknown): void {
    const message = `素材“${event.assetName}”没能挪到改过的位置。原因：${trimReason(errorText(error))}。画面照常播，差得多时联动台过几秒会按音乐校正`;
    this.setItem(moveItem(event.clipId), 'item', 'failed', message); this.fault(message);
  }
  /** Held (paused, or prepared at a position), nothing drives the lookahead, which runs on clocks: a clip a newer plan
   * brought that is wanted where the song stands and still prepares is prepared now, one after the other (R9). Once it is
   * ready, or could not be, the pass after it puts the picture right (`introducedSettled`). */
  private prepareHeld(): void {
    if (!this.stillHeld() || !this.dependencies.clipReady) return;
    // One in flight may be for a clip a still newer plan no longer has: asked again once it ended (`preload`).
    if (this.preloadWork) { this.heldAgain = true; return; }
    const picture = this.timeline.pictureAt(Math.max(0, this.frame));
    const waiting = [...picture.clips, ...picture.covered, ...picture.sounds].some(clip => {
      const start = this.introduced.has(clip.clipId) ? this.starts.get(clip.clipId) : undefined;
      return start !== undefined && this.dependencies.clipReady?.(start) === 'preparing';
    });
    if (waiting) this.preload(Math.max(0, this.frame), false);
  }
  /** A held song's preparation was asked for while another was in flight (`prepareHeld`). */
  private heldAgain = false;
  /** A clip a newer plan brought is ready, or could not be: the pass after it puts the picture right, as the song plays
   * (the next drain) or as it is held (a pass of its own). */
  private introducedSettled(): void {
    if (this.playing()) this.scheduleDrain(); else this.queuePass();
  }
  /** A look that could not be set as a clip was located or changed (E16, R9): its own part of the picture, in red; it
   * does not make the clip count as not located. Set again: off the list. */
  private lookProblem(event: ManagedMediaEvent, problem: string | null | void): void {
    if (typeof problem !== 'string') { this.clearItem(lookItem(event.clipId)); return; }
    if (this.items.get(lookItem(event.clipId))?.detail === problem) return;
    this.setItem(lookItem(event.clipId), 'item', 'failed', problem); this.fault(problem);
  }
  private reportApplied(): void {
    const revision = this.unapplied;
    if (revision === null) return;
    this.unapplied = null;
    if (!this.closed && !this.failure) this.dependencies.pictureApplied?.(revision);
  }
  /** The clip `sourceName` holds: the current plan's, or an earlier plan's when the clip has moved to another material. */
  private startOn(sourceName: string, clipId: string): ManagedMediaEvent | undefined {
    const start = this.starts.get(clipId);
    return start?.sourceName === sourceName ? start : this.former.get(formerKey(sourceName, clipId)) ?? start;
  }

  /** Recovery rule B after OBS reconnects (R7, design 01 §4.7): from now on what OBS shows is
   * unknown (`invalidate`), and it may have forgotten the owned scenes. Once in-flight decoder
   * preparation settles, `restore` prepares the owned scenes again and the picture is rebuilt
   * at the latest position: while the song plays, as it plays; while it is paused, the clips
   * are located there and kept paused, and the resume plays them. A pause that comes while a
   * playing song's picture is rebuilt cancels it and the resume does it, in that order.
   * Resolves with what was rebuilt, or null when a pause or stop came first. A restore that
   * fails is not tried again: the cameras and shown sources are rebuilt anyway and the result
   * says why the scenes were not prepared. The channel keeps running. */
  recover(restore: () => Promise<void>): Promise<ObsRecovery | null> {
    const state = this.runtime.getState();
    if (!this.prepared || this.closed || this.failure || (state !== 'running' && state !== 'paused')) return Promise.resolve({ sent: 0, succeeded: 0, failed: [], failure: null });
    this.lost = true; this.losses++; this.pendingRestore = restore; this.restoring = true; this.queuedRebuilds++;
    this.ledger.invalidate('OBS 重新连接');
    const operation = this.tail.then(async () => {
      this.queuedRebuilds--;
      try { return await this.restorePicture(state === 'paused'); }
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
  /** Prepares the owned scenes again when a reconnect left that to do, then rebuilds the
   * picture while the song plays, or, `paused`, while it is still paused from the reconnect:
   * the clips located and kept paused. A pause cancels a playing rebuild, a resume a paused
   * one; the step it cancelled starts again once the song plays. A failed restore is
   * reported and not tried again; the picture is still rebuilt. */
  private async restorePicture(paused = false): Promise<ObsRecovery | null> {
    await this.preloadWork;
    for (;;) {
      const state = this.runtime.getState();
      const holding = paused && state === 'paused';
      if (!this.playing() && !(holding && !this.closed && !this.failure)) return null;
      // A resume ends the paused rebuild: from then on the picture is rebuilt as the song plays.
      if (!holding) paused = false;
      const generation = this.generation;
      const still = (): boolean => generation === this.generation && !this.closed && !this.failure && this.runtime.getState() === state;
      const restore = this.pendingRestore;
      if (restore) {
        try { await restore(); }
        catch (error) {
          // A pause or resume came first (the host refuses then): done again in the song's new state.
          if (!still()) continue;
          this.restoreFailure = errorText(error);
        }
        // Done while the song changed state: done again in its new state, so what OBS holds is the restore's then.
        if (!still()) continue;
        if (this.pendingRestore === restore) this.pendingRestore = null;
      }
      const rebuilt = await this.rebuildPicture(still, holding);
      if (rebuilt === null) continue;
      const failure = this.restoreFailure; this.restoreFailure = null;
      return { ...rebuilt, failure };
    }
  }
  /** The picture at the current position from nothing, like a start from the
   * middle: camera and shown sources first, clips on air located at the music,
   * then played together. A part that does not come back (a clip that cannot be
   * located among them) does not stop the rest; the result says which and why, and
   * whoever reports the rebuild says it once. Ticks still queued go out after this
   * as what changed since this picture, so their point Cues are not lost. `paused`: the
   * song is paused, so the clips are located and kept paused (located is paused in OBS) and
   * the resume plays them. Null when a pause, resume or stop came first: the picture stays
   * lost, and unknown. */
  private async rebuildPicture(current: () => boolean, paused: boolean): Promise<Omit<ObsRecovery, 'failure'> | null> {
    if (!current()) return null;
    const losses = this.losses;
    const cancelled = (): null => { this.ledger.invalidate('OBS 重新连接后恢复画面被打断'); return null; };
    this.refusedStarts.clear(); this.lateReady.clear(); this.preloadFrame = -Infinity; this.limitsShown.clear();
    this.ledger.invalidate('OBS 重新连接');
    const frame = this.frame, entries = this.layout(this.translate(this.plan(frame, 'running', true), frame, true), [], frame, true);
    const targets = entries.filter((entry): entry is MediaEntry => entry.kind === 'media' && entry.event.phase === 'start');
    const parts = entries.filter(entry => !targets.includes(entry as MediaEntry));
    this.locate(targets, parts, frame, paused);
    const tally: Tally = { succeeded: 0, failed: [] };
    if (!(await this.send(parts, current, null, false, tally)).complete) return cancelled();
    for (const entry of targets) {
      if (!current()) return cancelled();
      const [decoder, ...program] = entry.writes, located = paused && entry.event.assetKind !== 'image' ? pausedDecoder(decoder) : decoder;
      for (const write of [located, ...program]) if (write) this.ledger.sent(write, this.dependencies.now());
      try {
        this.lookProblem(entry.event, await this.dependencies.guardOutput(current, () => this.dependencies.seekMedia(entry.event))); tally.succeeded++; this.settle(program, 'ok');
        // Paused, a located clip is what OBS holds now: paused there, which the resume plays.
        if (paused && located !== decoder && located?.element === 'decoder') this.ledger.observe({ element: 'decoder', key: located.key, value: located.value }, this.dependencies.now());
      }
      catch (error) {
        if (!current()) return cancelled();
        tally.failed.push({ label: `素材“${entry.event.assetName}”对准音乐的位置`, reason: errorText(error) });
        this.settle([located, ...program].filter((write): write is LedgerWrite => write !== undefined), { failed: errorText(error) });
      }
    }
    const playing = paused ? [] : targets.filter(entry => entry.event.assetKind !== 'image');
    for (const entry of targets) if (entry.event.assetKind === 'image') this.settle(entry.writes.slice(0, 1), 'ok');
    if (playing.length && current()) {
      let report: CueExecutionReport;
      try {
        report = await this.dependencies.guardOutput(current, () => this.runner.run({ id: 'transport-start', name: '同步画面播放状态', notes: '', enabled: true,
          timecode: frameNumberToTimecode(frame, this.project.timebase.frameRate), actions: mediaTransportActions('start', playing.map(entry => entry.event.sourceName)) }, 'live', current));
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
      // A plan taken while OBS was away went out with this rebuild (R9).
      this.reportApplied();
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
    // A repair goes out only within the limits, and is counted, logged and shown as it does.
    if (entry.repairs && !this.repair(entry.repairs)) {
      // The step's other writes are not lost with it: the next pass leaves the part past its limit out and sends them.
      if (entry.writes.length > entry.repairs.length) this.repairDue = true;
      return null;
    }
    // A clip this run never started (or OBS forgot since) has nothing to stop: as the ledger held it before this step.
    const absent = entry.kind === 'media' && entry.event.phase === 'stop' && !this.held(entry.event.sourceName, entry.event.clipId);
    for (const write of entry.writes) this.ledger.sent(write, this.dependencies.now());
    try {
      if (entry.kind === 'cue') {
        if (entry.point) this.sentDue.add(entry.point);
        const report = await this.cue(entry.cue, canSend);
        this.settle(entry.writes, cueOutcome(report));
        return report;
      }
      const event = entry.event;
      const report = await this.dependencies.guardOutput(canSend, () => absent ? this.managed.skippedMedia(event, MEDIA_NOT_STARTED) : this.managed.sendMedia(event, 'live', canSend));
      if (absent && report.status === 'skipped') for (const write of entry.writes) {
        if (write.element === 'decoder') this.ledger.observe({ element: 'decoder', key: write.key, value: write.value }, this.dependencies.now());
      } else this.settle(entry.writes, report.status === 'succeeded' ? 'ok' : report.status === 'failed'
        ? { failed: report.error ?? '素材动作没有完成', ...(report.outcome ? { step: report.outcome } : {}) } : 'withdrawn');
      this.dependencies.mediaReport(report);
      // Refused before any of it went out: started late once its decoder is ready (`startLate`).
      if (event.phase === 'start' && report.status === 'failed' && verdictOf({ failed: '', ...(report.outcome ? { step: report.outcome } : {}) }).kind === 'failed') this.refusedStarts.add(event.clipId);
      if (entry.lateMs !== null && report.status !== 'skipped') this.lateReady.delete(event.clipId);
      if (entry.lateMs !== null && report.status === 'succeeded') this.fault(`素材准备得晚了，已按当前位置开始播放：${event.assetName}（晚了 ${entry.lateMs} ms）`);
      return null;
    } catch (error) {
      this.settle(entry.writes, current() ? { failed: errorText(error) } : 'withdrawn');
      throw error;
    }
  }
  /** Writes what a step came to into the ledger, by its kind (0.5.9 R5): carried out, also a clip on the
   * picture all the same (one not in step with the music is left to the drift check, and listed); not sent;
   * refused with nothing of it sent; sent and not known. Each failed or not known part is listed, and the
   * pass after it may repair it once. */
  private settle(writes: readonly LedgerWrite[], outcome: Outcome): void {
    const now = this.dependencies.now(), verdict = verdictOf(outcome);
    for (const write of writes) {
      const element = pictureElementKey(write);
      switch (verdict.kind) {
        case 'ok':
          this.ledger.ack(write, now);
          if (this.known(write)?.state === 'confirmed') this.clearItem(element);
          break;
        case 'withdrawn': this.ledger.withdraw(write); break;
        case 'failed': case 'uncertain': {
          if (verdict.kind === 'failed') this.ledger.fail(write, verdict.reason); else this.ledger.unanswered(write, verdict.reason);
          const known = this.known(write);
          if (known?.state !== 'failed' && !(known?.state === 'unknown' && known.target === write.target)) break;
          this.setItem(element, 'item', verdict.kind, `${this.labelOf(element, write.target)}${verdict.kind === 'failed' ? '没有成功' : '不确定 OBS 有没有做到'}。原因：${trimReason(verdict.reason)}`);
          this.repairDue = true;
          break;
        }
      }
    }
    if (verdict.kind === 'ok' && !verdict.aligned) for (const write of writes) {
      if (write.element !== 'decoder') continue;
      const name = this.starts.get(write.value.clipId)?.assetName ?? write.key;
      this.setItem(driftItem(write.value.clipId), 'item', 'not-aligned', `素材“${name}”已经在画面上，但和音乐没对齐。差得多时联动台过几秒会自动按音乐校正，不用处理`);
    }
  }
  private known(write: LedgerWrite): Known<unknown> | undefined {
    const state = this.ledger.state();
    switch (write.element) {
      case 'program': return state.program;
      case 'composition': return state.compositions.get(write.key);
      case 'decoder': return state.decoders.get(write.key);
      case 'show': return state.shows.get(write.key);
    }
  }

  /** The operator's name for a part of the picture, as wanted by `target`: a hide, a stop or a pause says so. */
  private labelOf(element: string, target: string): string {
    const [kind, ...rest] = element.split(':'), key = rest.join(':');
    switch (kind) {
      case 'program': return '切换节目画面';
      case 'composition': return '叠加画面';
      case 'decoder': {
        const start = [...this.starts.values(), ...this.former.values()].find(event => event.sourceName === key);
        const verb = target.endsWith(':stopped') ? '停止' : target.endsWith(':paused') ? '暂停' : '';
        return `${verb}素材“${start?.assetName ?? key}”`;
      }
      case 'show': {
        const parsed: unknown = JSON.parse(key);
        return `${target === 'off' ? '隐藏' : '显示'}来源 · ${Array.isArray(parsed) && typeof parsed[1] === 'string' ? parsed[1] : key}`;
      }
      default: return element;
    }
  }

  /** Counts, logs and shows the repair of these parts, as one step sends them once more (2026-11-10
   * decision 2): false, and nothing is sent, when one of them is past its limit by now. */
  private repair(writes: readonly LedgerWrite[]): boolean {
    const now = this.dependencies.now();
    const blocked = writes.find(write => !pictureRepairAllowed(this.recovery, pictureElementKey(write), write.target, now));
    if (blocked) { this.repairLimit(pictureElementKey(blocked), blocked.target); return false; }
    for (const write of writes) {
      const element = pictureElementKey(write), known = this.known(write);
      const reason = known?.state === 'failed' || known?.state === 'unknown' ? trimReason(known.reason) : '没有完成';
      const results = recordPictureRepair(this.recovery, element, write.target, now);
      const song = results[1]!;
      const message = `${this.labelOf(element, write.target)}没有成功（${reason}），已按现在该有的画面自动补发一次（这首歌第 ${song.count} 次，最多 ${rowMax('picture.song') ?? song.count} 次）。补上了就不用处理`;
      this.recovered(element, 'repairing', message, results, 'warning');
    }
    return true;
  }
  /** A part that may not be repaired again for its wanted state: shown in red once, until the timeline moves on. */
  private repairLimit(element: string, target: string): void {
    const key = pictureRepairKey(element, target);
    if (this.limitsShown.has(key)) return;
    this.limitsShown.add(key);
    const now = this.dependencies.now(), song = !this.recovery.allows('picture.song', 'song', now);
    const row: RecoveryRow = song ? 'picture.song' : 'picture.element';
    const message = `${this.labelOf(element, target)}${song ? '没有成功：' : '：'}${OUTPUT_RECOVERY_RULES[row].limitText}`;
    const count = this.recovery.counts().find(entry => entry.row === row && entry.key === (song ? 'song' : key))?.count ?? 0;
    this.recovered(element, 'limit', message, [{ row, key: song ? 'song' : key, channel: 'obs', outcome: 'limit', count, limit: OUTPUT_RECOVERY_RULES[row].limit,
      atLimit: OUTPUT_RECOVERY_RULES[row].atLimit, limitText: OUTPUT_RECOVERY_RULES[row].limitText }], 'error');
  }
  /** One recovery (or its limit) of `item`: in red on this song, in the run log with the channel, the item,
   * the count and the limit, and in the counts (design 01 §4.6). */
  private recovered(item: string, state: 'repairing' | 'limit', message: string, results: readonly RecoveryResult[], level: 'warning' | 'error'): void {
    this.setItem(item, 'item', state, message);
    this.fault(message);
    void this.dependencies.recordLog({ level, category: 'device', device: 'obs', message, projectId: this.project.projectId, itemId: this.itemId,
      result: state === 'limit' ? 'failed' : 'succeeded',
      details: { channel: 'obs', item, recoveries: results.map(result => ({ row: result.row, key: result.key, count: result.count, max: rowMax(result.row) })) } })
      .catch(error => this.fault(`记录画面自动补发失败：${errorText(error)}`));
  }

  private setItem(id: string, scope: ObsPictureItem['scope'], state: ObsPictureItem['state'], detail: string): void {
    const previous = this.items.get(id);
    if (previous?.state === state && previous.detail === detail && previous.scope === scope) return;
    this.items.delete(id); this.items.set(id, { id, scope, state, detail });
    this.publishItems();
  }
  /** The part is right again: off the list, and its red text cleared if it is still the one shown. */
  private clearItem(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    if (item.state === 'repairing' || item.state === 'limit') this.dependencies.clearFault?.(item.detail);
    this.publishItems();
  }
  private publishItems(): void {
    if (this.closed || this.failure) return;
    this.dependencies.pictureItems?.([...this.items.values()], this.recovery.counts().map(entry => {
      const max = rowMax(entry.row);
      return { row: entry.row, key: entry.key, count: entry.count, exhausted: entry.exhausted, ...(max === null ? {} : { max }) };
    }));
  }

  /** `spaced` false: held, with nothing clocking it (`prepareHeld`); each one that came to something asks for the next. */
  private preload(frame: number, spaced = true): void {
    const prepare = this.dependencies.prepareUpcoming;
    if (!prepare || this.restoring || this.preloadWork || spaced && frame - this.preloadFrame < this.fps / 10) return;
    this.preloadFrame = frame;
    const allowed = (): boolean => !this.closed && !this.failure;
    let settled = false;
    this.preloadWork = this.dependencies.guardOutput(allowed, () => prepare(frame, () => {
      if (!allowed()) throw new Error('后续素材准备已取消');
    }, spaced)).then(prepared => {
      if (!prepared) return;
      settled = true;
      this.clearItem(preparationItem(prepared.clipId)); this.startLate(prepared);
      // A clip a newer plan brought is ready: the pass after it puts it on air at the current position (R9).
      if (this.introduced.delete(prepared.clipId)) this.introducedSettled();
    })
      .catch(error => { if (!this.closed && !this.failure) { settled = error instanceof MediaPreparationFailed; this.preparationFailed(error); } })
      // One that prepared nothing while held does not ask again: nothing would change before the next pass. Unless a
      // pass asked meanwhile: what this one prepared may be a clip that pass no longer has.
      .finally(() => { this.preloadWork = null; const again = this.heldAgain; this.heldAgain = false; if (spaced || settled || again) this.prepareHeld(); });
  }
  /** A clip's preparation failed: prepared once more, within the limits (2026-11-10 decision 2), with a
   * red note and a log line each time. A failure that names no clip cannot be prepared again. */
  private preparationFailed(error: unknown): void {
    const reason = trimReason(errorText(error)), prepareAgain = this.dependencies.prepareAgain;
    if (!(error instanceof MediaPreparationFailed) || !prepareAgain) {
      this.fault(`准备后面的素材失败：${reason}；不会重试，到时候这个素材可能播不出来`);
      return;
    }
    const event = error.event, item = preparationItem(event.clipId), now = this.dependencies.now();
    // A clip a newer plan brought no longer waits for a decoder that does not come: its start goes out and says why (R9).
    if (this.introduced.delete(event.clipId)) this.introducedSettled();
    if (!this.online()) {
      // The connection failed, not the clip: OBS prepares the song's scenes again once it is back.
      const message = `准备后面的素材没成功：${event.assetName}。原因：${reason}。OBS 没有连接，重新连上 OBS 后会再准备`;
      this.setItem(item, 'item', 'failed', message); this.fault(message);
      return;
    }
    if (!pictureRepairAllowed(this.recovery, item, 'ready', now)) {
      const song = !this.recovery.allows('picture.song', 'song', now);
      const message = `准备后面的素材没成功：${event.assetName}。原因：${reason}。${song ? '这首歌自动补画面已到上限' : '已经自动再准备过一次'}，不再准备，到时候这个素材可能播不出来。请检查这个素材文件和 OBS 是否卡顿`;
      const row: RecoveryRow = song ? 'picture.song' : 'picture.element', key = song ? 'song' : pictureRepairKey(item, 'ready');
      const count = this.recovery.counts().find(entry => entry.row === row && entry.key === key)?.count ?? 0;
      this.recovered(item, 'limit', message, [{ row, key, channel: 'obs', outcome: 'limit', count, limit: OUTPUT_RECOVERY_RULES[row].limit,
        atLimit: OUTPUT_RECOVERY_RULES[row].atLimit, limitText: OUTPUT_RECOVERY_RULES[row].limitText }], 'error');
      return;
    }
    const results = recordPictureRepair(this.recovery, item, 'ready', now);
    prepareAgain(event.clipId);
    this.recovered(item, 'repairing', `准备后面的素材没成功：${event.assetName}。原因：${reason}。已自动再准备一次（这首歌第 ${results[1]!.count} 次，最多 ${rowMax('picture.song') ?? results[1]!.count} 次），准备好了就不用处理`,
      results, 'warning');
  }

  /** Clips located at `frame`, from the middle or on a rebuild: OBS prepared the owned scenes
   * (again), so what this run sent before no longer plays, and the stops a rebuild would send
   * find nothing to stop. Each clip located counts as sent from here, so that a cancellation
   * before its seek still stops it with the song. */
  private locate(targets: readonly MediaEntry[], parts: readonly Entry[], frame: number, paused = false): void {
    this.managed.resetExecution(); this.settleMedia(frame);
    const now = this.dependencies.now();
    for (const entry of parts) {
      const [write] = entry.writes;
      if (entry.kind === 'media' && write?.element === 'decoder') this.ledger.observe({ element: 'decoder', key: write.key, value: write.value }, now);
    }
    for (const entry of targets) {
      const write = paused && entry.event.assetKind !== 'image' ? pausedDecoder(entry.writes[0]) : entry.writes[0];
      if (write?.element === 'decoder') this.ledger.sent(write, now);
    }
  }
  /** Whether the ledger says this decoder may still hold this clip: the one place that says so, with `onAir`. */
  private held(sourceName: string, clipId: string): boolean {
    return mayHold(this.ledger.state().decoders.get(sourceName)) === clipId;
  }
  /** The clips that may be on air, as the ledger knows them: the drift check and the song's stop act on these. */
  private onAir(): ManagedMediaEvent[] {
    return [...this.ledger.state().decoders].flatMap(([sourceName, known]) => {
      const clipId = mayHold(known), start = clipId === null ? undefined : this.startOn(sourceName, clipId);
      return start ? [{ ...start, sourceName }] : [];
    });
  }
  private align(event: ManagedMediaEvent, frame: number): ManagedMediaEvent {
    return alignManagedMediaEvent(event, this.starts.get(event.clipId) ?? event, frame, this.project.timebase.frameRate);
  }

  private settleMedia(frame: number): void {
    this.nextDriftCheck = Math.max(this.nextDriftCheck, frame + this.fps);
  }
  /** The picture read back (R8, design 01 §4.8), about once a second while the song plays: what OBS has on program and
   * the materials on air, against what the timeline wants and the ledger confirmed. One reading at a time. While OBS is
   * away (R7) nothing is read and nothing counts against a limit: whether the picture follows cannot be confirmed. */
  private readBack(frame: number): void {
    const read = this.dependencies.readPicture;
    if (!read || this.reading || frame < this.nextRead) return;
    this.nextRead = frame + this.fps;
    if (!this.online() || this.lost || this.restoring) { this.setFollow({ state: 'unknown', detail: 'OBS 没有连接，重新连上后再核对画面', misses: 0 }); return; }
    const before = this.ledger.state(), clock = this.lastClock, generation = this.generation, plans = this.plans;
    if (!clock) return;
    const decoders = frame >= this.nextDriftCheck ? this.readable(before) : [];
    this.reading = true;
    const answer = (reading: PictureReading): void => {
      // A newer plan taken meanwhile (R9): the reading may be from before its pass, so it is not judged.
      if (generation !== this.generation || plans !== this.plans || !this.playing() || this.lost || this.restoring || !this.online()) return;
      this.judgeReading(reading, before, decoders);
    };
    void read({ decoders: decoders.map(event => ({ sourceName: event.sourceName,
      positionAt: at => materialPositionMs(event.sourceOffsetMs, event.frameNumber * 1000 / this.fps, clock.positionMs + at - clock.observedAt) })) })
      .then(answer, (error: unknown) => answer({ kind: 'unreadable', reason: trimReason(errorText(error)) }))
      .finally(() => { this.reading = false; });
  }
  /** The materials one reading compares: on air as OBS confirmed it more than a second ago, wanted now and playing with
   * the music; not images. At most `PICTURE_READ_DECODERS`, taking turns. */
  private readable(ledger: PictureLedger): ManagedMediaEvent[] {
    const picture = this.timeline.pictureAt(Math.max(0, this.frame)), now = this.dependencies.now();
    const wanted = new Set([...picture.clips, ...picture.covered, ...picture.sounds].map(clip => clip.clipId));
    const events = [...ledger.decoders].flatMap(([sourceName, known]) => {
      if (known.state !== 'confirmed' || known.value.mode !== 'playing' || now - known.at < PICTURE_FOLLOW_SETTLE_MS || !wanted.has(known.value.clipId)) return [];
      const start = this.starts.get(known.value.clipId);
      return start && start.assetKind !== 'image' ? [{ ...start, sourceName }] : [];
    });
    if (events.length <= PICTURE_READ_DECODERS) return events;
    const from = this.readTurn++ % events.length;
    return [...events.slice(from), ...events.slice(0, from)].slice(0, PICTURE_READ_DECODERS);
  }
  /** What a reading says, against the picture wanted when it came back. A part this song wrote since the reading went
   * out is not judged (the reading may be from before that switch), nor one switched within the last second. A program
   * switch that failed or is not known, read back as wanted, is confirmed: OBS shows it, there is nothing to repair. */
  private judgeReading(reading: PictureReading, before: PictureLedger, decoders: readonly ManagedMediaEvent[]): void {
    const ledger = this.ledger.state(), now = this.dependencies.now(), program = ledger.program;
    const wanted = pictureProgram(this.timeline.pictureAt(Math.max(0, this.frame)).target);
    let programScene: string | null = null, programWait: string | null = null;
    if (ledger.takenOver) programWait = null;
    else if (!wanted) programWait = '时间线这时不切节目画面';
    else if (program !== before.program || program.state === 'pending') programWait = '刚切过画面，稍后核对';
    else if (program.state === 'confirmed') {
      if (program.value.sceneName !== wanted.sceneName || program.value.cueId !== wanted.cueId) programWait = '画面正要切换';
      else if (now - program.at < PICTURE_FOLLOW_SETTLE_MS) programWait = '刚切过画面，稍后核对';
      else programScene = wanted.sceneName;
    } else if (reading.kind === 'read' && reading.programScene === wanted.sceneName && program.target === programSignature(wanted)) {
      this.ledger.observe({ element: 'program', value: wanted }, now); this.clearItem('program'); programScene = wanted.sceneName;
    } else programWait = program.state === 'unknown' && program.target === undefined ? '画面正要切换' : '这一项画面正在补发';
    const compared = decoders.filter(event => ledger.decoders.get(event.sourceName) === before.decoders.get(event.sourceName));
    const target: PictureFollowTarget = { programScene, programWait, takenOver: ledger.takenOver?.sceneName ?? null,
      decoders: compared.map(event => ({ sourceName: event.sourceName, assetName: event.assetName, mode: 'playing' })) };
    this.setFollow(nextPictureFollow(this.follow, pictureFollowVerdict(target, reading)));
    if (reading.kind !== 'read') return;
    // Out of step: listed, and corrected within the limit (picture.drift); in step again: off the list.
    const drifted = new Map(driftedDecoders(target, reading).map(entry => [entry.sourceName, entry.driftMs]));
    for (const event of compared) {
      const driftMs = drifted.get(event.sourceName);
      if (driftMs !== undefined) this.correctDrift(event, driftMs);
      else if (reading.decoders.some(entry => entry.sourceName === event.sourceName && entry.state === 'playing')) this.clearItem(driftItem(event.clipId));
    }
    this.music(reading.programScene, reading.music.kind === 'missing');
  }
  /** The scene on program does not carry the music: red, with what to do, until it does (checking only, R8). */
  private music(sceneName: string, missing: boolean): void {
    const item = this.items.get(MUSIC_ITEM);
    if (!missing) {
      if (!item) return;
      this.items.delete(MUSIC_ITEM); this.dependencies.clearFault?.(item.detail); this.publishItems();
      return;
    }
    const message = musicMissingText(sceneName);
    if (item?.detail === message) return;
    this.setItem(MUSIC_ITEM, 'item', 'failed', message); this.fault(message);
  }
  private setFollow(follow: PictureFollow): void {
    const previous = this.follow, takeover = this.ledger.state().takenOver;
    this.follow = follow;
    if (follow.state === previous.state && follow.detail === previous.detail) return;
    if (!this.closed && !this.failure) this.dependencies.pictureFollow?.(follow, takeover && { sceneName: takeover.sceneName });
  }

  /** OBS reports a new scene on program (2026-11-10 decision 5). One that is neither what the timeline wants nor what
   * this song last put there is a hand switch, also when another plugin made it. Taken over, the program is not switched
   * back; the materials and shown sources are still reconciled, and at the next segment whose program differs the switch
   * goes out as usual, which ends it (`ObsPictureLedger.ack`). Switched back to the wanted scene by hand: no longer taken
   * over. Not judged while a switch of this song is on its way (its answer decides), before the song's first clock, or
   * while OBS is away. */
  programSceneChanged(sceneName: string): void {
    if (!this.prepared || this.closed || this.failure || this.frame < 0 || this.lost || !this.online()) return;
    const state = this.runtime.getState();
    if (state !== 'running' && state !== 'paused') return;
    const ledger = this.ledger.state(), program = ledger.program, now = this.dependencies.now();
    if (program.state === 'pending' || ledger.takenOver?.sceneName === sceneName) return;
    const wanted = pictureProgram(this.timeline.pictureAt(this.frame).target);
    if (wanted && sceneName === wanted.sceneName) {
      if (!ledger.takenOver) return;
      this.ledger.observe({ element: 'program', value: wanted }, now);
      this.setFollow({ state: 'checking', detail: `OBS 切回了「${sceneName}」，画面按时间线照常走`, misses: 0 });
      return;
    }
    const ours = program.state === 'confirmed' ? program.value.sceneName : program.state === 'unknown' ? program.last?.sceneName ?? null : null;
    if (!wanted || !isHandSwitch(sceneName, wanted.sceneName, ours)) return;
    this.ledger.takeOver(sceneName, programSignature(wanted), now);
    this.setFollow({ state: 'taken-over', detail: `有人在 OBS 里切到了「${sceneName}」，联动台不切回去；到下一段画面按时间线照常切换`, misses: 0 });
    void this.dependencies.recordLog({ level: 'warning', category: 'action', device: 'obs', projectId: this.project.projectId, itemId: this.itemId,
      message: `有人在 OBS 里把节目画面切到了「${sceneName}」：联动台不切回去，到下一段画面按时间线照常切换`, details: { sceneName, wanted: wanted.sceneName } })
      .catch(error => this.fault(`记录画面被手动接管失败：${errorText(error)}`));
  }

  /** Recovery rule B for a material the read-back found out of step with the music: put back in step, once a minute per
   * clip at most (2026-11-10 decision 2), in the picture session's own queue, where the next cut waits for it. */
  private correctDrift(event: ManagedMediaEvent, driftMs: number): void {
    const correct = this.dependencies.correctMediaDrift;
    if (!correct || this.correcting.has(event.clipId)) return;
    if (!this.items.has(driftItem(event.clipId))) this.setItem(driftItem(event.clipId), 'item', 'not-aligned', `素材“${event.assetName}”和音乐差了 ${Math.abs(driftMs)} ms，正在按音乐校正`);
    const generation = this.generation;
    this.correcting.add(event.clipId);
    this.enqueue(async () => {
      const current = (): boolean => generation === this.generation && !this.closed && !this.failure && this.runtime.getState() === 'running';
      if (!current()) return;
      // One correction per clip a minute (2026-11-10 decision 2): past it the clip is left as it is, in red.
      let refused = false;
      const mayCorrect = (found: number): boolean => {
        if (this.recovery.allows('picture.drift', event.clipId, this.dependencies.now())) return true;
        refused = true; this.driftLimit(event, found);
        return false;
      };
      const drift = await this.dependencies.guardOutput(current, () => correct(this.align(event, this.frame), mayCorrect));
      if (drift === null) {
        // In step by the time it was corrected: a clip listed as out of step is right again.
        if (!refused) this.clearItem(driftItem(event.clipId));
        return;
      }
      const result = this.recovery.record('picture.drift', event.clipId, this.dependencies.now());
      this.recovered(driftItem(event.clipId), 'repairing', `素材和音乐差了 ${drift} ms，已按当前位置校正：${event.assetName}`, [result], 'warning');
    }, () => { this.correcting.delete(event.clipId); });
  }
  /** A clip found out of step again within the minute after its correction: not corrected again, in red once. */
  private driftLimit(event: ManagedMediaEvent, driftMs: number): void {
    if (this.items.get(driftItem(event.clipId))?.state === 'limit') return;
    const rule = OUTPUT_RECOVERY_RULES['picture.drift'];
    const count = this.recovery.counts().find(entry => entry.row === 'picture.drift' && entry.key === event.clipId)?.count ?? 0;
    this.recovered(driftItem(event.clipId), 'limit', `素材“${event.assetName}”和音乐差了 ${driftMs} ms，这一分钟里已经校正过，不再反复校正：${rule.limitText}`,
      [{ row: 'picture.drift', key: event.clipId, channel: 'obs', outcome: 'limit', count, limit: rule.limit, atLimit: rule.atLimit, limitText: rule.limitText }], 'error');
  }

  /** Recovery rule B for a decoder that missed its boundary: once it is ready, what
   * OBS holds of it is no longer the refusal, and the next pass starts the clip at the
   * current position if it should be on air now. Once per refused start. */
  private startLate(prepared: ManagedMediaEvent): void {
    const known = this.ledger.state().decoders.get(prepared.sourceName);
    if (!known || known.state === 'pending' || !this.refusedStarts.delete(prepared.clipId)) return;
    const value = known.state === 'unknown' ? known.last : known.value;
    if (value?.clipId !== prepared.clipId) return;
    // The late start is the refused start's repair: within the limits, counted and shown like any other.
    if (known.state === 'failed') {
      const element = pictureElementKey({ element: 'decoder', key: prepared.sourceName }), now = this.dependencies.now();
      if (!this.online() || !pictureRepairAllowed(this.recovery, element, known.target, now)) { if (this.online()) this.repairLimit(element, known.target); return; }
      const results = recordPictureRepair(this.recovery, element, known.target, now);
      this.recovered(element, 'repairing', `素材“${prepared.assetName}”切换时没准备好，现在准备好了，按当前位置自动补播一次（这首歌第 ${results[1]!.count} 次，最多 ${rowMax('picture.song') ?? results[1]!.count} 次）。补上了就不用处理`,
        results, 'warning');
    }
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
      .filter((op): op is DecoderOp => op.kind === 'decoder.pause' && this.startOn(op.sourceName, op.clipId)?.assetKind !== 'image');
    const extra = stopping ? [...this.ledger.state().decoders].flatMap(([sourceName, known]) =>
      known.state === 'pending' && known.value.mode === 'stopped' ? [sourceName] : []) : [];
    await this.transport('pause', ops, extra, generation, this.pausedAt);
  }

  /** Invalidate first; already sent network work may finish, but no queued action
   * from this generation is allowed to follow it. The song's picture stays on its last frame (R14, 2026-11-10
   * decision 4): the clips on air pause where they are and stay shown, the scene on program stays; only the
   * sources the song showed are hidden (2026-11-11 decision 3). What stays is taken off by `release`. */
  stop(): Promise<void> {
    this.stopping ??= this.stopSession();
    return this.stopping;
  }
  /** Some clip of this song may be on air (as the ledger knows it): a preparation at a position shows its frame already. */
  showsPicture(): boolean { return this.onAir().length > 0; }
  /** The clips the stopped song left on air (its last frame), by material and clip, as the ledger knows them. */
  heldClips(): { sourceName: string; clipId: string }[] {
    return this.closed ? this.onAir().map(event => ({ sourceName: event.sourceName, clipId: event.clipId })) : [];
  }
  /** Takes off what the stopped song left on air: as the next song's picture is on (so nothing goes black in between),
   * as the program closes, or after OBS came back while it was stopped. Once; a failure is not retried. Cleanup uses
   * only owned state: a decoder another song took over meanwhile is no longer this song's (its output skips it), and a
   * source on the owned output scene the song now playing shows (`inUse`) stays shown. */
  release(inUse: () => ReadonlySet<string> = () => new Set()): Promise<void> {
    this.releasing ??= this.releaseSession(inUse);
    return this.releasing;
  }
  /** The sources this song shows on the owned output scene (its cameras there), as the runtime tracks them. */
  ownedSceneSources(): ReadonlySet<string> { return this.managed.ownedSceneSources(); }
  private async releaseSession(inUse: () => ReadonlySet<string>): Promise<void> {
    // A failed stop was reported where it ran (`fail`, and the host's cleanup); what it left is taken off all the same.
    await this.stop().then(() => undefined, () => undefined);
    // Every clip still holding the last frame stops, as it was sent before R14 at the stop; one a later song took over is
    // that song's now.
    const still = this.dependencies.heldClipIds?.() ?? null;
    const errors: string[] = [], held = this.onAir().filter(event => still === null || still.has(event.clipId));
    for (const event of held) {
      try {
        const report = await this.managed.sendMedia({ ...event, id: `${event.id}:operator-stop`, phase: 'stop' }, 'live'); this.dependencies.mediaReport(report);
        if (report.status === 'failed') errors.push(report.error ?? '停止素材失败');
        else this.ledger.observe({ element: 'decoder', key: event.sourceName, value: { clipId: event.clipId, mode: 'stopped', offsetMs: 0 } }, this.dependencies.now());
      } catch (error) { errors.push(errorText(error)); }
    }
    // The song after it may show the same camera on the owned output scene: that one is the newer song's now.
    const shown = inUse();
    for (const cue of this.managed.takeCleanup().cameraCues.filter(cue => !cue.actions.some(action => action.kind === 'obs.setSceneItemEnabled' && shown.has(action.sourceName)))) {
      try {
        const failed = (await this.cue(cue, () => true)).results.find(result => result.status === 'failed');
        if (failed) errors.push(failed.error ?? `${failed.action.label}没有完成`);
      } catch (error) { errors.push(errorText(error)); }
    }
    try { await this.dependencies.releaseOutputs(); } catch (error) { errors.push(errorText(error)); }
    if (errors.length) throw new Error(`画面没有清理干净：${errors.join('；')}`);
  }
  /** The clips on air pause where they are, as one media action each, and the ledger says so: their decoders hold the
   * last frame. An image stays as it is. */
  private async holdDecoders(errors: string[]): Promise<void> {
    const writes = [...this.ledger.state().decoders].flatMap(([key, known]): Extract<LedgerWrite, { element: 'decoder' }>[] => {
      const value = known.state === 'unknown' ? known.last : known.value;
      if (!value || mayHold(known) === null || this.startOn(key, value.clipId)?.assetKind === 'image') return [];
      if (known.state === 'confirmed' && value.mode === 'paused') return [];
      return [{ element: 'decoder', key, value: { ...value, mode: 'paused' }, target: decoderTarget(value.clipId, 'paused') }];
    });
    if (!writes.length) return;
    const cue = { id: 'transport-hold', name: '停在最后一帧', notes: '', enabled: true,
      timecode: frameNumberToTimecode(Math.max(0, this.frame), this.project.timebase.frameRate), actions: mediaTransportActions('pause', writes.map(write => write.key)).map(action => ({ ...action, label: '停在最后一帧' })) };
    for (const write of writes) this.ledger.sent(write, this.dependencies.now());
    try {
      const report = await this.dependencies.guardOutput(() => true, () => this.runner.run(cue, 'live', () => true));
      this.dependencies.cueReport(report);
      for (const write of writes) {
        const result = report.results.find(each => each.action.kind === 'obs.mediaAction' && each.action.inputName === write.key);
        this.settle([write], result?.status === 'succeeded' ? 'ok' : result?.status === 'failed' ? { failed: result.error ?? '没有完成' } : 'withdrawn');
        if (result?.status === 'failed') errors.push(result.error ?? '素材没有停在最后一帧');
      }
    } catch (error) { this.settle(writes, { failed: errorText(error) }); errors.push(errorText(error)); }
  }
  private async stopSession(): Promise<void> {
    this.closed = true; ++this.generation; this.dependencies.state(this.runtime.stop());
    await this.tail;
    await this.preloadWork;
    const errors: string[] = [];
    await this.holdDecoders(errors);
    // A shown source whose span the song did not reach the end of is hidden with
    // the song; a later start from the middle shows it again.
    const hides = [...this.ledger.state().shows].flatMap(([key, known]) => {
      const value = known.state === 'unknown' ? known.last : known.value;
      if (!value || value.sceneName === MANAGED_OBS_SCENE_NAME || !showMayBeOn(known)) return [];
      const entry = this.hideEntry({ kind: 'show.set', sceneName: value.sceneName, sourceName: value.sourceName, enabled: false, reason: 'cut',
        write: { element: 'show', key, value: { ...value, enabled: false }, target: 'off' } }, 'after');
      return entry?.kind === 'cue' ? [entry.cue] : [];
    });
    for (const cue of hides) {
      try {
        const failed = (await this.cue(cue, () => true)).results.find(result => result.status === 'failed');
        if (failed) errors.push(failed.error ?? `${failed.action.label}没有完成`);
      } catch (error) { errors.push(errorText(error)); }
    }
    // The music's capture and every decoder not holding the last frame are let go now; the held ones by `release`.
    try { await this.dependencies.holdOutputs(this.heldClips()); }
    catch (error) { errors.push(errorText(error)); }
    if (errors.length) { const error = new Error(`画面没有清理干净：${errors.join('；')}`); this.fail(error); throw error; }
    this.dependencies.state(this.runtime.completeStop());
  }

  /** `done`: runs once the operation settled, or at once when it is not queued. */
  private enqueue(operation: () => Promise<void>, done?: () => void): void {
    if (this.closed || this.failure) { done?.(); return; }
    if (this.queued >= 64) { done?.(); this.fault('OBS 积压了超过 64 批画面动作，这一批没有发送；画面联动继续'); return; }
    const generation = this.generation; this.queued++;
    this.tail = this.tail.then(async () => {
      if (generation !== this.generation || this.closed || this.failure) return;
      await operation();
    }).catch(error => this.fault(`画面动作出错：${error instanceof Error ? error.message : String(error)}`)).finally(() => { this.queued--; done?.(); });
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
  private async transport(action: 'start' | 'pause', wanted: readonly DecoderOp[], extra: readonly string[], generation: number, since: number): Promise<void> {
    const current = (): boolean => generation === this.generation && !this.closed && !this.failure;
    if (!current() || this.runtime.getState() !== (action === 'pause' ? 'paused' : 'running')) return;
    // A pause or resume sent once more goes out only within the limits, counted as it does.
    const ops = wanted.filter(op => op.reason !== 'repair' || this.repair([op.write]));
    const sources = [...new Set([...ops.map(op => op.sourceName), ...extra])];
    if (!sources.length) return;
    const cue = { id: `transport-${action}`, name: '同步画面播放状态', notes: '', enabled: true,
      timecode: frameNumberToTimecode(Math.max(0, this.frame), this.project.timebase.frameRate), actions: mediaTransportActions(action, sources) };
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
  /** A lost timecode ends the picture too: on the internal clock it only comes from a position that jumped, and nothing
   * brings that clock back, so as waiting the picture would stay frozen without a word (R7 left design 01 §3.2 row 2 here). */
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
