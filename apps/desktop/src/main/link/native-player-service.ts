import { nativePlayerControlSchema, nativePlayerNextSchema, nativePlayerPrepareSchema, nativePlayerStatusSchema,
  type NativePlayerControl, type NativePlayerNext, type NativePlayerPrepare, type NativePlayerStatus, type NativePlaybackEvent, type NativeDeviceQueryRequest, type NativePlaybackDevices } from '@tb/schema';
import { NativeAudioCache, type NativeAudioLease } from './native-audio-cache';
import { NativeEngineRejection, NativePlaybackClient, type NativeClockState } from './native-playback-client';
import { playableEndMs, rangeRejectedMessage } from './native-playback-range';
import { NativeDeviceQuery } from './native-device-query';
import { basename } from 'node:path';
import { NativeAudioPreload } from './native-audio-preload';
import { MidiPortRecovery, type PortRecoveryReport } from './midi-port-recovery';
import { midiPortBusy, sharedPortMessage } from './midi-error';
import { audioErrorMessage } from './audio-error';
import { OutputRecovery, type RecoveryResult } from '@tb/core/link';
import type { MidiClaim } from './midi-port-broker';

type Clock = Extract<NativePlaybackEvent, { kind: 'clock' }>;
/** The device states each control ends in; a failure anywhere ends in error. */
const settledStates: Record<Exclude<NativePlayerControl['kind'], 'volume'>, readonly NativeClockState[]> = {
  play: ['playing', 'ended', 'error'], pause: ['paused', 'error'], seek: ['paused', 'error'], stop: ['stopped', 'error'],
  // Releasing the timecode port leaves the audio as it was.
  'stop-mtc': ['empty', 'ready', 'playing', 'paused', 'stopped', 'ended', 'error']
};
type Options = {
  executable: string; cache: Pick<NativeAudioCache, 'prepare'>;
  /** Rejects while Windows MIDI is unhealthy; a failed check is repeated only with `recheck`. */
  checkDeviceHealth: (recheck: boolean) => Promise<void>;
  resolveAudio: (projectPath: string, relativePath: string) => string;
  changed: (status: NativePlayerStatus, qpc100ns: string | null) => void;
  error: (message: string) => void;
  /** Whatever goes wrong with the next song prepared ahead: its own preparation or decode failing in the background, or
   * an error while it is let go. It is not the failure of the song being prepared (or of a seek, stop or close), so it
   * is reported apart from `error`, without that song's preparation steps. Required, so a caller cannot leave it out
   * and have these land in `error` (audioErrorLog gives both). */
  preloadError: (message: string) => void;
  /** The timecode port came back and timecode resumed. */
  recovered?: (report: PortRecoveryReport) => void;
  /** A dropout or a refused timecode send this song counted against its limit (output-recovery.ts), with the red text
   * shown for it: carried on from (`recover`), or the one that reached the limit. For the run log. */
  recovery?: (entry: { result: RecoveryResult; message: string; itemId: string; positionMs: number;
    /** The Windows code of a refused timecode send. */ code?: number }) => void;
  measured?: (phase: string, elapsedMs: number) => void;
  beforeControl?: (request: NativePlayerControl) => void;
  /** Takes the timecode output from the editor before the engine opens it. */
  claimMidiOutput?: (portName: string) => Promise<MidiClaim>;
  /** Shown in red: what an engine that exited after a failed close held could not be let go (releaseExited). It is
   * logged through `error` as well. */
  closeFault?: (message: string) => void;
};

/** One process and one serialized command stream, owned by the app session.
 * No renderer timer participates in WASAPI playback or MIDI scheduling. */
