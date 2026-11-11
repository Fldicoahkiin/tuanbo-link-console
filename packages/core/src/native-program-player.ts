import { createObsProgramSnapshot } from './obs-program-snapshot';
import { idleTimecodeOutput, timecodeOutputChange, type TimecodeOutputMemory } from './native-timecode-output';
import { playlistItems, programPlaylists } from './program-playlists';
import { toUserErrorMessage, toUserErrorReason } from './link-user-error';
import type { LinkDesktopApi } from './link-desktop-contract';
import type { LinkProject, NativePlayerControl, NativePlayerStatus, NativeObsPrepare, NativeObsStop, NativeObsStatus } from '@tb/schema';
import { nativeAudioAnalysis } from './native-audio-analysis';
import type { PlaybackBoundary, PlaybackClock } from './program-player';
import { emptyInternalPlayerState, type InternalPlayerDependencies, type InternalPlayerState } from './program-player';
import type { LightingOffOutcome, LitSong, ProgramLightingOutput } from './program-player';
import { lightsLeftOnText } from './lighting-off-ledger';
import { nativeProgramSnapshot } from './native-program-snapshot';
import { programStart, type ProgramStart } from './program-start';
import { optionalOutputReady } from './optional-output-ready';
import { savedSongVolume } from './link-command';

type NativeApi = Pick<LinkDesktopApi, 'prepareNativePlayback' | 'controlNativePlayback' | 'getNativePlaybackDevices' | 'onNativePlaybackStatus' | 'prepareNativeObs' | 'stopNativeObs' | 'onNativeObsStatus' | 'preloadNativeObs' | 'cancelNativeObsPreload'>;
type NativeAction = NativePlayerControl extends infer T ? T extends NativePlayerControl ? Omit<T, 'version' | 'sessionId' | 'generation'> : never : never;
/** A scrub still placing the song at `positionMs`, and the last play or pause pressed meanwhile. */
type Scrub = { token: number; positionMs: number; pressed: 'play' | 'pause' | null };
/** This start's red text: why the picture before it was not cleaned up, the picture host's own fault for this start
 * (which it repeats with each status), and the fault of this start shown next to the failed cleanup. */
type StartFaults = { leftover: string | null; obs: string | null; fault: string | null };

const notCleanedUp = /画面没有清理干净[:：]\s*/gu;

/** Why a picture was not fully cleaned up, as the operator reads it: no code prefixes, and that it was not cleaned up is
 * not repeated. Only what went wrong: a known OBS error reads as what happened and then what to do, and that advice is
 * for a preparation that failed, not for a cleanup (2026-11-09). What to check after a failed cleanup is said apart. */
export function pictureCleanupReason(error: unknown): string {
  const detail = pictureErrorDetail(error), shown = toUserErrorMessage(detail);
  const reason = shown === detail ? detail : shown.split('。')[0] ?? shown;
  return reason.replace(/[。.；;\s]+$/u, '') || '未知错误';
}

/** What a picture failure said, as the run log keeps it (2026-11-09): OBS's own words with the request and source names,
 * without code prefixes; that a picture was not cleaned up is not repeated. The operator reads `pictureCleanupReason`. */
export function pictureErrorDetail(error: unknown): string {
  const raw = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : String(error);
  return raw.replace(/\b(?:Error|TypeError|RangeError|SyntaxError):\s*/g, '').replace(notCleanedUp, '').trim() || '未知错误';
}

/** A song's picture was not fully cleaned up (2026-11-09). The picture host logged it where the cleanup ran; the
 * program hears it once, from its own stop of that picture, and shows it, or hands it back when it closes. Nothing
 * retries the cleanup. */
export class ObsPictureLeftover extends Error {
  /** `giveBack`: the picture host keeps it again, for the song that starts next. */
  constructor(readonly itemId: string, error: unknown, private readonly giveBack: () => void = () => undefined) {
    super(`${pictureCleanupReason(error)}。请检查 OBS 节目画面上是否还留着刚才的素材`);
  }
  /** Shown in red on the song that starts after it, which plays on. */
  next(itemId: string): string {
    return `${itemId === this.itemId ? '上一次' : '上一首'}的画面没有清理干净，这一首照常播。原因：${this.message}`;
  }
  /** Shown in red on the song whose own picture took too long and was given up on as it started; it plays on (2026-11-09). */
  cancelled(): string { return `取消的画面准备没有清理干净，不影响播放。原因：${this.message}`; }
  /** A program that closes has nowhere to show it: the next song to start shows it instead. */
  handBack(): void { this.giveBack(); }
}

/** Platform-neutral program transport. The owning host supplies audio, OBS,
 * generic MIDI and lighting ports; no browser or Electron globals are required. */
