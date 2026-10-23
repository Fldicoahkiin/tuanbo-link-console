import { optionalOutputReady } from '@tb/core/link';
import { allocateMediaTimecodeRanges, itemNeedsObs, programTimeOrigin, lightingTimeOrigin, lightingTimecodePlaybackNotice, millisecondsToFrameNumber, playlistItems, programPlaylists, toUserErrorMessage } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import { MediaMtcOutput } from '../../registry/media-mtc-output';
import { LightingMidiOutput } from '../../registry/lighting-midi-output';
import { PreflightBlockedError } from './preflight-blocked-error';
import { InternalAudioOutput } from '../../registry/internal-audio-output';
import { mediaPlaybackClock } from '../../registry/playback-clock';

import { emptyInternalPlayerState, type InternalPlayerDependencies, type InternalPlayerState } from '@tb/core/link';
export { emptyInternalPlayerState, type InternalPlayerDependencies, type InternalPlayerState } from '@tb/core/link';

export class InternalPlaybackController {
  private state: InternalPlayerState = { ...emptyInternalPlayerState };
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private resuming: { generation: number; task: Promise<void> } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fadeTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrame = -1;
  private lastRendered = 0;
  private lastAdvanced = 0;
  private previousPosition = -1;
  private offsetMs = 0;
  private directLighting = false;
  private runtimePrepared = false;
  private lightingPrepared = false;
  private finishingLighting = false;
  private mtcSentPositionMs: number | null = null;
  private disposed = false;
  private loadedAudioUrl: string | null = null;
  private audibleMs = 0;
  private readonly lighting = new LightingMidiOutput(true);

  constructor(private readonly project: LinkProject, private readonly dependencies: InternalPlayerDependencies,
    private readonly audio: HTMLAudioElement = new Audio(), private readonly mtc = new MediaMtcOutput(),
    private readonly output: Pick<InternalAudioOutput, 'prepare' | 'captureMonitoringStream' | 'getAnalysis' | 'dispose' | 'latencyMs'> = new InternalAudioOutput()) {
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';
    audio.onended = () => this.finish();
    audio.onerror = () => this.fail(new Error(`音频解码或读取失败：${audio.error?.message ?? '未知错误'}`));
  }

  readonly clock = mediaPlaybackClock(() => this.audio);