export class NativePlayerService {
  private client: NativePlaybackClient | null = null;
  private lease: NativeAudioLease | null = null;
  private abort: AbortController | null = null;
  private pending: Promise<void> = Promise.resolve();
  private queued = 0;
  private stopping: { epoch: number; sessionId: string; task: Promise<NativePlayerStatus> } | null = null;
  private state: NativePlayerStatus | null = null;
  private source: NativePlayerPrepare | null = null;
  /** Where the engine stops this program: the program end, or the end of the decoded audio when that is up to a frame shorter. */
  private playEndMs = 0;
  private epoch = 0;
  private nativeGeneration = 0;
  private requestId = 0;
  private closing = false;
  private volume = 1;
  private engineInterruptions = 0;
  /** The engine's dropout and refused timecode send counts, from its latest telemetry; it restarts them on every prepare. */
  private engineUnderruns = 0;
  private engineTransient = 0;
  /** Timecode send failures counted in this song, and when the last one was counted (MTC_REFUSAL_SPAN_MS). */
  private mtcRefused = 0;
  private mtcRefusedAt: number | null = null;
  /** This song's dropouts and refused timecode sends against their limits (2026-11-10 decision 2); a new song starts over, a seek does not. */
  private recovery = new OutputRecovery();
  private readonly preload: NativeAudioPreload;
  private readonly deviceQuery: NativeDeviceQuery;
  private readonly audioDeviceQuery: NativeDeviceQuery;
  private readonly mtcRecovery: MidiPortRecovery;
  /** The engine's count of completed timecode port reopens, from its latest telemetry. */
  private engineReopens = 0;
  /** A timecode port reopen waiting for telemetry to confirm it. */
  private reopening: { check: (clock: Clock) => void; cancel: () => void } | null = null;
  /** The timecode output the engine may hold, kept from the editor until the engine lets it go. */
  private mtcHold: { name: string; claim: MidiClaim | null } | null = null;
  constructor(private readonly options: Options) {
    // Only the fields it needs: a spread of these options would hand it this player's `error` as well.
    this.preload = new NativeAudioPreload({ cache: options.cache, resolveAudio: options.resolveAudio, measured: options.measured,
      error: options.preloadError });
    this.deviceQuery = new NativeDeviceQuery(options.executable);
    this.audioDeviceQuery = new NativeDeviceQuery(options.executable, 'audio');
    // Windows MIDI often stalls or fails for a moment while a port is removed or added, so a health
    // check or device query that failed meanwhile is repeated on each tick instead of being kept.
    this.mtcRecovery = new MidiPortRecovery({ subject: '时间码端口', list: async () => (await this.devices('all', true)).midiOutputs, reopen: (device, name) => this.reopenMtc(device, name),
      active: () => this.state?.status === 'playing',
      recovered: report => {
        this.patch({ mtcError: null, mtcPortName: report.portName, mtcRecovered: report }); this.options.recovered?.(report);
      }, log: message => this.options.error(message) });
  }