export class NativeProgramPlayer {
  private state: InternalPlayerState = { ...emptyInternalPlayerState };
  private native: NativePlayerStatus | null = null;
  private readonly sessionId = crypto.randomUUID();
  private nativeGeneration = 0;
  private requestedPreparation = false;
  private obsSession: NativeObsStop | null = null;
  private obsPreparing = false;
  private epoch = 0;
  private disposed = false;
  private closing: Promise<void> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private runtimePrepared = false;
  private runtimePreparation: AbortController | null = null;
  private finishing = false;
  private allowMtc = false;
  private picture: ProgramStart['picture'] = 'optional';
  private mtcSuppressed = false;
  private loopStart: number | null = null;
  private reflectGain = false;
  private ingestPending = false;
  private pendingPosition: number | null = null;
  private lastPosition = -1;
  private timecodeOutput: TimecodeOutputMemory = idleTimecodeOutput;
  private readonly boundaries = new Set<(event: PlaybackBoundary) => void>();
  private readonly unsubscribe: () => void;
  private readonly analysis = nativeAudioAnalysis(() => this.native);
  private volumePending: { volume: number; durationMs: number } | null = null;
  /** Saved song volumes the window's project changed after this program opened with `project` (setSongVolume). The
   * song's own volume is this, else what `project` saved (2026-11-09). */
  private readonly songVolumes = new Map<string, number>();
  private sendingVolume = false;
  private preloadGeneration = 0;
  private selectedPreload: { request: NativeObsStop; itemId: string } | null = null;
  /** The song whose executors the console runs from this program's timecode: set as a song starts, let go by its stop
   * (or by the next song, 第 4 题). The lights-off ledger of the main process decides what to switch off (R13). */
  private lit: LitSong | null = null;
  /** A stop was pressed and has not told the ledger yet: from the queued stop, or from dispose when the player closes
   * before that stop ran (it waited behind a seek, scrub or resume). A song that starts meanwhile settles it: its change
   * lets the previous song's executors go. A close without such a stop owes nothing. */
  private stopOwed = false;
  /** The scrub still placing the song (its seek or its picture in flight). A pause or resume pressed meanwhile does not
   * cancel the picture it prepares at the new position: the last one pressed decides how the scrub ends, paused there
   * or playing on from there (2026-11-09). */
  private scrubbing: Scrub | null = null;
  /** In red at this start, together (2026-11-09): why the picture before it was not cleaned up, first, and next to it
   * what failed as the song started (the picture host, the picture, the lights' Off at stop, the timecode), so neither
   * replaces the other. A fault after the start replaces them, as any later fault replaces the one shown. Each play
   * and scrub starts over. */
  private start: StartFaults = { leftover: null, obs: null, fault: null };
  /** The start a scrub started over, while its red is still shown as it was: an output in it that comes back still clears
   * its own part, next to the failed cleanup, which stays (2026-11-10). Of no use once anything else is shown in red. */
  private carried: StartFaults | null = null;
  /** The picture host's fault for the picture this program runs now, as last heard. The host repeats it with each status:
   * it is shown when it changes, so a later fault of another output stays shown (2026-11-10). A new picture starts over. */
  private obsFault: { session: NativeObsStop; text: string | null } | null = null;
  /** A window shows this player's state (setWatched). */
  private watched = true;

  readonly clock: PlaybackClock = {
    read: () => ({ positionMs: this.native?.positionMs ?? this.state.positionMs, durationMs: this.state.durationMs,
      ready: Boolean(this.native && !['preparing', 'error', 'stopped'].includes(this.native.status)),
      playing: this.native?.status === 'playing', seeking: this.state.status === 'preparing' }),
    subscribeBoundary: listener => { this.boundaries.add(listener); return () => { this.boundaries.delete(listener); }; }
  };
  constructor(private readonly project: LinkProject, private readonly projectPath: string, private readonly revision: number,
    private readonly dependencies: InternalPlayerDependencies, private readonly api: NativeApi,
    private readonly lighting: ProgramLightingOutput) {
    const audio = api.onNativePlaybackStatus(status => this.receive(status));
    const obs = api.onNativeObsStatus(status => this.receiveObs(status));
    this.unsubscribe = () => { audio(); obs(); };
  }

  preloadSelected(itemId: string): void {
    if (this.disposed || !this.projectPath || ['preparing', 'playing', 'paused'].includes(this.state.status)
      || this.dependencies.configuration().preload === false || this.selectedPreload?.itemId === itemId) return;
    try {
      const prepared = nativeProgramSnapshot(this.project, itemId, this.revision, undefined, this.dependencies.configuration().audioSampleRate ?? 48000);
      const request: NativeObsStop = { version: 1, sessionId: this.sessionId, generation: ++this.preloadGeneration };
      const selection = { request, itemId }; this.selectedPreload = selection;
      void this.api.preloadNativeObs({ ...request, projectPath: this.projectPath, positionMs: prepared.snapshot.positionMs,
        preciseSeeking: this.dependencies.preciseSeeking?.() ?? false, snapshot: createObsProgramSnapshot(this.project, itemId, this.revision) })
        // Once the song is being played it prepares its own picture; a preselection refused meanwhile is not a failure.
        .catch(error => { if (!this.disposed && this.selectedPreload === selection && !['preparing', 'playing', 'paused'].includes(this.state.status)) this.reportUnavailable(`节目画面没有准备好：${toUserErrorMessage(error)}`); });
    } catch (error) { this.reportUnavailable(`节目画面无法准备：${toUserErrorMessage(error)}`); }
  }
  private async cancelPreload(): Promise<void> {
    const selection = this.selectedPreload; this.selectedPreload = null;
    if (selection) await this.api.cancelNativeObsPreload(selection.request);
  }