  play(itemId: string, requestedPositionMs?: number, paused = false): Promise<void> {
    // Capture output settings once for this preparation. Device changes must not
    // destroy or silently re-route a song that has already begun preparing.
    const config = this.dependencies.configuration();
    const reuseSession = this.state.itemId === itemId && ['playing', 'paused'].includes(this.state.status);
    if (this.state.itemId && this.state.itemId !== itemId && ['playing', 'paused'].includes(this.state.status)) this.markPlayed();
    const generation = ++this.generation;
    this.silence(); this.runtimePrepared = false; this.lightingPrepared = false; this.update({ status: 'preparing', itemId, error: null, errorTitle: null, notice: null, fault: null, mtcConnectionFailed: false });
    const operation = this.tail.then(async () => {
      if (!this.current(generation)) return;
      try { await this.dependencies.stop('开始播放前结束上一会话'); }
      catch (error) { this.appendNotice(`上次联动清理失败：${toUserErrorMessage(error)}。本次仍尝试播放音频。`); }
      if (!this.current(generation)) return;
      const refusal = this.dependencies.refusal?.(); if (refusal) throw new Error(refusal);
      const item = this.project.rundown.find((candidate) => candidate.id === itemId && candidate.enabled);
      if (!item?.referenceAudio) throw new Error('节目没有可播放的音频');
      const durationMs = item.referenceAudio.durationMs;
      const startMs = item.playback?.startMs ?? 0;
      const endMs = item.playback?.endMs || durationMs;
      const positionMs = requestedPositionMs ?? startMs;
      if (startMs >= endMs || endMs > durationMs || !Number.isFinite(positionMs) || positionMs < startMs || positionMs >= endMs) throw new Error('播放位置或裁剪范围超出音频范围');
      const url = await this.dependencies.resolveAudio(item.referenceAudio.relativePath);
      if (!this.current(generation)) return;
      if (this.loadedAudioUrl !== url || this.audio.src !== url || this.audio.error) {
        this.loadedAudioUrl = null;
        this.audio.preload = config.preload === false ? 'metadata' : 'auto'; this.audio.src = url;
        await waitForAudio(this.audio);
        this.loadedAudioUrl = url;
      }
      if (!this.current(generation)) return;
      await this.output.prepare(this.audio, config.outputDeviceId, config.audioSampleRate ?? 48000);
      if (!this.current(generation)) return;
      this.directLighting = item.lighting?.outputMode === 'direct' || item.lighting?.outputMode === 'network';
      const sendMtc = !this.directLighting && this.state.mtcEnabled;
      let mtcPortName: string | null | undefined;
      const stalePairing = Object.values(this.project.ma2ReadState?.pairings ?? {}).some(pair => pair.itemId === item.id && pair.status === 'stale');
      const allowLighting = !stalePairing || this.directLighting;
      if (stalePairing && !this.directLighting) this.appendNotice('当前歌曲与控台时间线尚未核对，本次不发送时间码。请打开控台时间线核对关联；音频继续播放。');
      await Promise.all([
        (async () => {
          try {
            mtcPortName = await optionalOutputReady(this.mtc.connect(sendMtc && !stalePairing ? config.mtcPortName : null, sendMtc && !stalePairing && Boolean(item.p1Media || item.lighting?.ma2Bindings?.length || item.lighting?.tracks.some(track => track.clips.some(clip => clip.events.length)))), () => this.mtc.stop(), 'MIDI 时间码');
          } catch (error) {
            if (this.current(generation)) { this.mtc.stop(); this.update({ mtcConnectionFailed: true }); this.startFault(`MIDI 时间码未输出：${toUserErrorMessage(error)}。本次继续播放音频。`); }
          }
        })(),
        (async () => {
          if (!item.lighting || !allowLighting) return;
          try {
            await optionalOutputReady(this.lighting.prepare(item.lighting, config.lightingProfile ?? null, positionMs), () => this.lighting.stop(), '灯光动作');
            if (this.current(generation)) this.lightingPrepared = true;
          } catch (error) {
            if (this.current(generation)) { this.lighting.stop(); this.startFault(`灯光动作未启动：${toUserErrorMessage(error)}。本次继续播放音频。`); }
          }
        })()
      ]);
      if (!this.current(generation)) return;
      this.update({ mtcPortName: sendMtc ? mtcPortName ?? null : null, mtcSentPositionMs: null });
      const lightingNotice = item.lighting && allowLighting && sendMtc && mtcPortName ? lightingTimecodePlaybackNotice(item.lighting) : null;
      if (lightingNotice) this.update({ notice: [this.state.notice, lightingNotice].filter(Boolean).join('；') });
      if (!this.current(generation)) return;
      try { await this.dependencies.prepare(itemId, positionMs, { reuseSession, mtcOutputEnabled: sendMtc && Boolean(mtcPortName) }); this.runtimePrepared = true; }
      catch (error) {
        // Operator decision 2026-10-19: a song with picture work, or one its preflight
        // blocks, does not start when preparation fails. Audio-only songs still play.
        if (error instanceof PreflightBlockedError) throw error;
        if (itemNeedsObs(this.project, itemId)) throw new Error(`画面与联动准备失败：${toUserErrorMessage(error)}`, { cause: error });
        this.appendNotice(`画面与联动未启动：${toUserErrorMessage(error)}。本次继续播放音频。`);
      }
      if (!this.current(generation)) return;
      this.update({ volume: item.playback?.volume ?? 100, ...(item.playback?.endAction ? { endAction: item.playback.endAction } : {}) });
      this.audio.currentTime = positionMs / 1000; this.audio.volume = this.state.volume / 100;
      this.offsetMs = programTimeOrigin(item, this.project.obsOutputMode === 'scenes' ? 0 : (allocateMediaTimecodeRanges(this.project).find((range) => range.itemId === itemId)?.startSeconds ?? 0) * 1000);
      if (lightingTimeOrigin(item.lighting, this.offsetMs) !== this.offsetMs) {
        this.mtc.stop(); this.update({ mtcPortName: null });
        this.appendNotice('歌曲播放起点与 MA2 绑定时间码不一致，本次不输出时间码；音频继续播放。');
      }
      this.lastFrame = -1; this.previousPosition = -1; this.lastAdvanced = performance.now();
      this.update({ itemId, positionMs, mtcPositionMs: positionMs + this.offsetMs, durationMs: endMs });
      if (this.runtimePrepared) {
        try { await this.dependencies.ingest(positionMs); }
        catch (error) { this.disableRuntime(error); }
      }
      if (!this.current(generation)) return;
      if (paused) { if (this.runtimePrepared) await this.dependencies.pause('定位后保持暂停'); this.update({ status: 'paused' }); return; }
      if (config.fadeInMs) this.audio.volume = 0;
      this.audibleMs = this.audio.currentTime * 1000;
      await this.audio.play();
      if (!this.current(generation)) { this.silence(); return; }
      if (this.runtimePrepared) this.dependencies.started?.(this.audiblePosition(this.audio.currentTime * 1000));
      this.update({ status: 'playing', positionMs: this.audio.currentTime * 1000, mtcPositionMs: this.audio.currentTime * 1000 + this.offsetMs });
      this.lastAdvanced = performance.now();
      if (config.fadeInMs) this.ramp(0, this.state.volume / 100, config.fadeInMs, false);
      this.timer = setInterval(() => this.tick(), 8);
    });
    this.tail = operation.catch((error: unknown) => { if (this.current(generation)) this.fail(error); });
    return this.tail;
  }

