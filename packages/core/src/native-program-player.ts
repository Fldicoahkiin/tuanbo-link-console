import { createObsProgramSnapshot } from './obs-program-snapshot';
import { idleTimecodeOutput, timecodeOutputChange, type TimecodeOutputMemory } from './native-timecode-output';
import { playlistItems, programPlaylists } from './program-playlists';
import { toUserErrorMessage } from './link-user-error';
import type { LinkDesktopApi } from './link-desktop-contract';
import type { LinkProject, NativePlayerControl, NativePlayerStatus, NativeObsPrepare, NativeObsStop, NativeObsStatus } from '@tb/schema';
import { nativeAudioAnalysis } from './native-audio-analysis';
import type { PlaybackBoundary, PlaybackClock } from './program-player';
import { emptyInternalPlayerState, type InternalPlayerDependencies, type InternalPlayerState } from './program-player';
import type { ProgramLightingOutput } from './program-player';
import { nativeProgramSnapshot } from './native-program-snapshot';
import { programStart, type ProgramStart } from './program-start';
import { optionalOutputReady } from './optional-output-ready';

type NativeApi = Pick<LinkDesktopApi, 'prepareNativePlayback' | 'controlNativePlayback' | 'getNativePlaybackDevices' | 'onNativePlaybackStatus' | 'prepareNativeObs' | 'stopNativeObs' | 'onNativeObsStatus' | 'preloadNativeObs' | 'cancelNativeObsPreload'>;
type NativeAction = NativePlayerControl extends infer T ? T extends NativePlayerControl ? Omit<T, 'version' | 'sessionId' | 'generation'> : never : never;

const notCleanedUp = /画面没有清理干净[:：]\s*/gu;