  /** Every song starts with its timecode (2026-10-26); `programStart` decides what joins it. */
  play(itemId: string, positionMs?: number, paused = false): Promise<void> {
    const config = this.dependencies.configuration(), token = ++this.epoch;
    // The service discards another song's preselected picture for this play; that is not a failure.
    if (this.selectedPreload?.itemId !== itemId) this.selectedPreload = null;
    this.mtcSuppressed = !this.state.mtcEnabled;
    const reuseSession = itemId === this.state.itemId && ['playing', 'paused'].includes(this.state.status);
    if (this.state.itemId !== itemId && this.state.status === 'playing') this.markPlayed();
    this.cancelScheduled(); this.runtimePrepared = false; this.timecodeOutput = idleTimecodeOutput; this.boundary('seek');
    this.start = { leftover: null, obs: null, fault: null }; this.carried = null;
    // A MIDI CC7 volume is for this run of the song only: another song plays at its own volume.
    const override = itemId === this.state.itemId ? this.state.volumeOverride ?? null : null;
    this.update({ status: 'preparing', itemId, error: null, errorTitle: null, notice: null, fault: null, mtcConnectionFailed: false, volumeOverride: override });
    return this.enqueue(token, async () => {
      if (!this.projectPath) throw new Error('请先保存工程，再播放');
      // An engine in error has exited and rejects every command; prepare replaces it.
      if (this.native && this.native.status !== 'stopped' && this.native.status !== 'ended' && this.native.status !== 'error') await this.command({ kind: 'stop' });
      await this.stopObs().catch((error: unknown) => this.pictureNotStopped(error, '上一次的画面没清理干净'));
      await this.optionalRuntime(() => this.dependencies.stop(), '上一次的联动没清理干净');
      if (!this.current(token)) return;
      const prepared = programStart(this.project, itemId, { revision: this.revision, positionMs, sampleRate: config.audioSampleRate ?? 48000,
        mtcPortName: config.mtcPortName, check: !reuseSession });
      const item = this.project.rundown.find(entry => entry.id === itemId)!;
      for (const warning of prepared.warnings) this.reportUnavailable(warning);
      // The previous timecode has stopped: the previous song's executors this one does not use go off, without waiting.
      this.changeLighting(item.lighting ? { document: item.lighting, song: { itemId, title: item.title } } : null);
      this.allowMtc = prepared.allowMtc; this.picture = prepared.picture;
      const sendMtc = this.allowMtc && this.state.mtcEnabled;
      const midiPortName = sendMtc ? config.mtcPortName : null;
      // The song's own volume as saved now (or this run's CC7 volume), not as `project` had it when this program opened.
      const level = this.outputVolume() / 100;
      const snapshot = { ...prepared.snapshot, volume: config.fadeInMs && !paused ? 0 : level };
      const loop = item.lighting?.loop;
      this.loopStart = loop?.enabled && loop.startMs < loop.endMs && loop.startMs >= snapshot.startMs && loop.endMs <= snapshot.endMs && snapshot.positionMs < loop.endMs ? loop.startMs : null;
      if (this.loopStart !== null && loop) snapshot.endMs = loop.endMs;
      this.update({ positionMs: snapshot.positionMs, durationMs: snapshot.endMs, volume: level * 100,
        endAction: item.playback?.endAction ?? this.state.endAction, mtcPositionMs: this.allowMtc ? snapshot.positionMs + snapshot.offsetMs : null });
      let nextSnapshot: ProgramStart['snapshot'] | undefined;
      if (config.preload !== false) {
        const items = this.items();
        const next = this.loopStart !== null || this.state.endAction === 'loop' ? item
          : this.state.endAction === 'next' ? items[items.findIndex(entry => entry.id === itemId) + 1] : undefined;
        if (next) try {
          nextSnapshot = nativeProgramSnapshot(this.project, next.id, this.revision,
            this.loopStart ?? undefined, config.audioSampleRate ?? 48000).snapshot;
        } catch (error) { this.reportUnavailable(`下一个节目无法提前准备：${toUserErrorMessage(error)}`); }
      }
      this.requestedPreparation = true;
      const result = await this.api.prepareNativePlayback({ version: 1, sessionId: this.sessionId, generation: ++this.nativeGeneration,
        projectPath: this.projectPath, snapshot, ...(nextSnapshot ? { nextSnapshot } : {}), audioDeviceId: config.outputDeviceId, midiPortName,
        autoDetectMtc: sendMtc && !midiPortName && Boolean(item.p1Media || item.lighting), mtcQuarterFramesOnly: config.mtcSendMode === 'quarter-frames' });
      this.receive(result);
      if (!this.current(token)) { await this.command({ kind: 'stop' }); return; }
      if (this.mtcSuppressed && result.mtcPortName) await this.command({ kind: 'stop-mtc' });
      if (!this.current(token)) return;
      if (!this.current(token)) return;
      // The console runs the lighting from the timecode; nothing of it is prepared here.
      await Promise.all([this.prepareRuntime(itemId, snapshot.positionMs, reuseSession, token), this.prepareObs(itemId, token)]);
      if (!this.current(token)) return;
      // The volume may have changed while the song was prepared: it starts at the volume it has now.
      const target = this.outputVolume() / 100;
      if (config.fadeInMs && !paused) await this.command({ kind: 'volume', volume: target, durationMs: config.fadeInMs });
      else if (target !== snapshot.volume) await this.command({ kind: 'volume', volume: target, durationMs: 0 });
      if (!this.current(token)) return;
      if (target !== level) this.update({ volume: target * 100 });
      if (paused) { await this.command({ kind: 'pause' }); if (this.runtimePrepared) await this.optionalRuntime(() => this.dependencies.pause(), 'MIDI Cue 暂停失败'); this.update({ status: 'paused' }); return; }
      if (!this.current(token)) return;
      await this.command({ kind: 'play' });
      if (!this.current(token)) return;
      this.startCompanionClock();
      this.update({ status: 'playing' }); this.consumeClock();
    });
  }