  async pause(): Promise<void> {
    if (this.state.status !== 'playing' || this.finishingLighting) return;
    const generation = this.generation; this.silence();
    this.update({ status: 'paused', positionMs: this.audio.currentTime * 1000, mtcPositionMs: this.audio.currentTime * 1000 + this.offsetMs });
    if (this.runtimePrepared) try { await this.dependencies.pause(); } catch (error) { if (this.current(generation)) this.disableRuntime(error); }
  }

  resume(): Promise<void> {
    if (this.resuming?.generation === this.generation) return this.resuming.task;
    const generation = this.generation;
    const task = this.resumePlayback().finally(() => {
      if (this.resuming?.task === task) this.resuming = null;
    });
    this.resuming = { generation, task };
    return task;
  }

  private async resumePlayback(): Promise<void> {
    if (this.state.status !== 'paused') return;
    if (this.audio.currentTime * 1000 >= this.state.durationMs && this.state.itemId) { await this.play(this.state.itemId); return; }
    const generation = this.generation;
    try {
      if (this.runtimePrepared) try { await this.dependencies.ingest(this.audio.currentTime * 1000); }
      catch (error) { if (!this.current(generation)) return; this.disableRuntime(error); }
      if (!this.current(generation)) return;
      const lighting = this.project.rundown.find((item) => item.id === this.state.itemId)?.lighting;
      if (lighting && this.lightingPrepared) try { await this.lighting.prepare(lighting, this.dependencies.configuration().lightingProfile ?? null, this.audio.currentTime * 1000); }
      catch (error) { if (!this.current(generation)) return; this.lightingPrepared = false; this.lighting.stop(); this.appendNotice(`灯光动作已停止：${toUserErrorMessage(error)}`); }
      if (!this.current(generation)) return;
      this.audio.volume = this.state.volume / 100; this.audibleMs = this.audio.currentTime * 1000; await this.audio.play();
      if (!this.current(generation)) return;
      this.lastAdvanced = performance.now();
      if (this.runtimePrepared) this.dependencies.started?.(this.audiblePosition(this.audio.currentTime * 1000));
      this.update({ status: 'playing' }); this.timer = setInterval(() => this.tick(), 8);
    } catch (error) { if (this.current(generation)) this.fail(error); }
  }