  get status(): NativePlayerStatus | null { return this.state; }
  /** Read from the engine now, not from `status` (0.5.9 S6): whether it may be sounding. Asked after a program's close
   * failed, before another program opens. */
  engineSounding(): boolean { return this.client?.sounding ?? false; }
  /** After a close that failed (0.5.9 S6): once the engine process is gone (it exited normally, after the timeout, or
   * with an error code), what it held is let go: the timecode port before this returns, then the audio file and the next
   * song's preparation. While the process is there nothing is let go, as it may still use them, and this returns null.
   * The promise never rejects: what cannot be let go is logged (`error`) and shown in red (`closeFault`). */
  releaseExited(): Promise<void> | null {
    if (this.client?.running) return null;
    this.client = null;
    try { this.releaseMtc(); } catch (error) { this.leftHeld('时间码接口', error); }
    return (async () => {
      // A next song that does not let go reports it itself (preloadError).
      await this.preload.discard();
      try { await this.releaseLease(); } catch (error) { this.leftHeld('上一首的音频文件', error); }
    })();
  }
  private leftHeld(what: string, error: unknown): void {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/[。.；;\s]+$/u, '') || '未知错误';
    const message = `音频引擎已经退出，但${what}没能放开：${reason}。之后的歌照常播放；如果${what === '时间码接口' ? '时间码接口打不开' : '之后读不到这首歌的音频'}，请重启联动台`;
    this.options.error(message); this.options.closeFault?.(message);
  }
  get audioCaptureIdentity(): { executable: string; title: string; windowClass: string; audioDeviceId: string } {
    const identity = this.client?.identity;
    if (!identity || !this.source || !this.state || !['ready', 'playing', 'paused', 'ended'].includes(this.state.status)
      || identity.pid !== this.state.enginePid || identity.title !== this.state.engineTitle) {
      throw new Error('音频进程还没准备好，无法确认 OBS 要采集哪个窗口');
    }
    return { executable: basename(this.options.executable), title: identity.title, windowClass: identity.windowClass, audioDeviceId: this.source.audioDeviceId };
  }
  async devices(scope: NativeDeviceQueryRequest['scope'] = 'all', recheck = false) {
    if (this.closing) throw new Error('音频服务正在关闭');
    // The native inventory enumerates WinMM as well as WASAPI. Do not start a
    // helper that cannot consume its shutdown request when WinMM is unhealthy.
    if (scope === 'all') await this.options.checkDeviceHealth(recheck);
    if (this.closing) throw new Error('音频服务正在关闭');
    const query = scope === 'audio' ? this.audioDeviceQuery : this.deviceQuery;
    if (recheck) await query.reopenForPreparation();
    return query.read();
  }

  prepare(input: NativePlayerPrepare): Promise<NativePlayerStatus> {
    const request = nativePlayerPrepareSchema.parse(input);
    if (this.closing) return Promise.reject(new Error('音频服务正在关闭'));
    if (this.queued >= 32) return Promise.reject(new Error('音频控制排队已满，这次操作没有执行'));
    if (request.sessionId === this.state?.sessionId && request.generation <= this.state.generation) return Promise.reject(new Error('这次播放准备已过期'));
    const failedClient = this.state?.status === 'error' ? this.client : null;
    const epoch = ++this.epoch;
    this.stopRecovery();
    this.abort?.abort();
    const abort = new AbortController(); this.abort = abort;
    this.source = request;
    this.volume = request.snapshot.volume;
    this.state = { version: 1, sessionId: request.sessionId, generation: request.generation,
      itemId: request.snapshot.itemId, status: 'preparing', positionMs: request.snapshot.positionMs, offsetMs: request.snapshot.offsetMs,
      sampleRate: request.snapshot.sampleRate, enginePid: null, engineTitle: null, mtcPortName: null, mtcSent: 0,
      audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, mtcRecovered: null, outputFault: null, gain: request.snapshot.volume, analysis: null };
    this.recovery = new OutputRecovery(); this.mtcRefused = 0; this.mtcRefusedAt = null;
    this.publish();
    const operation = this.pending.then(async () => {
      let measuredAt = performance.now();
      const measured = (phase: string): void => { const now = performance.now(); this.options.measured?.(phase, now - measuredAt); measuredAt = now; };
      this.requireEpoch(epoch);
      if (failedClient && this.client === failedClient) { await failedClient.close(); this.client = null; this.releaseMtc(); }
      this.requireEpoch(epoch);
      if (this.client) await this.send({ kind: 'stop' });
      this.requireEpoch(epoch);
      await this.releaseLease();
      const scope = request.midiPortName || request.autoDetectMtc ? 'all' : 'audio';
      await (scope === 'audio' ? this.audioDeviceQuery : this.deviceQuery).reopenForPreparation();
      this.requireEpoch(epoch);
      let devices: NativePlaybackDevices, midiUnavailable: string | null = null;
      try { devices = await this.devices(scope); }
      catch (error) {
        // MIDI is optional: when Windows cannot check or list MIDI, this song plays without
        // timecode (reported below); the audio device list is read on its own.
        if (scope !== 'all') throw error;
        this.requireEpoch(epoch);
        midiUnavailable = error instanceof Error ? error.message : String(error);
        this.options.error(`MIDI 设备不可用，这一首不发时间码：${midiUnavailable}`);
        await this.audioDeviceQuery.reopenForPreparation(); this.requireEpoch(epoch);
        devices = { ...await this.devices('audio'), midiOutputs: [], midiInputs: [] };
      }
      measured('设备检查与旧播放清理');
      this.requireEpoch(epoch);
      if (request.audioDeviceId !== 'default' && !devices.audio.some(device => device.id === request.audioDeviceId)) throw new Error('选择的音频输出设备已断开，不会自动换到其他设备');
      if (request.audioDeviceId === 'default' && !devices.audio.some(device => device.isDefault)) throw new Error('Windows 默认音频输出不可用');
      const midi = request.midiPortName ? devices.midiOutputs.filter(device => device.name === request.midiPortName)
        : request.autoDetectMtc ? devices.midiOutputs.filter(device => !/Microsoft GS Wavetable Synth/i.test(device.name)) : [];
      const midiDevice = midi.length === 1 ? midi[0]!.id : null;
      if ((request.midiPortName || request.autoDetectMtc) && midiDevice === null) this.patch({ mtcError: midiUnavailable ? `MIDI 设备不可用：${midiUnavailable}`
        : midi.length > 1 ? request.midiPortName ? `电脑上有 ${midi.length} 个叫「${request.midiPortName}」的 MIDI 输出，分不清用哪个。请拔掉多余的一个，再重新播放。`
          : `还没选时间码输出，电脑上有 ${midi.length} 个 MIDI 输出（${midi.map(port => port.name).join('、')}），不知道该用哪个。请到「设置 → 音频与 MIDI」选好“时间码输出”。`
          : '选择的 MIDI 时间码输出没有连接，接口接上后会自动开始发送' });
      const warmed = await this.preload.take(request.projectPath, request.snapshot);
      if (epoch !== this.epoch) { await warmed?.release(); throw new Error('音频准备已取消'); }
      const lease = warmed ?? await this.options.cache.prepare({ sourcePath: this.options.resolveAudio(request.projectPath, request.snapshot.audio.relativePath),
        sourceSha256: request.snapshot.audio.sha256, expectedDurationMs: request.snapshot.audio.durationMs,
        sampleRate: request.snapshot.sampleRate, positionMs: request.snapshot.positionMs }, abort.signal);
      measured('音源校验与解码预填充');
      if (epoch !== this.epoch) { await lease.release(); throw new Error('音频准备已取消'); }
      this.attachLease(lease);
      const endMs = playableEndMs({ startMs: request.snapshot.positionMs, endMs: request.snapshot.endMs, availableMs: lease.availableMs, frameRate: request.snapshot.frameRate });
      this.playEndMs = endMs;
      if (!this.client) {
        const client = new NativePlaybackClient(this.options.executable, event => {
          if (this.client === client && event.kind === 'clock') { this.engineReopens = event.midiReopens; this.receive(event); }
        }, error => { if (this.client === client) this.fail(error); });
        this.client = client; await client.start();
      }
      measured('原生进程准备');
      this.requireEpoch(epoch);
      const snapshot = request.snapshot;
      // The engine lets the previous port go and opens this one in the same step.
      const previous = await this.holdMtc(midiDevice === null ? null : midi[0]!.name);
      this.requireEpoch(epoch);
      try {
        await this.client.command({ protocol: 4, requestId: ++this.requestId, generation: ++this.nativeGeneration, kind: 'prepare',
          pcmPath: lease.path, pcmBaseMs: lease.baseMs, streaming: lease.streaming, audioDeviceId: request.audioDeviceId, sampleRate: snapshot.sampleRate, frameRate: snapshot.frameRate,
          midiDevice, ...(midiDevice === null ? {} : { midiPortName: midi[0]!.name }), quarterFramesOnly: request.mtcQuarterFramesOnly ?? false,
          startMs: snapshot.positionMs, endMs, offsetMs: snapshot.offsetMs, volume: snapshot.volume })
          .catch((error: unknown) => { throw explainRange(error, snapshot.positionMs, endMs, lease); });
      } finally { previous?.claim?.release(); }
      const clock = await this.client.readClock(this.nativeGeneration, ['ready', 'error']);
      measured('音频设备与时钟准备');
      this.requireEpoch(epoch);
      if (clock.audioError || clock.state === 'error') throw new Error(`音频没有准备好：${audioErrorMessage(clock.audioError)}`);
      this.patch({ status: 'ready', enginePid: this.client.identity!.pid, engineTitle: this.client.identity!.title,
        mtcPortName: midiDevice === null ? null : midi[0]!.name });
      this.receive(clock);
      // The configured port is missing: it opens as soon as that same port appears (authorised 2026-10-24).
      if (request.midiPortName && midiDevice === null) this.mtcRecovery.lost(request.midiPortName);
    });
    return this.finish(operation, epoch);
  }

  control(input: NativePlayerControl): Promise<NativePlayerStatus> {
    const request = nativePlayerControlSchema.parse(input);
    const state = this.state;
    if (!state || request.sessionId !== state.sessionId || request.generation < state.generation) return Promise.reject(new Error('这个播放操作已过期'));
    if (this.closing) return Promise.reject(new Error('音频服务正在关闭'));
    if (request.kind === 'stop' || request.kind === 'stop-mtc') this.stopRecovery();
    if (request.kind === 'stop' && this.stopping?.epoch === this.epoch && this.stopping.sessionId === request.sessionId) {
      this.patch({ generation: request.generation }); return this.stopping.task;
    }
    if (request.kind !== 'stop' && this.queued >= 32) return Promise.reject(new Error('音频控制排队已满，这次操作没有执行'));
    if (request.kind !== 'stop' && (state.status === 'error' || state.status === 'stopped' || state.status === 'preparing' || !this.lease)) return Promise.reject(new Error('音频还没准备好或已停止，请重新播放这首歌'));
    if (request.kind === 'seek' && (!this.source || request.positionMs < this.source.snapshot.startMs || request.positionMs >= this.playEndMs)) return Promise.reject(new Error('定位超出了节目的裁剪范围'));
    this.options.beforeControl?.(request);
    // Transport boundaries invalidate queued/in-flight continuations. A late
    // seek must never resume after a newer pause, stop or program preparation.
    if (request.kind !== 'volume' && request.kind !== 'stop-mtc') { ++this.epoch; this.abort?.abort(); }
    const epoch = this.epoch;
    if (request.kind === 'seek') this.abort = new AbortController();
    const signal = this.abort?.signal;
    this.patch({ generation: request.generation });
    const operation = this.pending.then(async () => {
      this.requireEpoch(epoch);
      if (!this.client) {
        if (request.kind !== 'stop') throw new Error('音频引擎还没准备好');
      } else {
        if (request.kind === 'seek') {
          // Decode from the requested source position, never wait for hours of
          // preceding PCM or change the original source/timecode coordinates.
          const snapshot = this.source!.snapshot;
          const midi = await this.resolveMidi(epoch);
          this.requireEpoch(epoch);
          await this.send({ kind: 'stop' }); await this.preload.discard(); await this.releaseLease(); this.requireEpoch(epoch);
          const lease = await this.options.cache.prepare({ sourcePath: this.options.resolveAudio(this.source!.projectPath, snapshot.audio.relativePath),
            sourceSha256: snapshot.audio.sha256, expectedDurationMs: snapshot.audio.durationMs,
            sampleRate: snapshot.sampleRate, positionMs: request.positionMs }, signal!);
          if (epoch !== this.epoch) { await lease.release(); throw new Error('音频定位已取消'); }
          this.attachLease(lease);
          const endMs = playableEndMs({ startMs: request.positionMs, endMs: snapshot.endMs, availableMs: lease.availableMs, frameRate: snapshot.frameRate });
          this.playEndMs = endMs;
          await this.client.command({ protocol: 4, requestId: ++this.requestId, generation: ++this.nativeGeneration, kind: 'prepare',
            pcmPath: lease.path, pcmBaseMs: lease.baseMs, streaming: lease.streaming, audioDeviceId: this.source!.audioDeviceId, sampleRate: snapshot.sampleRate, frameRate: snapshot.frameRate,
            midiDevice: midi?.id ?? null, ...(midi ? { midiPortName: midi.name } : {}), quarterFramesOnly: this.source!.mtcQuarterFramesOnly ?? false,
            startMs: request.positionMs, endMs, offsetMs: snapshot.offsetMs, volume: this.volume })
            .catch((error: unknown) => { throw explainRange(error, request.positionMs, endMs, lease); });
          // Without a timecode port the engine has let the previous one go.
          if (midi === null) this.releaseMtc();
          this.requireEpoch(epoch);
          await this.send({ kind: 'pause' });
        } else await this.send(request);
        if (request.kind !== 'volume') {
          const clock = await this.client.readClock(this.nativeGeneration, settledStates[request.kind]);
          this.requireEpoch(epoch);
          if (clock.audioError || clock.state === 'error') throw new Error(`音频操作没有完成：${audioErrorMessage(clock.audioError)}`);
          this.receive(clock);
        }
        // A stopped program lets its timecode port go, so P1 or the editor can use it until the next song.
        if (request.kind === 'stop' && this.mtcHold) { await this.send({ kind: 'stop-mtc' }); this.requireEpoch(epoch); }
        if (request.kind === 'stop' || request.kind === 'stop-mtc') this.releaseMtc();
      }
      this.requireEpoch(epoch);
      if (request.kind === 'volume') this.volume = request.volume;
      if (request.kind === 'stop-mtc' || request.kind === 'stop') this.patch({ mtcPortName: null });
      // The next song prepared ahead is only let go: a failed cleanup of it is reported, not this stop's failure.
      if (request.kind === 'stop') { this.patch({ status: 'stopped' }); await this.preload.discard(); await this.releaseLease(); }
      if (request.kind === 'play' && this.source?.nextSnapshot) this.preload.start(this.source.projectPath, this.source.nextSnapshot);
    });
    const result = this.finish(operation, epoch);
    if (request.kind !== 'stop') return result;
    const task = result.finally(() => { if (this.stopping?.task === task) this.stopping = null; });
    this.stopping = { epoch, sessionId: request.sessionId, task }; return task;
  }

  /** The next song's audio as the newest version has it (0.5.9 S8b): what was prepared ahead is let go and this is
   * prepared instead, as a play prepares it. The song that plays is not touched: no engine command, no transport
   * boundary (`epoch`), nothing waits behind its controls or they behind this. Resolves once the old preparation is let
   * go; the new one runs in the background and reports its own failure (preloadError). Before the song first plays only
   * the request is kept: its play prepares it. A stop, seek or another song lets the new one go like the old one. */
  async prepareNext(input: NativePlayerNext): Promise<void> {
    const request = nativePlayerNextSchema.parse(input), state = this.state, source = this.source;
    if (!state || !source || request.sessionId !== state.sessionId || request.generation < state.generation) throw new Error('下一首的准备请求已过期');
    if (this.closing || !['ready', 'playing', 'paused'].includes(state.status)) throw new Error('这首歌已经停了，下一首播到时照常准备');
    const next = request.nextSnapshot;
    if (next && (next.projectId !== source.snapshot.projectId || next.revision < source.snapshot.revision || next.sampleRate !== source.snapshot.sampleRate)) {
      throw new Error('下一节目必须属于同一工程、不早于当前节目的修订，并使用相同的音频采样率');
    }
    // A play prepares it ahead (control): until then only the request is kept.
    const ahead = this.preload.started || state.status === 'playing';
    if (next) source.nextSnapshot = next; else delete source.nextSnapshot;
    await (next && ahead ? this.preload.replace(source.projectPath, next) : this.preload.discard());
  }

  async close(): Promise<void> {
    this.closing = true; ++this.epoch; this.abort?.abort(); this.stopRecovery();
    await this.pending;
    const client = this.client;
    try { await Promise.all([client?.close(), this.deviceQuery.close(), this.audioDeviceQuery.close()]); }
    catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      // An engine that is gone already (an exit with an error code, or a query that failed beside a clean exit) lets go
      // of what it held now; the close still fails and is reported (0.5.9 S6).
      await this.releaseExited();
      throw error;
    }
    // A next song whose decoder would not stop is only reported, so close() completes and lets that decoder go.
    // Caveat: it stays registered in this service's cache alone. link-main gives the next service a new
    // NativeAudioCache, which does not know that process: until it exits, the same source can be decoded again
    // beside it, outside the two-decoder limit and the disk reserve.
    this.client = null; this.releaseMtc(); await this.preload.discard(); await this.releaseLease();
    if (this.state) this.patch({ status: 'stopped', enginePid: null, engineTitle: null });
  }

  private async releaseLease(): Promise<void> {
    const lease = this.lease; this.lease = null; await lease?.release();
  }
  private attachLease(lease: NativeAudioLease): void {
    this.lease = lease;
    void lease.completion.then(result => {
      if (result.ok || this.lease !== lease || this.closing) return;
      // Decoder failure is an audio-clock failure.
      this.stopForFault(result.error, () => this.lease === lease);
    });
  }
  private async resolveMidi(epoch: number): Promise<{ id: number; name: string } | null> {
    if (!this.state?.mtcPortName || this.state.mtcError) return null;
    const name = this.state.mtcPortName, devices = await this.devices();
    this.requireEpoch(epoch);
    const ports = devices.midiOutputs.filter(port => port.name === name);
    if (ports.length !== 1) {
      const message = ports.length ? 'MIDI 时间码的输出目标变了，时间码已停止，音频照常播放。请重新播放这首歌来恢复时间码'
        : `MIDI 时间码接口「${name}」断开了，音频照常播放。插回同一个接口后，时间码会自动接着发`;
      this.patch({ mtcPortName: null, mtcError: message }); this.options.error(message);
      if (!ports.length) this.mtcRecovery.lost(name);
      return null;
    }
    return { id: ports[0]!.id, name };
  }
  /** The request is queued like other commands; the engine opens the port on its MIDI thread and reports
   * the outcome in telemetry. It counts as recovered only once timecode goes out from the opened port:
   * a port Windows is still creating opens, then fails its first message. A newer transport boundary
   * cancels it and the watch tries again. */
  private async reopenMtc(device: number, name: string): Promise<void> {
    const epoch = this.epoch;
    let before = 0, refusedBefore = 0;
    const operation = this.pending.then(async () => {
      this.requireEpoch(epoch);
      if (!this.client) throw new Error('音频引擎还没准备好');
      (await this.holdMtc(name))?.claim?.release();
      this.requireEpoch(epoch);
      before = this.engineReopens; refusedBefore = this.engineTransient;
      await this.client.command({ protocol: 4, requestId: ++this.requestId, generation: this.nativeGeneration, kind: 'reopen-mtc', midiDevice: device, midiPortName: name });
      this.requireEpoch(epoch);
    });
    this.pending = operation.then(() => undefined, () => undefined);
    await operation;
    await new Promise<void>((resolve, reject) => {
      let sentAt: number | null = null;
      const settle = (error: Error | null) => {
        clearTimeout(timer); if (this.reopening === entry) this.reopening = null;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => settle(new Error('端口重新打开后 8 秒内没有确认发送')), 8000);
      const entry = { cancel: () => settle(new Error('播放操作已被取消')), check: (clock: Clock) => {
        if (epoch !== this.epoch) settle(new Error('播放操作已被取消'));
        else if (clock.midiReopens <= before) return;
        else if (clock.midiReopenResult) settle(new Error(`Windows 没能打开这个端口（错误码 ${clock.midiReopenResult}）`));
        else if (clock.midiError) settle(new Error(`端口已打开但发送失败（错误码 ${clock.midiError}）`));
        else if (clock.midiTransient > refusedBefore) settle(new Error('端口已打开，但 Windows 拒绝了发出的时间码'));
        else if (clock.state !== 'playing') settle(new Error('播放已暂停或停止，继续播放后再恢复'));
        else if (sentAt === null) sentAt = clock.midiSent;
        else if (clock.midiSent >= sentAt + 8) settle(null);
      } };
      this.reopening = entry;
    });
  }
  /** A fault that ends the song: stop MIDI/audio and invalidate any in-flight prepare before reporting a usable next
   * session. The engine is stopped while `still()` holds. */
  private stopForFault(error: Error, still: () => boolean = () => true): void {
    ++this.epoch; this.abort?.abort(); this.fail(error);
    const cleanup = this.pending.then(async () => {
      if (!still()) return;
      if (this.client) await this.send({ kind: 'stop' });
      await this.releaseLease();
    });
    this.pending = cleanup.catch(failure => this.fail(failure instanceof Error ? failure : new Error(String(failure))));
  }
  private stopRecovery(): void { this.mtcRecovery.cancel(); this.reopening?.cancel(); }
  /** Holds `name` for the engine before it opens it; null: the engine will hold no timecode port.
   * Returns the previous hold when it changed: it is released once the engine has let that port go. */
  private async holdMtc(name: string | null): Promise<{ name: string; claim: MidiClaim | null } | null> {
    const previous = this.mtcHold;
    if (previous?.name === name) return null;
    this.mtcHold = name === null ? null : { name, claim: await this.options.claimMidiOutput?.(name) ?? null };
    return previous;
  }
  /** The engine holds no timecode port any more. */
  private releaseMtc(): void { this.mtcHold?.claim?.release(); this.mtcHold = null; }
  private send(command: { kind: 'play' | 'pause' | 'stop' | 'stop-mtc' } | { kind: 'volume'; volume: number; durationMs?: number | undefined }): Promise<void> {
    if (!this.client) return Promise.reject(new Error('音频引擎还没准备好'));
    const action = command.kind === 'volume' ? { kind: command.kind, volume: command.volume, durationMs: command.durationMs ?? 0 } : { kind: command.kind };
    return this.client.command({ protocol: 4, requestId: ++this.requestId,
      generation: command.kind === 'volume' || command.kind === 'stop-mtc' ? this.nativeGeneration : ++this.nativeGeneration, ...action });
  }
  private finish(operation: Promise<void>, epoch: number): Promise<NativePlayerStatus> {
    this.queued++;
    const result = operation.then(() => { this.requireEpoch(epoch); return this.state!; }, error => {
      if (epoch === this.epoch) this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }).finally(() => { this.queued--; });
    // Caller receives the rejection; this tail is only the serial queue barrier.
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
  private requireEpoch(epoch: number): void { if (epoch !== this.epoch || this.closing) throw new Error('播放操作已被取消'); }
  private receive(clock: Clock): void {
    if (!this.state || clock.generation !== this.nativeGeneration || this.state.status === 'preparing' || this.state.status === 'error') return;
    const audioError = clock.audioError ? audioErrorMessage(clock.audioError) : this.state.audioError;
    // While the lost port is waited for and reopened, its errors belong to that outage: the watch logs them.
    const midiError = this.mtcRecovery.watching ? 0 : clock.midiError;
    this.reopening?.check(clock);
    // 5/6: the interface is gone; the same port is opened again once it is back. 4/7 (held by another program) is left to the operator.
    const unplugged = midiError === 5 || midiError === 6;
    // A dropout, or a timecode send Windows refused while the port stayed, is carried on from up to the limit (2026-11-10 decision 2).
    const underruns = this.state.underruns + newCount(clock.underruns, this.engineUnderruns); this.engineUnderruns = clock.underruns;
    const refused = newCount(clock.midiTransient, this.engineTransient); this.engineTransient = clock.midiTransient;
    const dropouts = this.carryOn('audio.underrun', underruns - this.state.underruns, underruns);
    // While the lost port is waited for and reopened, its refusals belong to that outage; a timecode already stopped counts no more.
    // The refused sends of one busy moment are one failure (MTC_REFUSAL_SPAN_MS).
    const now = Date.now();
    const counted = refused && !this.mtcRecovery.watching && !this.state.mtcError
      && (this.mtcRefusedAt === null || now - this.mtcRefusedAt >= MTC_REFUSAL_SPAN_MS) ? 1 : 0;
    if (counted) { this.mtcRefused += 1; this.mtcRefusedAt = now; }
    const timecode = this.carryOn('mtc.sendFailure', counted, this.mtcRefused, clock.midiTransientCode);
    if (dropouts.limit) { this.patch({ underruns }); this.stopForFault(new Error(dropouts.limit)); return; }
    const mtcError = midiError ? this.mtcFailure(midiError, unplugged) : timecode.limit ?? this.state.mtcError;
    if (timecode.limit) this.stopMtcForSong();
    if (audioError && audioError !== this.state.audioError) this.options.error(audioError);
    if (mtcError && mtcError !== this.state.mtcError) this.options.error(mtcError);
    if (unplugged && this.state.mtcPortName) this.mtcRecovery.lost(this.state.mtcPortName);
    // The engine restarts its count on every prepare; keep the song's total here.
    const added = clock.midiInterruptions >= this.engineInterruptions ? clock.midiInterruptions - this.engineInterruptions : clock.midiInterruptions;
    this.engineInterruptions = clock.midiInterruptions;
    const mtcInterruptions = this.state.mtcInterruptions + added;
    if (added) this.options.error(`时间码输出中断（${clock.midiInterruption === -2 ? '音频时钟超过一帧没有更新' : '发送线程迟到超过一帧'}）：迟到的时间码没有补发，已按实际音频位置重新对齐；这首歌共中断 ${mtcInterruptions} 次`);
    this.patch({ status: clock.state === 'empty' ? 'stopped' : clock.state, positionMs: clock.positionMs,
      mtcSent: clock.midiSent, underruns, mtcInterruptions, outputFault: timecode.fault ?? dropouts.fault ?? this.state.outputFault ?? null,
      audioError, mtcError, ...(timecode.limit ? { mtcPortName: null } : {}), gain: clock.gain, analysis: clock.analysis }, clock.qpc100ns);
  }
  /** Counts `added` new faults of `row` for this song, `total` being the song's count with them: the red text of the
   * last one carried on from, and the limit text once the limit is reached. Each is logged. */
  private carryOn(row: 'audio.underrun' | 'mtc.sendFailure', added: number, total: number, code?: number): { fault: string | null; limit: string | null } {
    let fault: string | null = null;
    for (let index = 0; index < added; index++) {
      const result = this.recovery.record(row, 'song', Date.now()), count = total - added + index + 1;
      const message = result.outcome === 'limit' ? result.limitText : carriedOnText(row, count, code);
      if (this.state) this.options.recovery?.({ result, message, itemId: this.state.itemId, positionMs: this.state.positionMs, ...(code === undefined ? {} : { code }) });
      if (result.outcome === 'limit') return { fault, limit: result.limitText };
      fault = message;
    }
    return { fault, limit: null };
  }
  /** The timecode reached its limit: the engine lets the port go, this song sends no more timecode, music and picture go on. */
  private stopMtcForSong(): void {
    // A pause or seek meanwhile does not cancel it (a seek prepares without timecode, as mtcError says); a new song does.
    const source = this.source;
    const operation = this.pending.then(async () => {
      if (source !== this.source || this.closing || !this.client) return;
      await this.send({ kind: 'stop-mtc' }); this.releaseMtc();
    });
    this.pending = operation.catch((error: unknown) => this.options.error(`停止时间码失败：${error instanceof Error ? error.message : String(error)}`));
  }
  private mtcFailure(code: number, unplugged: boolean): string {
    const port = this.state?.mtcPortName ? `MIDI 接口「${this.state.mtcPortName}」` : 'MIDI 时间码接口';
    if (midiPortBusy(code)) {
      const others = (this.mtcHold?.claim?.others() ?? []).filter(owner => owner !== '时间码' && owner !== '接口检查');
      if (others.length && this.state?.mtcPortName) return sharedPortMessage(this.state.mtcPortName, '时间码', others);
      return `${port}正被其他软件占用（错误码 ${code}），时间码没有发出。请关闭 P1 等正在使用它的软件后重新播放。`;
    }
    if (unplugged) return `${port}断开了（错误码 ${code}）。插回同一个接口后，时间码会自动接着发。`;
    // 2: the index no longer names this port (an interface was plugged in or out just now); nothing was sent elsewhere.
    if (code === 2) return `${port}在打开时找不到了，可能刚好有 MIDI 设备插拔，时间码没有发出，也没有发到别的接口。请重新播放这首歌。`;
    return `${port}发时间码失败（Windows 错误 ${code}）。请重新插拔接口后重新播放。`;
  }
  private fail(error: Error): void {
    this.stopRecovery(); this.options.error(error.message); if (this.state) this.patch({ status: 'error', audioError: error.message });
  }
  private patch(patch: Partial<NativePlayerStatus>, qpc100ns: string | null = null): void { if (this.state) { this.state = { ...this.state, ...patch }; this.publish(qpc100ns); } }
  private publish(qpc100ns: string | null = null): void { if (this.state) this.options.changed(nativePlayerStatusSchema.parse(this.state), qpc100ns); }
}