  pause(): Promise<void> {
    const scrub = this.placing();
    // Pressed while a scrub is still placing the song: it stays paused there, with the picture it prepares for that
    // position, also when play was pressed before this during the same scrub (2026-11-09).
    if (scrub) { if (this.scrubbedStatus(scrub) === 'playing') scrub.pressed = 'pause'; return this.tail; }
    if (this.state.status !== 'playing') return Promise.resolve();
    const token = ++this.epoch; this.cancelScheduled();
    return this.enqueue(token, async () => {
      await this.command({ kind: 'pause' }); if (!this.current(token)) return;
      this.boundary('pause'); this.update({ status: 'paused', positionMs: this.native!.positionMs });
      if (this.runtimePrepared) await this.optionalRuntime(() => this.dependencies.pause(), '联动暂停失败');
    });
  }
  resume(): Promise<void> {
    const scrub = this.placing();
    if (scrub && this.state.itemId) {
      if (this.scrubbedStatus(scrub) !== 'paused') return this.tail;
      // Placed at the end of the song, play plays it again from its start, as below.
      if (scrub.positionMs >= this.state.durationMs) return this.play(this.state.itemId);
      // Pressed while a scrub is still placing the song: it plays on from there once placed, with the picture the
      // scrub prepares, instead of cancelling that picture and playing the rest of the song without it. Pressed again,
      // it still plays on once; a pause pressed after it keeps the song paused there (2026-11-09).
      scrub.pressed = 'play'; return this.tail;
    }
    if (this.state.status !== 'paused' || !this.state.itemId) return Promise.resolve();
    if ((this.native?.positionMs ?? 0) >= this.state.durationMs) return this.play(this.state.itemId);
    const token = ++this.epoch;
    return this.enqueue(token, () => this.playOn(token));
  }
  /** Plays on from where the song is paused. Pause cancels unsent MIDI and releases owned notes: the range ahead is
   * prepared before the audio resumes, as late preparation cannot join mid-song. */
  private async playOn(token: number): Promise<void> {
    if (this.state.status !== 'paused') return;
    await this.prepareRuntime(this.state.itemId!, this.native!.positionMs, true, token);
    if (!this.current(token)) return;
    // A pause drops a volume change still queued, and a fade-out left the gain down: the song plays on at its volume.
    const target = this.outputVolume() / 100;
    if (this.native!.gain !== target) { await this.command({ kind: 'volume', volume: target, durationMs: 0 }); if (!this.current(token)) return; }
    this.reflectGain = false; this.update({ volume: target * 100 });
    await this.command({ kind: 'play' }); if (!this.current(token)) return;
    this.startCompanionClock();
    this.update({ status: 'playing' }); this.consumeClock();
  }
  /** The scrub placing the song now, if one is: nothing newer was pressed or played since it began. */
  private placing(): Scrub | null { return this.scrubbing?.token === this.epoch ? this.scrubbing : null; }
  /** Playing or paused, as the operator last asked for while the scrub places the song. */
  private scrubbedStatus(scrub: Scrub): InternalPlayerState['status'] {
    return scrub.pressed === 'play' ? 'playing' : scrub.pressed === 'pause' ? 'paused' : this.state.status;
  }
  stop(): Promise<void> {
    const token = ++this.epoch; this.cancelScheduled(); this.update({ status: 'stopped', notice: null, fault: null, volumeOverride: null });
    this.stopOwed = true;
    // Stop reaches the main service immediately if preparation has already
    // published its session; otherwise the queued prepare cannot start audio.
    const stopping = (this.requestedPreparation ? this.command({ kind: 'stop' }) : Promise.resolve()).catch(error => { if (this.current(token)) this.fail(error); });
    return this.enqueue(token, async () => { await stopping; await this.releaseLighting('stop'); await this.optionalRuntime(() => this.cancelPreload(), '节目准备没清理干净');
      await this.stopObs().catch((error: unknown) => this.pictureNotStopped(error, '画面清理失败')); await this.dependencies.stop(); this.runtimePrepared = false;
      if (this.current(token)) { this.boundary('pause'); this.update({ positionMs: 0, mtcSentPositionMs: null }); } });
  }
  /** The stop pressed tells the ledger once the timecode stopped: the song's executors go off, and every Off still owed
   * is sent once more. What did not go out stays owed in the ledger (it resends once after the console connects). */
  private async releaseLighting(cause: 'stop' | 'close'): Promise<void> {
    if (!this.stopOwed) return;
    this.stopOwed = false;
    const lit = this.lit; this.lit = null;
    const outcome = await this.lighting.stop(lit, cause).catch((error: unknown): LightingOffOutcome => ({ failed: [{ song: lit?.song ?? null, reason: toUserErrorReason(error) }] }));
    if (outcome.failed.length && !this.disposed) this.runtimePrepared = false;
    this.offsFailed(outcome);
  }
  /** A song starts in place of the one lit before (第 4 题): the ledger switches off what only the previous one used. */
  private changeLighting(next: LitSong | null): void {
    const previous = this.lit; this.lit = next; this.stopOwed = false;
    if (!previous && !next) return;
    void this.lighting.change(previous, next).catch((error: unknown): LightingOffOutcome => ({ failed: [{ song: previous?.song ?? null, reason: toUserErrorReason(error) }] }))
      .then(outcome => this.offsFailed(outcome));
  }
  /** Offs that did not go out: shown in the player and logged. When no window shows the player's state, after it closed or
   * while its program plays on without a window (setWatched), they go to the host (closedFault): in a window in red, and
   * into the log as an error. Either way the text and the log name the song the Off was for, not the one playing now. */
  private offsFailed(outcome: LightingOffOutcome): void {
    const shown = new Set<string>();
    for (const { song, reason } of outcome.failed) {
      const message = lightsLeftOnText(song, reason);
      if (shown.has(message)) continue;
      shown.add(message);
      // Logged under the song the Off was for, which may not be the one in the player now.
      if (!this.disposed && this.watched) this.reportNotice(message, song?.itemId ?? null);
      else this.dependencies.closedFault(message, song?.itemId ?? null);
    }
  }
  /** Whether a window shows this player's state. NativeProgramService clears it while the program plays on after its
   * window's page is gone (the renderer exited, or the page reloaded), and sets it again when the next page takes the
   * program over. */
  setWatched(watched: boolean): void { this.watched = watched; }
  async reset(): Promise<void> { await this.stop(); if (this.state.status !== 'error') this.update({ itemId: null, playedItemIds: [], durationMs: 0 }); }
  externalStop(): void { void this.stop(); }
  freeze(message: string): void { void this.stop().then(() => this.update({ status: 'error', error: message, errorTitle: '播放已中断' })); }
  runtimeUnavailable(message: string): void { this.runtimePrepared = false; this.reportUnavailable(message); }
  /** A live output failure: shown in red; audio and the remaining actions continue. One reported as the song starts
   * stays next to a failed cleanup shown there, instead of replacing it (2026-11-09). */
  reportFault(message: string): void {
    if (!['preparing', 'playing', 'paused'].includes(this.state.status)) return;
    if (!this.starting()) { this.showFault(message); return; }
    this.start.fault = message; this.showFault(this.startRed(message));
  }
  /** The output behind this red message is back: clear it if it is still the one shown, also next to a failed cleanup,
   * which stays. */
  clearFault(message: string): void {
    if (this.state.fault === message) { this.update({ fault: null }); return; }
    const record = [this.start, this.carried].find(entry => this.faultShown(entry) === message);
    if (record) { record.fault = null; this.update({ fault: record.leftover }); }
  }
  /** The song or its picture is still being prepared (also at a scrub). */
  private starting(): boolean { return this.state.status === 'preparing' || this.obsPreparing; }
  /** A start's red text (this start's, unless another is named): the failed cleanup before it, then `fault`. */
  private startRed(fault: string | null, record: StartFaults = this.start): string { return [record.leftover, fault].filter(Boolean).join('；'); }
  /** The fault of this start, while it is in red (alone, or next to the failed cleanup before it). */
  private startFaultShown(): string | null { return this.faultShown(this.start); }
  /** The fault of a start, while that start's red is shown. */
  private faultShown(record: StartFaults | null): string | null {
    return record?.fault != null && this.state.fault === this.startRed(record.fault, record) ? record.fault : null;
  }
  /** The red text shown, as the output that reported it said it: without a failed cleanup shown before it. */
  private shownFault(): string | null { return this.startFaultShown() ?? this.faultShown(this.carried) ?? this.state.fault ?? null; }
  private showFault(text: string): void { if (this.state.fault !== text) this.update({ fault: text }); }
  /** An output that could not join or left this song: logged and shown in red, audio continues. */
  private startFault(message: string): void { this.dependencies.notice?.(message, this.state.itemId); this.reportFault(message); }
  reportUnavailable(message: string): void { this.reportNotice(message, this.state.itemId); }
  /** Shown once in the player's notice and logged under `itemId`. */
  private reportNotice(message: string, itemId: string | null): void {
    if (this.state.notice?.includes(message)) return;
    this.dependencies.notice?.(message, itemId);
    this.showNotice(message);
  }
  private showNotice(message: string): void {
    if (!this.state.notice?.includes(message)) this.update({ notice: [this.state.notice, message].filter(Boolean).join('；') });
  }
  /** Every stop of a picture this program prepared ends here when it fails, also the one at closing. A failed cleanup
   * was logged where it ran (2026-11-09): it is shown in red on the song on stage, which plays on, else on the stopped
   * player; one heard at or after closing is handed back to the picture host for the next song. `givenUp`: the start
   * whose own picture took too long and was cancelled, which says so while it is on stage. Any other failure to stop it
   * is shown and logged here (after closing, only logged). */
  private pictureNotStopped(error: unknown, doing: string, givenUp: StartFaults | null = null): void {
    if (!(error instanceof ObsPictureLeftover)) this.reportUnavailable(`${doing}：${toUserErrorMessage(error)}`);
    else if (this.disposed) error.handBack();
    else if (this.state.itemId && ['preparing', 'playing', 'paused'].includes(this.state.status)) this.showLeftover(givenUp === this.start ? error.cancelled() : error.next(this.state.itemId));
    else this.showNotice(`画面清理失败：${error.message}`);
  }
  /** Shown first, next to the fault of this start already shown, if one is. */
  private showLeftover(message: string): void {
    const fault = this.startFaultShown();
    this.start.leftover = message; this.showFault(this.startRed(fault));
  }
  seek(positionMs: number): Promise<void> { return this.state.itemId ? this.play(this.state.itemId, positionMs, this.state.status === 'paused') : Promise.resolve(); }
  scrub(itemId: string, positionMs: number): Promise<void> {
    if (this.state.status === 'error') return Promise.resolve();
    if (itemId !== this.state.itemId || !['playing', 'paused'].includes(this.state.status)) return this.play(itemId, positionMs, true);
    const token = ++this.epoch, scrub: Scrub = { token, positionMs, pressed: null };
    this.scrubbing = scrub; this.cancelScheduled(); this.boundary('seek');
    // The scrub starts its own record; the red shown stays as it is, and what is in it can still clear its own part.
    this.carried = this.faultShown(this.start) !== null ? this.start : this.faultShown(this.carried) !== null ? this.carried : null;
    this.start = { leftover: null, obs: null, fault: null };
    return this.enqueue(token, async () => {
      try {
        await this.command({ kind: 'seek', positionMs }); if (!this.current(token)) return;
        await this.stopObs().catch((error: unknown) => this.pictureNotStopped(error, '定位时画面清理失败')); if (!this.current(token)) return;
        await this.prepareObs(itemId, token); if (!this.current(token)) return;
        this.update({ status: 'paused', positionMs: this.native!.positionMs });
        if (this.runtimePrepared && this.dependencies.scrub) await this.optionalRuntime(() => this.dependencies.scrub!(positionMs), '联动定位失败');
      } finally { if (this.scrubbing === scrub) this.scrubbing = null; }
      // Play was the last pressed while it placed the song: it plays on from there, with the picture it prepared.
      if (scrub.pressed === 'play' && this.current(token)) await this.playOn(token);
    });
  }
  skip(direction: -1 | 1): Promise<void> { const items = this.items(), index = items.findIndex(item => item.id === this.state.itemId); const next = items[(index + direction + items.length) % items.length]; return next ? this.play(next.id) : Promise.resolve(); }
  setEndAction(endAction: InternalPlayerState['endAction']): void { this.update({ endAction }); }
  setPlaylist(playlistId: string): void { this.update({ playlistId }); }
  /** The play/pause key (MIDI note 1). Nothing while a song is being prepared, like the play buttons and Space: pressing
   * it again would start the preparation over from the start of the song and lose the position it prepares (2026-11-09).
   * While a scrub places the song it goes by what was last pressed meanwhile. */
  toggle(): Promise<void> {
    if (this.state.status === 'preparing') return Promise.resolve();
    const scrub = this.placing(), status = scrub ? this.scrubbedStatus(scrub) : this.state.status;
    if (status === 'playing') return this.pause(); if (status === 'paused') return this.resume();
    const item = this.items().find(item => item.id === this.state.itemId) ?? this.items()[0]; return item ? this.play(item.id) : Promise.resolve();
  }
  toggleMtc(): void {
    this.update({ mtcEnabled: !this.state.mtcEnabled });
    if (!this.state.mtcEnabled) this.mtcSuppressed = true;
    if (!this.state.mtcEnabled && this.native && !['preparing', 'stopped', 'error'].includes(this.native.status)) void this.command({ kind: 'stop-mtc' }).catch(error => this.reportUnavailable(`停止时间码失败：${toUserErrorMessage(error)}`));
    else if (this.state.mtcEnabled) this.reportUnavailable('下次播放时会重新准备时间码，这首歌不会中途补发。');
  }
  /** A song's own volume was saved (2026-11-09; the window's useSongVolumeSync sends it): the song plays at it from
   * now on, and at once when it is the song in the player and no CC7 volume holds this run. */
  setSongVolume(itemId: string, volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.songVolumes.set(itemId, clampVolume(volume));
    // While the song is prepared, its start reads the volume (play).
    if (itemId === this.state.itemId && ['playing', 'paused'].includes(this.state.status) && this.state.volumeOverride == null) this.output(this.outputVolume());
  }
  /** The player-bar slider while it is dragged: heard at once, saved nowhere; the release saves it (setSongVolume).
   * The operator took the slider, so a CC7 volume of this run gives way to it. */
  previewVolume(volume: number): void {
    if (!Number.isFinite(volume) || !['playing', 'paused'].includes(this.state.status)) return;
    if (this.state.volumeOverride != null) this.update({ volumeOverride: null });
    this.output(clampVolume(volume));
  }
  /** MIDI CC7: a temporary volume for this run of the song only (2026-11-09). Not saved and not undone; cleared when
   * the song changes or stops; with no song in the player there is no run for it to hold. */
  overrideVolume(volume: number): void {
    if (!Number.isFinite(volume) || !['preparing', 'playing', 'paused'].includes(this.state.status)) return;
    const target = clampVolume(volume); this.update({ volumeOverride: target }); this.output(target);
  }
  fade(out: boolean): void { const config = this.dependencies.configuration(); this.reflectGain = true; this.queueVolume(out ? 0 : this.outputVolume() / 100, (out ? config.fadeOutMs : config.fadeInMs) ?? 500); }
  /** What the song in the player plays at: this run's CC7 volume, else the song's own saved volume. */
  private outputVolume(): number {
    const itemId = this.state.itemId;
    if (this.state.volumeOverride != null) return this.state.volumeOverride;
    if (!itemId) return 100;
    const item = this.project.rundown.find(entry => entry.id === itemId);
    return this.songVolumes.get(itemId) ?? (item ? savedSongVolume(item) : 100);
  }
  private output(volume: number): void { this.reflectGain = false; this.update({ volume }); this.queueVolume(volume / 100, 0); }
  getAudioAnalysis() { return this.state.status === 'playing' ? this.analysis : null; }
  receiveMidi(bytes: Uint8Array): void {
    const [status, number, value] = bytes; if (status === undefined || number === undefined || number > 127) return;
    if ((status & 0xf0) === 0x90 && value !== undefined && value > 0 && value <= 127) {
      if (number === 1) void this.toggle(); else if (number === 2) void this.stop();
      else if (number >= 60) { const item = playlistItems(this.project, this.state.playlistId ?? 'all')[number - 60]; if (item?.enabled && item.referenceAudio) void this.play(item.id); }
    } else if ((status & 0xf0) === 0xb0 && number === 7 && value !== undefined && value <= 127) this.overrideVolume(value * 100 / 127);
    else if ((status & 0xf0) === 0xc0) { const list = programPlaylists(this.project)[number]; if (list) this.setPlaylist(list.id); }
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    ++this.epoch; this.disposed = true; this.unsubscribe(); this.boundaries.clear();
    const run = (operation: () => unknown): Promise<unknown> => Promise.resolve().then(operation);
    const scheduled = run(() => this.cancelScheduled(false));
    const audio = run(() => this.requestedPreparation && this.native?.status !== 'error' ? this.command({ kind: 'stop' }) : undefined);
    // A stop still queued here never runs; the Off it owes goes out once the timecode has stopped, as the stop would.
    const lighting = audio.then(() => this.releaseLighting('close'), () => this.releaseLighting('close'));
    // A picture, or a preselected one, that is not cleaned up never keeps the next program from opening or the app from
    // quitting (2026-11-09, 2026-11-10): a picture left on air is handed back, and the next song to start shows it; any
    // other failure is logged once here. Nor does the action MIDI that does not close (2026-11-11): the host logs it as
    // an error and shows it once in red (closedFault), and the quit does not take it for lights left on. The audio or
    // the queue that cannot stop still fail the close.
    const preload = run(() => this.cancelPreload()).catch((error: unknown) => this.reportUnavailable(`关闭节目时提前准备的画面没清理干净：${toUserErrorMessage(error)}`));
    const picture = run(() => this.stopObs()).catch((error: unknown) => this.pictureNotStopped(error, '关闭节目时画面清理失败'));
    const midi = run(() => this.dependencies.stop()).catch((error: unknown) => this.dependencies.closedFault(actionMidiLeftOpen(error), this.state.itemId, 'leftOpen'));
    const cleanup = [scheduled, audio, lighting, preload, picture, midi, run(() => this.tail)];
    this.closing = Promise.allSettled(cleanup).then(results => {
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
      if (failures.length) throw new AggregateError(failures, failures.map(toUserErrorMessage).join('；'));
    });
    return this.closing;
  }