/** Why a picture was not fully cleaned up, as the operator reads it: no code prefixes, and that it was not cleaned up is not repeated. */
export function pictureCleanupReason(error: unknown): string {
  return toUserErrorMessage(error).replace(notCleanedUp, '').replace(/[。.；;\s]+$/u, '') || '未知错误';
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
  private sendingVolume = false;
  private preloadGeneration = 0;
  private selectedPreload: { request: NativeObsStop; itemId: string } | null = null;
  /** A stop owes the song's Off until it went out once: from the queued stop, or from dispose when the player
   * closes before that stop ran (it waited behind a seek, scrub or resume). Never sent twice, never retried.
   * Whether a close sends an Off depends on this history: a later play does not settle the debt (what switching songs
   * does to the lights is the user's pending decision 4). After a stop skipped behind a seek, scrub or resume and then a
   * play, the next stop or close sends one Off with the plan LightingOutputRelease holds by then, the new song's
   * executors when it has lighting. The same close without such a skipped stop sends none. */
  private lightingOwed = false;
  /** The scrub still placing the song (its seek or its picture in flight). A pause or resume pressed meanwhile
   * waits for it, instead of cancelling the picture it prepares at the new position (2026-11-09). */
  private scrubbing: number | null = null;
  /** In red at this start: why the picture before it was not cleaned up, and the picture host's own fault as this
   * start's picture was prepared. Shown together, so neither replaces the other (2026-11-09). */
  private leftoverFault: string | null = null;
  private obsStartFault: string | null = null;

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
    this.leftoverFault = null; this.obsStartFault = null;
    this.update({ status: 'preparing', itemId, error: null, errorTitle: null, notice: null, fault: null, mtcConnectionFailed: false });
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
      this.allowMtc = prepared.allowMtc; this.picture = prepared.picture;
      const sendMtc = this.allowMtc && this.state.mtcEnabled;
      const midiPortName = sendMtc ? config.mtcPortName : null;
      const snapshot = { ...prepared.snapshot, volume: config.fadeInMs && !paused ? 0 : prepared.snapshot.volume };
      const loop = item.lighting?.loop;
      this.loopStart = loop?.enabled && loop.startMs < loop.endMs && loop.startMs >= snapshot.startMs && loop.endMs <= snapshot.endMs && snapshot.positionMs < loop.endMs ? loop.startMs : null;
      if (this.loopStart !== null && loop) snapshot.endMs = loop.endMs;
      this.update({ positionMs: snapshot.positionMs, durationMs: snapshot.endMs, volume: prepared.snapshot.volume * 100,
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
      // The console runs the lighting from the timecode; only the Off at stop is prepared here.
      const prepareLighting = async (): Promise<void> => { if (item.lighting) {
        try { await optionalOutputReady(this.lighting.prepare(item.lighting), () => this.lighting.cancelPreparation(), '停止时关灯'); }
        catch (error) { this.lighting.cancelPreparation(); if (this.current(token)) this.startFault(`停止时可能关不掉这首歌的执行器：${toUserErrorMessage(error)}`); }
      } };
      if (!this.current(token)) return;
      await Promise.all([prepareLighting(), this.prepareRuntime(itemId, snapshot.positionMs, reuseSession, token), this.prepareObs(itemId, token)]);
      if (!this.current(token)) return;
      if (paused) { await this.command({ kind: 'pause' }); if (this.runtimePrepared) await this.optionalRuntime(() => this.dependencies.pause(), 'MIDI Cue 暂停失败'); this.update({ status: 'paused' }); return; }
      if (config.fadeInMs) await this.command({ kind: 'volume', volume: prepared.snapshot.volume, durationMs: config.fadeInMs });
      if (!this.current(token)) return;
      await this.command({ kind: 'play' });
      if (!this.current(token)) return;
      this.startCompanionClock();
      this.update({ status: 'playing' }); this.consumeClock();
    });
  }

  pause(): Promise<void> {
    if (this.state.status !== 'playing') return Promise.resolve();
    // A scrub still placing the song leaves it paused there, with the picture it prepares for that position.
    if (this.scrubbing === this.epoch) return this.tail;
    const token = ++this.epoch; this.cancelScheduled();
    return this.enqueue(token, async () => {
      await this.command({ kind: 'pause' }); if (!this.current(token)) return;
      this.boundary('pause'); this.update({ status: 'paused', positionMs: this.native!.positionMs });
      if (this.runtimePrepared) await this.optionalRuntime(() => this.dependencies.pause(), '联动暂停失败');
    });
  }
  resume(): Promise<void> {
    if (this.state.status !== 'paused' || !this.state.itemId) return Promise.resolve();
    if ((this.native?.positionMs ?? 0) >= this.state.durationMs) return this.play(this.state.itemId);
    // Pressed while a scrub is still placing the song: it plays on from there once placed, with the picture the scrub
    // prepares, instead of cancelling that picture and playing the rest of the song without it (2026-11-09).
    const token = this.scrubbing === this.epoch ? this.epoch : ++this.epoch;
    return this.enqueue(token, async () => {
      // Pressed twice while the scrub ran: the first one plays on.
      if (this.state.status !== 'paused') return;
      const position = this.native!.positionMs;
      if (!this.current(token)) return;
      // Pause cancels unsent MIDI and releases owned notes. Prepare the future
      // range before resuming audio; late preparation cannot join mid-song.
      await this.prepareRuntime(this.state.itemId!, position, true, token);
      if (!this.current(token)) return;
      await this.command({ kind: 'play' }); if (!this.current(token)) return;
      this.startCompanionClock();
      this.update({ status: 'playing' }); this.consumeClock();
    });
  }
  stop(): Promise<void> {
    const token = ++this.epoch; this.cancelScheduled(); this.update({ status: 'stopped', notice: null, fault: null });
    this.lightingOwed = true;
    // Stop reaches the main service immediately if preparation has already
    // published its session; otherwise the queued prepare cannot start audio.
    const stopping = (this.requestedPreparation ? this.command({ kind: 'stop' }) : Promise.resolve()).catch(error => { if (this.current(token)) this.fail(error); });
    return this.enqueue(token, async () => { await stopping; await this.releaseLighting(); await this.optionalRuntime(() => this.cancelPreload(), '节目准备没清理干净');
      await this.stopObs().catch((error: unknown) => this.pictureNotStopped(error, '画面清理失败')); await this.dependencies.stop(); this.runtimePrepared = false;
      if (this.current(token)) { this.boundary('pause'); this.update({ positionMs: 0, mtcSentPositionMs: null }); } });
  }
  /** The Off a stop owes, sent once after the timecode stopped; nothing retries it. A failure is shown in the player
   * and logged. Once the player has closed no window shows its state any more, so the failure goes to the host
   * (closedFault): in the window in red, and into the log as an error. */
  private async releaseLighting(): Promise<void> {
    if (!this.lightingOwed) return;
    this.lightingOwed = false;
    const itemId = this.state.itemId;
    try { await this.lighting.release(); }
    catch (error) {
      if (!this.disposed) { this.runtimePrepared = false; this.reportUnavailable(`灯光没能完全关闭：${toUserErrorMessage(error)}`); return; }
      const title = this.project.rundown.find(item => item.id === itemId)?.title;
      this.dependencies.closedFault(`${title ? `「${title}」` : '这首歌'}的灯光没能完全关闭，控台上可能还亮着，请在控台上关掉这首歌的执行器。原因：${toUserErrorMessage(error)}`, itemId);
    }
  }
  async reset(): Promise<void> { await this.stop(); if (this.state.status !== 'error') this.update({ itemId: null, playedItemIds: [], durationMs: 0 }); }
  externalStop(): void { void this.stop(); }
  freeze(message: string): void { void this.stop().then(() => this.update({ status: 'error', error: message, errorTitle: '播放已中断' })); }
  runtimeUnavailable(message: string): void { this.runtimePrepared = false; this.reportUnavailable(message); }
  /** A live output failure: shown in red; audio and the remaining actions continue. */
  reportFault(message: string): void { if (['preparing', 'playing', 'paused'].includes(this.state.status) && this.state.fault !== message) this.update({ fault: message }); }
  /** The output behind this red message is back: clear it if it is still the one shown. */
  clearFault(message: string): void { if (this.state.fault === message) this.update({ fault: null }); }
  /** An output that could not join or left this song: logged and shown in red, audio continues. */
  private startFault(message: string): void { this.dependencies.notice?.(message, this.state.itemId); this.reportFault(message); }
  reportUnavailable(message: string): void {
    if (this.state.notice?.includes(message)) return;
    this.dependencies.notice?.(message, this.state.itemId);
    this.showNotice(message);
  }
  private showNotice(message: string): void {
    if (!this.state.notice?.includes(message)) this.update({ notice: [this.state.notice, message].filter(Boolean).join('；') });
  }
  /** Every stop of a picture this program prepared ends here when it fails, but the one at closing, which hands a failed
   * cleanup back itself. A failed cleanup was logged where it ran (2026-11-09): it is shown in red on the song on stage,
   * which plays on, else on the stopped player; one heard after closing is handed back to the picture host for the next
   * song. Any other failure to stop it is shown and logged here. */
  private pictureNotStopped(error: unknown, doing: string): void {
    if (!(error instanceof ObsPictureLeftover)) this.reportUnavailable(`${doing}：${toUserErrorMessage(error)}`);
    else if (this.disposed) error.handBack();
    else if (this.state.itemId && ['preparing', 'playing', 'paused'].includes(this.state.status)) this.showLeftover(error.next(this.state.itemId));
    else this.showNotice(`画面清理失败：${error.message}`);
  }
  /** Joins the picture host's fault already shown for this start, which repeats it with each status. */
  private showLeftover(message: string): void {
    this.leftoverFault = message;
    this.reportFault(this.obsStartFault && this.state.fault === this.obsStartFault ? `${message}；${this.obsStartFault}` : message);
  }
  seek(positionMs: number): Promise<void> { return this.state.itemId ? this.play(this.state.itemId, positionMs, this.state.status === 'paused') : Promise.resolve(); }
  scrub(itemId: string, positionMs: number): Promise<void> {
    if (this.state.status === 'error') return Promise.resolve();
    if (itemId !== this.state.itemId || !['playing', 'paused'].includes(this.state.status)) return this.play(itemId, positionMs, true);
    const token = ++this.epoch; this.scrubbing = token; this.cancelScheduled(); this.boundary('seek');
    this.leftoverFault = null; this.obsStartFault = null;
    return this.enqueue(token, async () => {
      try {
        await this.command({ kind: 'seek', positionMs }); if (!this.current(token)) return;
        await this.stopObs().catch((error: unknown) => this.pictureNotStopped(error, '定位时画面清理失败')); if (!this.current(token)) return;
        await this.prepareObs(itemId, token); if (!this.current(token)) return;
        this.update({ status: 'paused', positionMs: this.native!.positionMs });
        if (this.runtimePrepared && this.dependencies.scrub) await this.optionalRuntime(() => this.dependencies.scrub!(positionMs), '联动定位失败');
      } finally { if (this.scrubbing === token) this.scrubbing = null; }
    });
  }
  skip(direction: -1 | 1): Promise<void> { const items = this.items(), index = items.findIndex(item => item.id === this.state.itemId); const next = items[(index + direction + items.length) % items.length]; return next ? this.play(next.id) : Promise.resolve(); }
  setEndAction(endAction: InternalPlayerState['endAction']): void { this.update({ endAction }); }
  setPlaylist(playlistId: string): void { this.update({ playlistId }); }
  toggle(): Promise<void> { if (this.state.status === 'playing') return this.pause(); if (this.state.status === 'paused') return this.resume(); const item = this.items().find(item => item.id === this.state.itemId) ?? this.items()[0]; return item ? this.play(item.id) : Promise.resolve(); }
  toggleMtc(): void {
    this.update({ mtcEnabled: !this.state.mtcEnabled });
    if (!this.state.mtcEnabled) this.mtcSuppressed = true;
    if (!this.state.mtcEnabled && this.native && !['preparing', 'stopped', 'error'].includes(this.native.status)) void this.command({ kind: 'stop-mtc' }).catch(error => this.reportUnavailable(`停止时间码失败：${toUserErrorMessage(error)}`));
    else if (this.state.mtcEnabled) this.reportUnavailable('下次播放时会重新准备时间码，这首歌不会中途补发。');
  }
  setVolume(volume: number): void { if (!Number.isFinite(volume)) return; this.reflectGain = false; const target = Math.max(0, Math.min(100, volume)); this.update({ volume: target }); this.queueVolume(target / 100, 0); }
  fade(out: boolean): void { const config = this.dependencies.configuration(), volume = this.project.rundown.find(item => item.id === this.state.itemId)?.playback?.volume ?? 100; this.reflectGain = true; this.queueVolume(out ? 0 : volume / 100, (out ? config.fadeOutMs : config.fadeInMs) ?? 500); }
  getAudioAnalysis() { return this.state.status === 'playing' ? this.analysis : null; }
  receiveMidi(bytes: Uint8Array): void {
    const [status, number, value] = bytes; if (status === undefined || number === undefined || number > 127) return;
    if ((status & 0xf0) === 0x90 && value !== undefined && value > 0 && value <= 127) {
      if (number === 1) void this.toggle(); else if (number === 2) void this.stop();
      else if (number >= 60) { const item = playlistItems(this.project, this.state.playlistId ?? 'all')[number - 60]; if (item?.enabled && item.referenceAudio) void this.play(item.id); }
    } else if ((status & 0xf0) === 0xb0 && number === 7 && value !== undefined && value <= 127) this.setVolume(value * 100 / 127);
    else if ((status & 0xf0) === 0xc0) { const list = programPlaylists(this.project)[number]; if (list) this.setPlaylist(list.id); }
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    ++this.epoch; this.disposed = true; this.unsubscribe(); this.boundaries.clear();
    const run = (operation: () => unknown): Promise<unknown> => Promise.resolve().then(operation);
    const scheduled = run(() => this.cancelScheduled(false));
    const audio = run(() => this.requestedPreparation && this.native?.status !== 'error' ? this.command({ kind: 'stop' }) : undefined);
    // A stop still queued here never runs; the Off it owes goes out once the timecode has stopped, as the stop would.
    const lighting = audio.then(() => this.releaseLighting(), () => this.releaseLighting());
    // A picture left on air was logged where its cleanup ran. A program that closes has nowhere to show it: it hands it
    // back, and the next song to start shows it. It must not keep the next program from opening or the app from quitting
    // (2026-11-09); any other failure still fails the close.
    const picture = run(() => this.stopObs()).catch((error: unknown) => { if (error instanceof ObsPictureLeftover) error.handBack(); else throw error; });
    const cleanup = [scheduled, audio, lighting, run(() => this.cancelPreload()), picture, run(() => this.dependencies.stop()), run(() => this.tail)];
    this.closing = Promise.allSettled(cleanup).then(results => {
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
      if (failures.length) throw new AggregateError(failures, failures.map(toUserErrorMessage).join('；'));
    });
    return this.closing;
  }

  private receive(status: NativePlayerStatus): void {
    if (this.disposed || status.sessionId !== this.sessionId || status.generation !== this.nativeGeneration) return;
    // Like P1, an interrupted timecode resumes with a full frame; the service logs it, nothing turns red.
    this.native = status;
    const timecode = timecodeOutputChange(this.timecodeOutput, status, this.state.fault); this.timecodeOutput = timecode.memory;
    if (timecode.fault) this.startFault(timecode.fault);
    if (timecode.clearFault) this.update({ fault: null });
    if (timecode.notice) this.reportUnavailable(timecode.notice);
    this.update({ mtcConnectionFailed: Boolean(status.mtcError), mtcPortName: status.mtcError ? null : status.mtcPortName,
      mtcSentPositionMs: status.mtcPortName && !status.mtcError && status.mtcSent ? status.offsetMs + status.positionMs : null });
    if (status.audioError || status.status === 'error') { if (this.state.status !== 'error') this.fail(new Error(status.audioError ?? '音频服务已失效，请重新播放')); return; }
    if (this.state.status === 'playing') this.consumeClock();
  }
  private receiveObs(status: NativeObsStatus): void {
    if (this.disposed || !this.obsSession || status.sessionId !== this.obsSession.sessionId
      || status.generation < this.obsSession.generation || status.itemId !== this.state.itemId) return;
    this.dependencies.obsChanged?.(status);
    if (status.notice) this.reportUnavailable(status.notice);
    if (status.state === 'failed' || status.state === 'stopped' && status.reason) this.reportUnavailable(`画面没有联动或已停止，音频照常播放。原因：${status.reason ?? '未知错误'}`);
    // A stopped picture channel is an output fault for a song with picture work; for one without, the notice above is all.
    const fault = status.state === 'failed' && this.picture === 'wait' ? `画面联动已停止：${status.reason ?? '未知错误'}` : status.fault;
    if (!fault) return;
    if (this.obsPreparing) this.obsStartFault = fault;
    // The host repeats its fault with each status; its fault for this start stays next to a failed cleanup shown there.
    this.reportFault(this.leftoverFault && fault === this.obsStartFault ? `${this.leftoverFault}；${fault}` : fault);
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
      const status = await (this.picture === 'wait' ? preparing : optionalOutputReady(preparing,
        () => { void this.stopObs().catch((error: unknown) => this.pictureNotStopped(error, '取消画面准备失败')); }, '后台画面'));
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
    this.lighting.cancelPreparation(); this.finishing = false; this.lastPosition = -1; this.pendingPosition = null; this.volumePending = null; this.reflectGain = false;
  }
  private fail(error: unknown): void { ++this.epoch; this.cancelScheduled(); this.update({ status: 'error', error: toUserErrorMessage(error), errorTitle: this.state.status === 'preparing' ? '没有开始播放：准备失败' : '播放操作失败' }); if (this.native?.status !== 'error' && this.native?.status !== 'stopped') void this.command({ kind: 'stop' }).catch(cleanup => this.reportUnavailable(`停止音频失败：${toUserErrorMessage(cleanup)}`)); void this.dependencies.stop().catch(cleanup => this.reportUnavailable(`停止联动失败：${toUserErrorMessage(cleanup)}`)); }
  private boundary(event: PlaybackBoundary): void { for (const listener of this.boundaries) listener(event); }
  private items() { return playlistItems(this.project, this.state.playlistId ?? 'all').filter(item => item.enabled && item.referenceAudio); }
  private markPlayed(): void { if (this.state.itemId) this.update({ playedItemIds: [...new Set([...this.state.playedItemIds, this.state.itemId])] }); }
  private current(token: number): boolean { return !this.disposed && token === this.epoch; }
  private update(patch: Partial<InternalPlayerState>): void { if (this.disposed) return; this.state = { ...this.state, ...patch }; this.dependencies.changed(this.state); }
}