/** How many the engine counted since `last`; it restarts its counts on every prepare. */
function newCount(now: number, last: number): number { return now >= last ? now - last : now; }

/** Refused timecode sends within this long of the one last counted are the same failure. The engine tries again every
 * millisecond, so one busy moment of the interface is many refused sends: counted one by one, a few milliseconds would
 * use up the song's whole limit. A port that keeps refusing is counted again each time this passes, so it still
 * reaches the limit. This says what one failure is; how many a song may have is in output-recovery.ts. */
const MTC_REFUSAL_SPAN_MS = 1000;

/** The red text of a fault the song carried on from: what happened, then what to do. */
function carriedOnText(row: 'audio.underrun' | 'mtc.sendFailure', count: number, code?: number): string {
  return row === 'audio.underrun'
    ? `声卡断了一下，音乐接着放（这首歌第 ${count} 次）。经常出现时请关掉占用电脑的程序，或换一个声卡输出`
    : `时间码没发出去${code === undefined ? '' : `（Windows 错误码 ${code}）`}，已从当前位置接着发（这首歌第 ${count} 次）。经常出现时请检查 MIDI 接口和线`;
}

/** E_INVALIDARG on prepare means the engine refused the range it was given; say which range, for the log and the operator. */
function explainRange(error: unknown, startMs: number, endMs: number, lease: NativeAudioLease): Error {
  if (!(error instanceof NativeEngineRejection) || error.code !== -2147024809) return error instanceof Error ? error : new Error(String(error));
  return new Error(rangeRejectedMessage({ startMs, endMs, availableMs: lease.availableMs, streaming: lease.streaming, code: error.code }), { cause: error });
}