  async stop(reason?: string): Promise<void> {
    const generation = ++this.generation; this.silence(); this.update({ status: 'stopped', positionMs: 0, notice: null, fault: null });
    // Publish cleanup to the same queue before another Play can start preparing OBS.
    const operation = this.tail.then(async () => {
      const [runtime, lighting] = await Promise.allSettled([this.dependencies.stop(reason), this.lighting.release()]);
      if (lighting.status === 'rejected' && this.current(generation)) this.appendNotice(`灯光关闭未完成：${toUserErrorMessage(lighting.reason)}`);
      if (runtime.status === 'rejected') throw runtime.reason;
    });
    this.tail = operation.catch((error: unknown) => { if (this.current(generation)) this.fail(error); });
    await this.tail;
  }
  async reset(): Promise<void> { await this.stop(); if (this.state.status !== 'error') this.update({ itemId: null, playedItemIds: [], durationMs: 0 }); }

  externalStop(): void { ++this.generation; this.silence(); this.update({ status: 'stopped', positionMs: 0, notice: null, fault: null }); }
  freeze(message: string): void {
    ++this.generation; this.silence(); this.update({ status: 'error', error: message, errorTitle: '播放已中断' });
    this.dependencies.failed?.(`播放已中断：${message}`, this.state.itemId);
  }
  reportUnavailable(message: string): void { this.appendNotice(message); }
  reportPreparation(message: string): void { if (this.state.status === 'preparing') this.update({ preparation: message }); }
  /** A live output failure: shown in red; audio and the remaining actions continue. */
  reportFault(message: string): void { if (['preparing', 'playing', 'paused'].includes(this.state.status) && this.state.fault !== message) this.update({ fault: message }); }
  runtimeUnavailable(message: string): void { this.disableRuntime(new Error(message)); }
  seek(positionMs: number): Promise<void> {
    if (!this.state.itemId) return Promise.resolve();
    return this.play(this.state.itemId, positionMs, this.state.status === 'paused');
  }
  scrub(itemId: string, positionMs: number): Promise<void> {
    // Pointer movement must not retry a failed OBS/audio preparation.
    // A deliberate Play starts a new preparation and clears the error.
    if (this.state.status === 'error') return Promise.resolve();
    const item = this.project.rundown.find((entry) => entry.id === itemId);
    if (!Number.isFinite(positionMs) || positionMs < (item?.playback?.startMs ?? 0) || positionMs >= (item?.playback?.endMs || item?.referenceAudio?.durationMs || 0)) return Promise.reject(new Error('定位位置超出节目范围'));
    if (!this.runtimePrepared && this.state.itemId === itemId && ['playing', 'paused'].includes(this.state.status)) {
      // Scrubbing must stop the old output clock even when OBS was unavailable.
      // Resuming starts MTC at the selected position instead of treating it as a jump.
      ++this.generation; this.silence();
      this.audio.currentTime = positionMs / 1000;
      this.lastFrame = -1; this.previousPosition = -1;
      this.update({ status: 'paused', positionMs, mtcPositionMs: positionMs + this.offsetMs });
      return Promise.resolve();
    }
    if (!this.dependencies.scrub || this.state.itemId !== itemId || !['playing', 'paused'].includes(this.state.status)) return this.play(itemId, positionMs, true);
    if (this.state.status === 'paused' && this.state.positionMs === positionMs) return this.tail;
    const generation = ++this.generation;
    this.silence(); this.update({ status: 'paused', positionMs });
    const operation = this.tail.then(async () => {
      if (!this.current(generation)) return;
      await this.dependencies.scrub!(positionMs);
      if (!this.current(generation)) return;
      this.audio.currentTime = positionMs / 1000;
      this.lastFrame = -1; this.previousPosition = -1;
      this.update({ positionMs, mtcPositionMs: positionMs + this.offsetMs });
    });
    this.tail = operation.catch((error: unknown) => { if (this.current(generation)) this.fail(error); });
    return this.tail;
  }
  skip(direction: -1 | 1): Promise<void> {
    const items = playlistItems(this.project, this.state.playlistId ?? 'all').filter((item) => item.enabled && item.referenceAudio);
    const index = items.findIndex((item) => item.id === this.state.itemId);
    const item = items[(index + direction + items.length) % items.length];
    return item ? this.play(item.id) : Promise.resolve();
  }
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    if (this.fadeTimer) clearInterval(this.fadeTimer); this.fadeTimer = null;
    this.audio.volume = Math.max(0, Math.min(100, volume)) / 100; this.update({ volume: this.audio.volume * 100 });
  }
  setEndAction(endAction: InternalPlayerState['endAction']): void { this.update({ endAction }); }
  setPlaylist(playlistId: string): void { this.update({ playlistId }); }
  toggleMtc(): void {
    this.mtc.stop(); this.mtcSentPositionMs = null;
    this.update({ mtcEnabled: !this.state.mtcEnabled, mtcSentPositionMs: null, mtcPortName: null });
    if (this.state.mtcEnabled && !this.directLighting && !this.state.mtcPortName && ['playing', 'paused'].includes(this.state.status)) this.appendNotice('时间码输出尚未连接，本次继续播放音频；重新播放时会再次检测。');
  }
  toggle(): Promise<void> {
    if (this.state.status === 'playing') return this.pause();
    if (this.state.status === 'paused') return this.resume();
    const items = playlistItems(this.project, this.state.playlistId ?? 'all').filter((item) => item.enabled && item.referenceAudio);
    const item = items.find((entry) => entry.id === this.state.itemId) ?? items[0];
    return item ? this.play(item.id) : Promise.resolve();
  }
  receiveMidi(bytes: Uint8Array): void {
    const status = bytes[0]; const number = bytes[1]; const value = bytes[2];
    if (status === undefined || number === undefined || number > 127) return;
    if ((status & 0xf0) === 0x90 && value !== undefined && value > 0 && value <= 127) {
      if (number === 1) void this.toggle();
      else if (number === 2) void this.stop();
      else if (number >= 60) {
        const item = playlistItems(this.project, this.state.playlistId ?? 'all')[number - 60];
        if (item?.enabled && item.referenceAudio) void this.play(item.id);
      }
    } else if ((status & 0xf0) === 0xb0 && number === 7 && value !== undefined && value <= 127) this.setVolume(value * 100 / 127);
    else if ((status & 0xf0) === 0xc0) {
      const list = programPlaylists(this.project)[number]; if (list) this.setPlaylist(list.id);
    }
  }
  captureMonitoringStream(): MediaStream | null {
    return this.state.status === 'playing' ? this.output.captureMonitoringStream() : null;
  }
  getAudioAnalysis(): ReturnType<InternalAudioOutput['getAnalysis']> { return this.state.status === 'playing' ? this.output.getAnalysis() : null; }
  fade(out: boolean): void {
    const duration = out ? this.dependencies.configuration().fadeOutMs ?? 500 : this.dependencies.configuration().fadeInMs ?? 500;
    const itemVolume = this.project.rundown.find((item) => item.id === this.state.itemId)?.playback?.volume ?? 100;
    this.ramp(this.audio.volume, out ? 0 : itemVolume / 100, duration, true);
  }
  private ramp(from: number, to: number, duration: number, reflectVolume: boolean): void {
    if (this.fadeTimer) clearInterval(this.fadeTimer);
    this.fadeTimer = null;
    if (duration <= 0) { this.audio.volume = to; if (reflectVolume) this.update({ volume: to * 100 }); return; }
    const start = performance.now(); this.audio.volume = from;
    this.fadeTimer = setInterval(() => {
      const progress = Math.min(1, (performance.now() - start) / duration);
      this.audio.volume = from + (to - from) * progress;
      if (reflectVolume) this.update({ volume: this.audio.volume * 100 });
      if (progress >= 1 && this.fadeTimer) { clearInterval(this.fadeTimer); this.fadeTimer = null; }
    }, 20);
  }
  dispose(): void { this.disposed = true; ++this.generation; this.silence(); this.audio.onended = null; this.audio.onerror = null; this.audio.removeAttribute('src'); this.audio.load(); void this.output.dispose().catch((error: unknown) => this.update({ status: 'error', error: `关闭音频输出失败：${String(error)}` })); }

  private tick(): void {
    if (this.state.status !== 'playing' || this.finishingLighting) return;
    try {
      const now = performance.now(); const positionMs = this.audio.currentTime * 1000;
      if (positionMs !== this.previousPosition) { this.previousPosition = positionMs; this.lastAdvanced = now; }
      if (now - this.lastAdvanced > 500) throw new Error('正式音频播放位置停止更新，已冻结音频、时间线及 MIDI 输出');
      const loop = this.project.rundown.find((item) => item.id === this.state.itemId)?.lighting?.loop;
      if (loop?.enabled && positionMs >= loop.endMs && loop.endMs <= this.state.durationMs && loop.startMs < loop.endMs && this.state.itemId) {
        const itemId = this.state.itemId;
        this.finishLighting(loop.endMs, () => { void this.play(itemId, loop.startMs); });
        return;
      }
      if (positionMs >= this.state.durationMs) { this.finish(); return; }
      // Outputs follow what the audience hears, not the element's decode position.
      const audibleMs = this.audiblePosition(positionMs);
      if (this.state.mtcEnabled && !this.directLighting && this.state.mtcPortName) {
        try { if (this.mtc.tick(audibleMs + this.offsetMs, this.project.timebase.frameRate, now)) this.mtcSentPositionMs = audibleMs + this.offsetMs; }
        catch (error) { this.mtc.stop(); this.update({ mtcPortName: null, mtcConnectionFailed: true }); this.appendNotice(`MIDI 时间码已停止：${toUserErrorMessage(error)}。音频继续播放。`); }
      }
      const schedulingNotice = this.mtc.takeSchedulingNotice();
      // Like P1, an interrupted timecode resumes with a full frame; it is logged, not shown in red.
      if (schedulingNotice) this.dependencies.notice?.(schedulingNotice, this.state.itemId);
      if (this.lightingPrepared) try { this.lighting.tick(audibleMs); this.reportLightingFault(); }
      catch (error) { this.lightingPrepared = false; this.lighting.stop(); this.appendNotice(`灯光动作已停止：${toUserErrorMessage(error)}。音频继续播放。`); }
      const frame = millisecondsToFrameNumber(audibleMs, this.project.timebase.frameRate);
      if (frame !== this.lastFrame) {
        this.lastFrame = frame; const generation = this.generation;
        if (this.runtimePrepared) void this.dependencies.ingest(audibleMs).catch((error: unknown) => { if (this.current(generation)) this.disableRuntime(error); });
      }
      if (now - this.lastRendered > 50) { this.lastRendered = now; this.update({ positionMs, mtcPositionMs: positionMs + this.offsetMs, mtcSentPositionMs: this.mtcSentPositionMs }); }
    } catch (error) { this.fail(error); }
  }
  private finish(): void {
    if (this.state.status !== 'playing' || this.finishingLighting) return;
    this.finishLighting(Math.min(this.audio.currentTime * 1000, this.state.durationMs), () => this.completePlayback());
  }
  private finishLighting(positionMs: number, complete: () => void): void {
    if (!this.lightingPrepared) { complete(); return; }
    try {
      const pending = this.lighting.finish(positionMs);
      if (!pending) { complete(); return; }
      const generation = this.generation; this.finishingLighting = true;
      void pending.then(() => {
        if (!this.current(generation)) return;
        this.reportLightingFault(); this.finishingLighting = false; complete();
      }, (error: unknown) => { if (this.current(generation)) { this.lightingPrepared = false; this.appendNotice(`灯光收尾失败：${toUserErrorMessage(error)}`); complete(); } });
    } catch (error) { this.lightingPrepared = false; this.appendNotice(`灯光收尾失败：${toUserErrorMessage(error)}`); complete(); }
  }
  private completePlayback(): void {
    this.markPlayed();
    this.silence();
    if (this.state.endAction === 'pause') {
      const generation = this.generation; this.audio.currentTime = this.state.durationMs / 1000;
      this.update({ status: 'paused', positionMs: this.state.durationMs, mtcPositionMs: this.state.durationMs + this.offsetMs });
      if (this.runtimePrepared) void this.dependencies.pause('播完暂停').catch((error: unknown) => { if (this.current(generation)) this.disableRuntime(error); }); return;
    }
    if (this.state.endAction === 'loop' && this.state.itemId) { void this.play(this.state.itemId); return; }
    const items = playlistItems(this.project, this.state.playlistId ?? 'all').filter((item) => item.enabled && item.referenceAudio);
    const next = items[items.findIndex((item) => item.id === this.state.itemId) + 1];
    if (this.state.endAction === 'next' && next) { void this.play(next.id); return; }
    void this.stop('播完停止');
  }
  private fail(error: unknown): void {
    const errorTitle = error instanceof PreflightBlockedError ? '播放未开始：预检未通过'
      : this.state.mtcConnectionFailed ? '播放未开始：时间码输出不可用'
      : this.state.status === 'preparing' ? '播放未开始：准备失败' : '播放操作失败';
    const generation = ++this.generation; let message = toUserErrorMessage(error);
    try { this.silence(); } catch (cleanup) { message += `；灯光释放失败：${toUserErrorMessage(cleanup)}`; }
    this.update({ status: 'error', error: message, errorTitle, notice: null });
    this.dependencies.failed?.(`${errorTitle}：${message}`, this.state.itemId);
    void this.dependencies.stop('播放失败后清理联动').catch((cleanup: unknown) => {
      this.dependencies.failed?.(`播放失败后清理联动未完成：${toUserErrorMessage(cleanup)}`, this.state.itemId);
      if (this.current(generation)) this.update({ error: `${message}；清理失败：${toUserErrorMessage(cleanup)}` });
    });
  }
  /** An output that could not join this song: logged and shown in red, the song still starts. */
  private startFault(message: string): void { this.dependencies.notice?.(message, this.state.itemId); this.reportFault(message); }
  /** Never earlier than the start of this playing segment and never backwards,
   * so a latency reading that grows cannot make timecode or Cues jump back. */
  private audiblePosition(positionMs: number): number {
    this.audibleMs = Math.max(this.audibleMs, positionMs - this.output.latencyMs());
    return this.audibleMs;
  }
  private reportLightingFault(): void {
    const fault = this.lighting.takeFault();
    if (fault) { this.dependencies.notice?.(fault, this.state.itemId); this.reportFault(fault); }
  }
  private appendNotice(message: string): void {
    if (this.state.notice?.includes(message)) return;
    this.dependencies.notice?.(message, this.state.itemId);
    this.update({ notice: [this.state.notice, message].filter(Boolean).join('；') });
  }
  private disableRuntime(error: unknown): void {
    if (!this.runtimePrepared) return;
    this.runtimePrepared = false;
    this.appendNotice(`画面与联动已停止：${toUserErrorMessage(error)}。音频继续播放。`);
  }
  private silence(): void {
    this.finishingLighting = false;
    this.audio.pause(); this.mtc.stop();
    this.mtcSentPositionMs = null;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    if (this.fadeTimer) clearInterval(this.fadeTimer); this.fadeTimer = null;
    this.lighting.stop();
  }
  private current(generation: number): boolean { return !this.disposed && generation === this.generation; }
  private markPlayed(): void { if (this.state.itemId) this.update({ playedItemIds: [...new Set([...this.state.playedItemIds, this.state.itemId])] }); }
  private update(patch: Partial<InternalPlayerState>): void {
    this.state = { ...this.state, ...patch };
    if (this.state.status !== 'preparing') this.state.preparation = null;
    this.dependencies.changed({ ...this.state });
  }
}

function waitForAudio(audio: HTMLAudioElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer); audio.removeEventListener('loadedmetadata', ready); audio.removeEventListener('error', failed);
      if (error) reject(error); else resolve();
    };
    const ready = (): void => finish(); const failed = (): void => finish(new Error('无法加载正式音频'));
    const timer = setTimeout(() => finish(new Error('正式音频加载超过 10 秒')), 10_000);
    audio.addEventListener('loadedmetadata', ready, { once: true }); audio.addEventListener('error', failed, { once: true });
    audio.load();
  });
}