  private receive(status: NativePlayerStatus): void {
    if (this.disposed || status.sessionId !== this.sessionId || status.generation !== this.nativeGeneration) return;
    // Like P1, an interrupted timecode resumes with a full frame; the service logs it, nothing turns red.
    const heard = this.native?.outputFault ?? null; this.native = status;
    // The timecode's red text may stand next to a failed cleanup shown at this start; its recovery clears only its own.
    const shown = this.shownFault(), timecode = timecodeOutputChange(this.timecodeOutput, status, shown); this.timecodeOutput = timecode.memory;
    if (timecode.fault) this.startFault(timecode.fault);
    if (timecode.clearFault && shown) this.clearFault(shown);
    if (timecode.notice) this.reportUnavailable(timecode.notice);
    this.update({ mtcConnectionFailed: Boolean(status.mtcError), mtcPortName: status.mtcError ? null : status.mtcPortName,
      mtcSentPositionMs: status.mtcPortName && !status.mtcError && status.mtcSent ? status.offsetMs + status.positionMs : null });
    if (status.audioError || status.status === 'error') { if (this.state.status !== 'error') this.fail(new Error(status.audioError ?? '音频服务已失效，请重新播放')); return; }
    // A dropout or a refused timecode send the song carried on from (2026-11-10 decision 2): red, playback goes on.
    if (status.outputFault && status.outputFault !== heard) this.reportFault(status.outputFault);
    if (this.state.status === 'playing') this.consumeClock();
  }
  private receiveObs(status: NativeObsStatus): void {
    if (this.disposed || !this.obsSession || status.sessionId !== this.obsSession.sessionId
      || status.generation < this.obsSession.generation || status.itemId !== this.state.itemId) return;
    this.dependencies.obsChanged?.(status);
    if (status.notice) this.reportUnavailable(status.notice);
    if (status.state === 'failed' || status.state === 'stopped' && status.reason) this.reportUnavailable(`画面没有联动或已停止，音频照常播放。原因：${status.reason ?? '未知错误'}`);
    // A stopped picture channel is an output fault for a song with picture work; for one without, the notice above is all.
    const fault = (status.state === 'failed' && this.picture === 'wait' ? `画面联动已停止：${status.reason ?? '未知错误'}` : status.fault) ?? null;
    const heard = this.obsFault?.session === this.obsSession ? this.obsFault.text : null;
    this.obsFault = { session: this.obsSession, text: fault };
    if (!fault || fault === heard) return;
    if (this.obsPreparing) this.start.obs = fault;
    // The host's fault for this start stays next to a failed cleanup shown there.
    if (fault !== this.start.obs) { this.reportFault(fault); return; }
    if (!['preparing', 'playing', 'paused'].includes(this.state.status)) return;
    this.start.fault = fault; this.showFault(this.startRed(fault));
  }
  private async prepareObs(itemId: string, token: number): Promise<void> {
    if (!this.current(token) || !this.native) return;
    const envelope: NativeObsStop = { version: 1, sessionId: this.sessionId, generation: this.nativeGeneration };
    try {
      const snapshot = createObsProgramSnapshot(this.project, itemId, this.revision);
      const nextFiles = this.nextObsFiles(itemId);
      this.obsSession = envelope; this.obsPreparing = true;
      const preparing = this.api.prepareNativeObs({ ...envelope, projectPath: this.projectPath,
        preciseSeeking: this.dependencies.preciseSeeking?.() ?? false, snapshot, ...(nextFiles ? { nextFiles } : {}) });
      // A song that needs its picture waits for it (a first play may build seek
      // caches); the operator can stop. Optional picture keeps the one-second window.
      const start = this.start;
      const status = await (this.picture === 'wait' ? preparing : optionalOutputReady(preparing,
        () => { void this.stopObs().catch((error: unknown) => this.pictureNotStopped(error, '取消画面准备失败', start)); }, '后台画面'));
      if (this.current(token) && this.obsSession === envelope) this.receiveObs(status);
      else await this.stopObs().catch((error: unknown) => this.pictureNotStopped(error, '取消画面准备失败'));
    } catch (error) {
      // Rule 9 (2026-10-26) replaces the decision of 2026-10-19: a song with picture work plays without
      // its picture, in red, instead of not starting; audio and timecode go on.
      if (!this.current(token)) return;
      if (this.picture === 'wait') this.startFault(`画面准备失败，音乐和时间码照常播放：${toUserErrorMessage(error)}`);
      else this.reportUnavailable(`画面没有联动，音频照常播放。原因：${toUserErrorMessage(error)}`);
    }
    finally { if (this.obsSession === envelope) this.obsPreparing = false; }
  }
  private nextObsFiles(itemId: string): NativeObsPrepare['nextFiles'] {
    if (this.dependencies.configuration().preload === false || this.state.endAction !== 'next') return undefined;
    const items = this.items(), next = items[items.findIndex(item => item.id === itemId) + 1];
    if (!next) return undefined;
    try {
      return { snapshot: createObsProgramSnapshot(this.project, next.id, this.revision),
        positionMs: nativeProgramSnapshot(this.project, next.id, this.revision, undefined, this.dependencies.configuration().audioSampleRate ?? 48000).snapshot.positionMs };
    } catch (error) { this.reportUnavailable(`下一个节目的文件没有准备：${toUserErrorMessage(error)}`); return undefined; }
  }
  private async stopObs(): Promise<void> {
    const envelope = this.obsSession; this.obsSession = null; this.obsPreparing = false;
    if (envelope) await this.api.stopNativeObs(envelope);
  }
  private consumeClock(): void {
    const output = this.native; if (!output || this.finishing) return;
    this.update({ positionMs: output.positionMs, mtcPositionMs: this.allowMtc ? output.positionMs + output.offsetMs : null,
      ...(this.reflectGain ? { volume: output.gain * 100 } : {}) });
    if (output.status === 'ended') { void this.finish(); return; }
    if (output.status !== 'playing' || output.positionMs === this.lastPosition) return;
    this.lastPosition = output.positionMs;
    if (this.runtimePrepared) { this.pendingPosition = output.positionMs; void this.ingest(); }
  }
  private startCompanionClock(): void {
    if (!this.runtimePrepared || !this.native) return;
    try { this.dependencies.started?.(this.native.positionMs); }
    catch (error) { this.runtimeUnavailable(`通用 MIDI Cue 没有启动，音频和画面照常进行。原因：${toUserErrorMessage(error)}`); }
  }
  private async ingest(): Promise<void> {
    if (this.ingestPending) return;
    const token = this.epoch; this.ingestPending = true;
    try { while (this.current(token) && this.runtimePrepared && this.pendingPosition !== null) { const position = this.pendingPosition; this.pendingPosition = null; await this.dependencies.ingest(position); } }
    catch (error) { if (this.current(token)) this.runtimeUnavailable(`通用 MIDI Cue 已停止：${toUserErrorMessage(error)}`); }
    finally { this.ingestPending = false; }
  }
  private async finish(): Promise<void> {
    const token = this.epoch; this.finishing = true;
    try {
      if (!this.current(token)) return;
      if (this.loopStart !== null && this.state.itemId) { await this.play(this.state.itemId, this.loopStart); return; }
      this.boundary('end'); this.markPlayed(); this.cancelScheduled();
      if (this.state.endAction === 'pause') { this.update({ status: 'paused' }); if (this.runtimePrepared) await this.optionalRuntime(() => this.dependencies.pause(), 'MIDI Cue 结束暂停失败'); }
      else if (this.state.endAction === 'loop' && this.state.itemId) await this.play(this.state.itemId);
      else { const items = this.items(), next = items[items.findIndex(item => item.id === this.state.itemId) + 1]; if (this.state.endAction === 'next' && next) await this.play(next.id); else await this.stop(); }
    } catch (error) { if (this.current(token)) this.fail(error); }
  }
  private queueVolume(volume: number, durationMs: number): void {
    this.volumePending = { volume, durationMs };
    if (this.sendingVolume || !this.native || !['ready', 'playing', 'paused'].includes(this.native.status)) return;
    const token = this.epoch; this.sendingVolume = true;
    const run = async (): Promise<void> => { while (this.current(token) && this.volumePending) { const target = this.volumePending; this.volumePending = null; await this.command({ kind: 'volume', ...target }); } };
    void run().catch(error => { if (this.current(token)) this.reportUnavailable(`音量修改失败：${toUserErrorMessage(error)}`); }).finally(() => { this.sendingVolume = false; });
  }
  private async command(action: NativeAction): Promise<void> {
    const generation = action.kind === 'volume' ? this.nativeGeneration : ++this.nativeGeneration;
    this.receive(await this.api.controlNativePlayback({ version: 1, sessionId: this.sessionId, generation, ...action }));
  }
  private enqueue(token: number, operation: () => Promise<void>): Promise<void> {
    this.tail = this.tail.then(async () => { if (this.current(token)) await operation(); }).catch(error => { if (this.current(token)) this.fail(error); });
    return this.tail;
  }
  private async optionalRuntime(operation: () => Promise<void>, message: string): Promise<void> { try { await operation(); } catch (error) { this.runtimePrepared = false; this.reportUnavailable(`${message}：${toUserErrorMessage(error)}`); } }
  private async prepareRuntime(itemId: string, positionMs: number, reuseSession: boolean, token: number): Promise<void> {
    const abort = new AbortController(); this.runtimePreparation = abort;
    try {
      await optionalOutputReady(this.dependencies.prepare(itemId, positionMs, { reuseSession,
        mtcOutputEnabled: Boolean(this.native?.mtcPortName && !this.native.mtcError), signal: abort.signal }), () => {
        abort.abort();
        void this.dependencies.stop().catch(error => { if (this.current(token)) this.reportUnavailable(`取消联动准备失败：${toUserErrorMessage(error)}`); });
      }, 'MIDI Cue');
      this.runtimePrepared = this.current(token) && !abort.signal.aborted;
    } catch (error) { if (this.current(token)) this.reportUnavailable(`MIDI Cue 没有发出，音频照常播放。原因：${toUserErrorMessage(error)}`); }
    finally { if (this.runtimePreparation === abort) this.runtimePreparation = null; }
  }
  private cancelScheduled(cancelObsPreparation = true): void {
    this.runtimePreparation?.abort();
    if (cancelObsPreparation && this.obsPreparing) void this.stopObs().catch((error: unknown) => this.pictureNotStopped(error, '取消画面准备失败'));
    this.finishing = false; this.lastPosition = -1; this.pendingPosition = null; this.volumePending = null; this.reflectGain = false;
  }
  private fail(error: unknown): void { ++this.epoch; this.cancelScheduled(); this.update({ status: 'error', error: toUserErrorMessage(error), errorTitle: this.state.status === 'preparing' ? '没有开始播放：准备失败' : '播放操作失败' }); if (this.native?.status !== 'error' && this.native?.status !== 'stopped') void this.command({ kind: 'stop' }).catch(cleanup => this.reportUnavailable(`停止音频失败：${toUserErrorMessage(cleanup)}`)); void this.dependencies.stop().catch(cleanup => this.reportUnavailable(`停止联动失败：${toUserErrorMessage(cleanup)}`)); }
  private boundary(event: PlaybackBoundary): void { for (const listener of this.boundaries) listener(event); }
  private items() { return playlistItems(this.project, this.state.playlistId ?? 'all').filter(item => item.enabled && item.referenceAudio); }
  private markPlayed(): void { if (this.state.itemId) this.update({ playedItemIds: [...new Set([...this.state.playedItemIds, this.state.itemId])] }); }
  private current(token: number): boolean { return !this.disposed && token === this.epoch; }
  private update(patch: Partial<InternalPlayerState>): void { if (this.disposed) return; this.state = { ...this.state, ...patch }; this.dependencies.changed(this.state); }
}

function clampVolume(volume: number): number { return Math.max(0, Math.min(100, volume)); }

/** The action MIDI did not close as the program closed (2026-11-11): what happened, why, and what the operator does. */
function actionMidiLeftOpen(error: unknown): string {
  const reason = toUserErrorReason(error).replace(/[。.；;\s]+$/u, '') || '未知错误';
  return `关闭节目时动作 MIDI 没有正常关掉，之后的歌照常播放。原因：${reason}。如果之后的歌没有发出动作 MIDI，请检查 MIDI 接口和线。`;
}

