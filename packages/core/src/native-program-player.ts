import { createObsProgramSnapshot, itemNeedsObs } from './obs-program-snapshot';
import { lightingTimecodePlaybackNotice } from './lighting-playback';
import { playlistItems, programPlaylists } from './program-playlists';
import { toUserErrorMessage } from './link-user-error';
import type { LinkDesktopApi } from './link-desktop-contract';
import type { LinkProject, NativePlayerControl, NativePlayerStatus, NativeObsPrepare, NativeObsStop, NativeObsStatus } from '@tb/schema';
import { nativeAudioAnalysis } from './native-audio-analysis';
import type { PlaybackBoundary, PlaybackClock } from './program-player';
import { emptyInternalPlayerState, type InternalPlayerDependencies, type InternalPlayerState } from './program-player';
import type { ProgramLightingOutput } from './program-player';
import { nativeProgramSnapshot } from './native-program-snapshot';
import { optionalOutputReady } from './optional-output-ready';

type NativeApi = Pick<LinkDesktopApi, 'prepareNativePlayback' | 'controlNativePlayback' | 'getNativePlaybackDevices' | 'onNativePlaybackStatus' | 'prepareNativeObs' | 'stopNativeObs' | 'onNativeObsStatus' | 'preloadNativeObs' | 'cancelNativeObsPreload'>;
type NativeAction = NativePlayerControl extends infer T ? T extends NativePlayerControl ? Omit<T, 'version' | 'sessionId' | 'generation'> : never : never;

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
  private lightingPrepared = false;
  private finishing = false;
  private allowMtc = false;
  private mtcSuppressed = false;
  private allowLighting = false;
  private loopStart: number | null = null;
  private reflectGain = false;
  private ingestPending = false;
  private pendingPosition: number | null = null;
  private lastPosition = -1;
  private readonly boundaries = new Set<(event: PlaybackBoundary) => void>();
  private readonly unsubscribe: () => void;
  private readonly analysis = nativeAudioAnalysis(() => this.native);
  private volumePending: { volume: number; durationMs: number } | null = null;
  private sendingVolume = false;
  private preloadGeneration = 0;
  private selectedPreload: { request: NativeObsStop; itemId: string } | null = null;

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
    if (this.disposed || !this.projectPath || this.project.obsOutputMode !== 'scenes' || ['preparing', 'playing', 'paused'].includes(this.state.status)
      || this.dependencies.configuration().preload === false || this.selectedPreload?.itemId === itemId) return;
    try {
      const prepared = nativeProgramSnapshot(this.project, itemId, this.revision, undefined, this.dependencies.configuration().audioSampleRate ?? 48000);
      const request: NativeObsStop = { version: 1, sessionId: this.sessionId, generation: ++this.preloadGeneration };
      const selection = { request, itemId }; this.selectedPreload = selection;
      void this.api.preloadNativeObs({ ...request, projectPath: this.projectPath, positionMs: prepared.snapshot.positionMs,
        preciseSeeking: this.dependencies.preciseSeeking?.() ?? false, snapshot: createObsProgramSnapshot(this.project, itemId, this.revision) })
        .catch(error => { if (!this.disposed && this.selectedPreload === selection) this.reportUnavailable(`节目画面预备未完成：${toUserErrorMessage(error)}`); });
    } catch (error) { this.reportUnavailable(`节目画面无法预备：${toUserErrorMessage(error)}`); }
  }
  private async cancelPreload(): Promise<void> {
    const selection = this.selectedPreload; this.selectedPreload = null;
    if (selection) await this.api.cancelNativeObsPreload(selection.request);
  }

  play(itemId: string, positionMs?: number, paused = false): Promise<void> {
    const config = this.dependencies.configuration(), token = ++this.epoch;
    this.mtcSuppressed = !this.state.mtcEnabled;
    const reuseSession = itemId === this.state.itemId && ['playing', 'paused'].includes(this.state.status);
    if (this.state.itemId !== itemId && this.state.status === 'playing') this.markPlayed();
    this.cancelScheduled(); this.runtimePrepared = false; this.boundary('seek');
    this.update({ status: 'preparing', itemId, error: null, errorTitle: null, notice: null, fault: null, mtcConnectionFailed: false });
    return this.enqueue(token, async () => {
      if (!this.projectPath) throw new Error('请先保存工程，再播放正式音频');
      // An engine in error has exited and rejects every command; prepare replaces it.
      if (this.native && this.native.status !== 'stopped' && this.native.status !== 'ended' && this.native.status !== 'error') await this.command({ kind: 'stop' });
      await this.optionalRuntime(() => this.stopObs(), '上次画面清理失败');
      await this.optionalRuntime(() => this.dependencies.stop(), '上次联动清理失败');
      if (!this.current(token)) return;
      const prepared = nativeProgramSnapshot(this.project, itemId, this.revision, positionMs, config.audioSampleRate ?? 48000);
      const item = this.project.rundown.find(entry => entry.id === itemId)!;
      this.allowMtc = prepared.allowMtc;
      this.allowLighting = prepared.allowLighting;
      if (prepared.notice) this.reportUnavailable(prepared.notice);
      const direct = item.lighting?.outputMode === 'network' || item.lighting?.outputMode === 'direct';
      const sendMtc = prepared.allowMtc && !direct && this.state.mtcEnabled;
      const midiPortName = sendMtc ? config.mtcPortName : null;
      const snapshot = { ...prepared.snapshot, volume: config.fadeInMs && !paused ? 0 : prepared.snapshot.volume };
      const loop = item.lighting?.loop;
      this.loopStart = loop?.enabled && loop.startMs < loop.endMs && loop.startMs >= snapshot.startMs && loop.endMs <= snapshot.endMs && snapshot.positionMs < loop.endMs ? loop.startMs : null;
      if (this.loopStart !== null && loop) snapshot.endMs = loop.endMs;
      this.update({ positionMs: snapshot.positionMs, durationMs: snapshot.endMs, volume: prepared.snapshot.volume * 100,
        endAction: item.playback?.endAction ?? this.state.endAction, mtcPositionMs: prepared.allowMtc ? snapshot.positionMs + snapshot.offsetMs : null });
      let nextSnapshot: ReturnType<typeof nativeProgramSnapshot>['snapshot'] | undefined;
      if (config.preload !== false) {
        const items = this.items();
        const next = this.loopStart !== null || this.state.endAction === 'loop' ? item
          : this.state.endAction === 'next' ? items[items.findIndex(entry => entry.id === itemId) + 1] : undefined;
        if (next) try {
          nextSnapshot = nativeProgramSnapshot(this.project, next.id, this.revision,
            this.loopStart ?? undefined, config.audioSampleRate ?? 48000).snapshot;
        } catch (error) { this.reportUnavailable(`下一节目无法提前准备：${toUserErrorMessage(error)}`); }
      }
      this.requestedPreparation = true;
      const result = await this.api.prepareNativePlayback({ version: 1, sessionId: this.sessionId, generation: ++this.nativeGeneration,
        projectPath: this.projectPath, snapshot, ...(nextSnapshot ? { nextSnapshot } : {}), audioDeviceId: config.outputDeviceId, midiPortName,
        autoDetectMtc: sendMtc && !midiPortName && Boolean(item.p1Media || item.lighting) });
      this.receive(result);
      if (!this.current(token)) { await this.command({ kind: 'stop' }); return; }
      if (this.mtcSuppressed && result.mtcPortName) await this.command({ kind: 'stop-mtc' });
      if (!this.current(token)) return;
      const prepareLighting = async (): Promise<void> => { if (item.lighting && prepared.allowLighting) {
        try { await optionalOutputReady(this.lighting.prepare(item.lighting, config.lightingProfile ?? null, snapshot.positionMs), () => this.lighting.stop(), '灯光动作'); this.lightingPrepared = this.current(token); }
        catch (error) { this.lighting.stop(); if (this.current(token)) this.reportUnavailable(`灯光动作未参与：${toUserErrorMessage(error)}`); }
      } };
      if (!this.current(token)) return;
      const notice = item.lighting && prepared.allowLighting && sendMtc && midiPortName && !this.state.mtcConnectionFailed ? lightingTimecodePlaybackNotice(item.lighting) : null;
      if (notice) this.reportUnavailable(notice);
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
    const token = ++this.epoch;
    return this.enqueue(token, async () => {
      const position = this.native!.positionMs;
      if (!this.current(token)) return;
      const item = this.project.rundown.find(entry => entry.id === this.state.itemId);
      const prepareLighting = async (): Promise<void> => { if (item?.lighting && this.allowLighting) {
        try { await optionalOutputReady(this.lighting.prepare(item.lighting, this.dependencies.configuration().lightingProfile ?? null, position), () => this.lighting.stop(), '灯光动作'); this.lightingPrepared = this.current(token); }
        catch (error) { this.reportUnavailable(`灯光动作未恢复：${toUserErrorMessage(error)}`); }
      } };
      // Pause cancels unsent MIDI and releases owned notes. Prepare the future
      // range before resuming audio; late preparation cannot join mid-song.
      await Promise.all([prepareLighting(), this.prepareRuntime(this.state.itemId!, position, true, token)]);
      if (!this.current(token)) return;
      await this.command({ kind: 'play' }); if (!this.current(token)) return;
      this.startCompanionClock();
      this.update({ status: 'playing' }); this.consumeClock();
    });
  }
  stop(): Promise<void> {
    const token = ++this.epoch; this.cancelScheduled(); this.update({ status: 'stopped', notice: null, fault: null });
    // Stop reaches the main service immediately if preparation has already
    // published its session; otherwise the queued prepare cannot start audio.
    const stopping = (this.requestedPreparation ? this.command({ kind: 'stop' }) : Promise.resolve()).catch(error => { if (this.current(token)) this.fail(error); });
    return this.enqueue(token, async () => { await stopping; if (this.lighting.release) await this.optionalRuntime(() => this.lighting.release!(), '灯光关闭未完成'); await this.optionalRuntime(() => this.cancelPreload(), '节目预备清理失败'); await this.optionalRuntime(() => this.stopObs(), '画面清理失败'); await this.dependencies.stop(); this.runtimePrepared = false;
      if (this.current(token)) { this.boundary('pause'); this.update({ positionMs: 0, mtcSentPositionMs: null }); } });
  }
  async reset(): Promise<void> { await this.stop(); if (this.state.status !== 'error') this.update({ itemId: null, playedItemIds: [], durationMs: 0 }); }
  externalStop(): void { void this.stop(); }
  freeze(message: string): void { void this.stop().then(() => this.update({ status: 'error', error: message, errorTitle: '播放已中断' })); }
  runtimeUnavailable(message: string): void { this.runtimePrepared = false; this.reportUnavailable(message); }
  reportUnavailable(message: string): void {
    if (this.state.notice?.includes(message)) return;
    this.dependencies.notice?.(message, this.state.itemId);
    this.update({ notice: [this.state.notice, message].filter(Boolean).join('；') });
  }
  seek(positionMs: number): Promise<void> { return this.state.itemId ? this.play(this.state.itemId, positionMs, this.state.status === 'paused') : Promise.resolve(); }
  scrub(itemId: string, positionMs: number): Promise<void> {
    if (this.state.status === 'error') return Promise.resolve();
    if (itemId !== this.state.itemId || !['playing', 'paused'].includes(this.state.status)) return this.play(itemId, positionMs, true);
    const token = ++this.epoch; this.cancelScheduled(); this.boundary('seek');
    return this.enqueue(token, async () => {
      await this.command({ kind: 'seek', positionMs }); if (!this.current(token)) return;
      await this.optionalRuntime(() => this.stopObs(), '定位时画面清理失败'); if (!this.current(token)) return;
      await this.prepareObs(itemId, token); if (!this.current(token)) return;
      this.update({ status: 'paused', positionMs: this.native!.positionMs });
      if (this.runtimePrepared && this.dependencies.scrub) await this.optionalRuntime(() => this.dependencies.scrub!(positionMs), '联动定位失败');
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
    else if (this.state.mtcEnabled) this.reportUnavailable('下次明确播放时重新准备时间码，本首不在中途补发。');
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
    const cleanup = [
      () => this.cancelScheduled(false),
      () => this.requestedPreparation && this.native?.status !== 'error' ? this.command({ kind: 'stop' }) : undefined,
      () => this.cancelPreload(), () => this.stopObs(), () => this.dependencies.stop(),
      () => this.lighting.close?.(),
      () => this.tail
    ];
    this.closing = Promise.allSettled(cleanup.map(operation => Promise.resolve().then(operation))).then(results => {
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
      if (failures.length) throw new AggregateError(failures, failures.map(toUserErrorMessage).join('；'));
    });
    return this.closing;
  }

  private receive(status: NativePlayerStatus): void {
    if (this.disposed || status.sessionId !== this.sessionId || status.generation !== this.nativeGeneration) return;
    this.native = status;
    if (status.mtcError) this.reportUnavailable(`时间码未参与：${status.mtcError}；音频继续播放。`);
    this.update({ mtcConnectionFailed: Boolean(status.mtcError), mtcPortName: status.mtcError ? null : status.mtcPortName,
      mtcSentPositionMs: status.mtcPortName && !status.mtcError && status.mtcSent ? status.offsetMs + status.positionMs : null });
    if (status.audioError || status.status === 'error') { if (this.state.status !== 'error') this.fail(new Error(status.audioError ?? '原生音频服务失效')); return; }
    if (this.state.status === 'playing') this.consumeClock();
  }
  private receiveObs(status: NativeObsStatus): void {
    if (this.disposed || !this.obsSession || status.sessionId !== this.obsSession.sessionId
      || status.generation < this.obsSession.generation || status.itemId !== this.state.itemId) return;
    this.dependencies.obsChanged?.(status);
    if (status.notice) this.reportUnavailable(status.notice);
    if (status.state === 'failed' || status.state === 'stopped' && status.reason) this.reportUnavailable(`画面通道未参与或已停止：${status.reason ?? '未知错误'}；音频继续播放。`);
    const fault = status.state === 'failed' ? `画面通道已停止：${status.reason ?? '未知错误'}` : status.fault;
    if (fault && fault !== this.state.fault && ['playing', 'paused'].includes(this.state.status)) this.update({ fault });
  }
  private async prepareObs(itemId: string, token: number): Promise<void> {
    if (!this.current(token) || !this.native) return;
    const envelope: NativeObsStop = { version: 1, sessionId: this.sessionId, generation: this.nativeGeneration };
    try {
      const snapshot = createObsProgramSnapshot(this.project, itemId, this.revision);
      const nextFiles = this.nextObsFiles(itemId);
      this.obsSession = envelope; this.obsPreparing = true;
      const status = await optionalOutputReady(this.api.prepareNativeObs({ ...envelope, projectPath: this.projectPath,
        preciseSeeking: this.dependencies.preciseSeeking?.() ?? false, snapshot, ...(nextFiles ? { nextFiles } : {}) }),
      () => { void this.stopObs().catch(error => this.reportUnavailable(`取消画面准备失败：${toUserErrorMessage(error)}`)); }, '后台画面');
      if (this.current(token) && this.obsSession === envelope) this.receiveObs(status);
      else await this.stopObs();
    } catch (error) {
      // Operator decision 2026-10-19: a song with picture work does not start without its picture.
      if (this.current(token) && itemNeedsObs(this.project, itemId)) throw new Error(`画面准备失败：${toUserErrorMessage(error)}`, { cause: error });
      if (this.current(token)) this.reportUnavailable(`画面未参与：${toUserErrorMessage(error)}；音频继续播放。`);
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
    } catch (error) { this.reportUnavailable(`下一节目文件预备未参与：${toUserErrorMessage(error)}`); return undefined; }
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
    if (this.lightingPrepared) try { this.lighting.tick(output.positionMs); } catch (error) { this.lightingPrepared = false; this.lighting.stop(); this.reportUnavailable(`灯光动作已停止：${toUserErrorMessage(error)}`); }
    if (this.runtimePrepared) { this.pendingPosition = output.positionMs; void this.ingest(); }
  }
  private startCompanionClock(): void {
    if (!this.runtimePrepared || !this.native) return;
    try { this.dependencies.started?.(this.native.positionMs); }
    catch (error) { this.runtimeUnavailable(`通用 MIDI Cue 未开始：${toUserErrorMessage(error)}；音频和后台画面独立运行。`); }
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
      if (this.lightingPrepared) {
        try { await this.lighting.finish(this.state.durationMs); }
        catch (error) {
          if (!this.current(token)) return;
          this.lightingPrepared = false; this.lighting.stop();
          this.reportUnavailable(`曲尾灯光未完成：${toUserErrorMessage(error)}；继续原定节目播放动作。`);
        }
      }
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
    } catch (error) { if (this.current(token)) this.reportUnavailable(`MIDI Cue 未参与：${toUserErrorMessage(error)}；音频继续播放。`); }
    finally { if (this.runtimePreparation === abort) this.runtimePreparation = null; }
  }
  private cancelScheduled(cancelObsPreparation = true): void {
    this.runtimePreparation?.abort();
    if (cancelObsPreparation && this.obsPreparing) void this.stopObs().catch(error => this.reportUnavailable(`取消画面准备失败：${toUserErrorMessage(error)}`));
    this.lighting.stop(); this.lightingPrepared = false; this.finishing = false; this.lastPosition = -1; this.pendingPosition = null; this.volumePending = null; this.reflectGain = false;
  }
  private fail(error: unknown): void { ++this.epoch; this.cancelScheduled(); this.update({ status: 'error', error: toUserErrorMessage(error), errorTitle: '播放操作失败' }); if (this.native?.status !== 'error' && this.native?.status !== 'stopped') void this.command({ kind: 'stop' }).catch(cleanup => this.reportUnavailable(`停止音频失败：${toUserErrorMessage(cleanup)}`)); void this.dependencies.stop().catch(cleanup => this.reportUnavailable(`停止联动失败：${toUserErrorMessage(cleanup)}`)); }
  private boundary(event: PlaybackBoundary): void { for (const listener of this.boundaries) listener(event); }
  private items() { return playlistItems(this.project, this.state.playlistId ?? 'all').filter(item => item.enabled && item.referenceAudio); }
  private markPlayed(): void { if (this.state.itemId) this.update({ playedItemIds: [...new Set([...this.state.playedItemIds, this.state.itemId])] }); }
  private current(token: number): boolean { return !this.disposed && token === this.epoch; }
  private update(patch: Partial<InternalPlayerState>): void { if (this.disposed) return; this.state = { ...this.state, ...patch }; this.dependencies.changed(this.state); }
}
