import { nativePlayerControlSchema, nativePlayerPrepareSchema, nativePlayerStatusSchema,
  type NativePlayerControl, type NativePlayerPrepare, type NativePlayerStatus, type NativePlaybackEvent, type NativeDeviceQueryRequest } from '@tb/schema';
import { NativeAudioCache, type NativeAudioLease } from './native-audio-cache';
import { NativePlaybackClient } from './native-playback-client';
import { NativeDeviceQuery } from './native-device-query';
import { basename } from 'node:path';
import { NativeAudioPreload } from './native-audio-preload';

type Clock = Extract<NativePlaybackEvent, { kind: 'clock' }>;
type Options = {
  executable: string; cache: Pick<NativeAudioCache, 'prepare'>;
  checkDeviceHealth: () => Promise<void>;
  resolveAudio: (projectPath: string, relativePath: string) => string;
  changed: (status: NativePlayerStatus, qpc100ns: string | null) => void;
  error: (message: string) => void;
  measured?: (phase: string, elapsedMs: number) => void;
  beforeControl?: (request: NativePlayerControl) => void;
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
  private epoch = 0;
  private nativeGeneration = 0;
  private requestId = 0;
  private closing = false;
  private volume = 1;
  private engineInterruptions = 0;
  private readonly preload: NativeAudioPreload;
  private readonly deviceQuery: NativeDeviceQuery;
  private readonly audioDeviceQuery: NativeDeviceQuery;
  constructor(private readonly options: Options) {
    this.preload = new NativeAudioPreload(options);
    this.deviceQuery = new NativeDeviceQuery(options.executable);
    this.audioDeviceQuery = new NativeDeviceQuery(options.executable, 'audio');
  }

  get status(): NativePlayerStatus | null { return this.state; }
  get audioCaptureIdentity(): { executable: string; title: string; windowClass: string; audioDeviceId: string } {
    const identity = this.client?.identity;
    if (!identity || !this.source || !this.state || !['ready', 'playing', 'paused', 'ended'].includes(this.state.status)
      || identity.pid !== this.state.enginePid || identity.title !== this.state.engineTitle) {
      throw new Error('正式音频进程尚未准备，无法确认 OBS 采集目标');
    }
    return { executable: basename(this.options.executable), title: identity.title, windowClass: identity.windowClass, audioDeviceId: this.source.audioDeviceId };
  }
  async devices(scope: NativeDeviceQueryRequest['scope'] = 'all') {
    if (this.closing) throw new Error('正式音频服务正在关闭');
    // The native inventory enumerates WinMM as well as WASAPI. Do not start a
    // helper that cannot consume its shutdown request when WinMM is unhealthy.
    if (scope === 'all') await this.options.checkDeviceHealth();
    if (this.closing) throw new Error('正式音频服务正在关闭');
    return (scope === 'audio' ? this.audioDeviceQuery : this.deviceQuery).read();
  }

  prepare(input: NativePlayerPrepare): Promise<NativePlayerStatus> {
    const request = nativePlayerPrepareSchema.parse(input);
    if (this.closing) return Promise.reject(new Error('正式音频服务正在关闭'));
    if (this.queued >= 32) return Promise.reject(new Error('音频控制队列已满；本次操作未入队'));
    if (request.sessionId === this.state?.sessionId && request.generation <= this.state.generation) return Promise.reject(new Error('播放准备属于旧会话代数'));
    const failedClient = this.state?.status === 'error' ? this.client : null;
    const epoch = ++this.epoch;
    this.abort?.abort();
    const abort = new AbortController(); this.abort = abort;
    this.source = request;
    this.volume = request.snapshot.volume;
    this.state = { version: 1, sessionId: request.sessionId, generation: request.generation,
      itemId: request.snapshot.itemId, status: 'preparing', positionMs: request.snapshot.positionMs, offsetMs: request.snapshot.offsetMs,
      sampleRate: request.snapshot.sampleRate, enginePid: null, engineTitle: null, mtcPortName: null, mtcSent: 0,
      audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: request.snapshot.volume, analysis: null };
    this.publish();
    const operation = this.pending.then(async () => {
      let measuredAt = performance.now();
      const measured = (phase: string): void => { const now = performance.now(); this.options.measured?.(phase, now - measuredAt); measuredAt = now; };
      this.requireEpoch(epoch);
      if (failedClient && this.client === failedClient) { await failedClient.close(); this.client = null; }
      this.requireEpoch(epoch);
      if (this.client) await this.send({ kind: 'stop' });
      this.requireEpoch(epoch);
      await this.releaseLease();
      const scope = request.midiPortName || request.autoDetectMtc ? 'all' : 'audio';
      await (scope === 'audio' ? this.audioDeviceQuery : this.deviceQuery).reopenForPreparation();
      this.requireEpoch(epoch);
      const devices = await this.devices(scope);
      measured('设备检查与旧播放清理');
      this.requireEpoch(epoch);
      if (request.audioDeviceId !== 'default' && !devices.audio.some(device => device.id === request.audioDeviceId)) throw new Error('选择的正式音频输出已断开；不会自动切换线路');
      if (request.audioDeviceId === 'default' && !devices.audio.some(device => device.isDefault)) throw new Error('Windows 默认音频输出不可用');
      const midi = request.midiPortName ? devices.midiOutputs.filter(device => device.name === request.midiPortName)
        : request.autoDetectMtc ? devices.midiOutputs.filter(device => !/Microsoft GS Wavetable Synth/i.test(device.name)) : [];
      const midiDevice = midi.length === 1 ? midi[0]!.id : null;
      if ((request.midiPortName || request.autoDetectMtc) && midiDevice === null) this.patch({ mtcError: midi.length > 1 ? '多个 MIDI 输出无法唯一识别，请选定控台端口' : '选择的 MIDI 时间码输出未连接' });
      const warmed = await this.preload.take(request.projectPath, request.snapshot);
      if (epoch !== this.epoch) { await warmed?.release(); throw new Error('音频准备已取消'); }
      const lease = warmed ?? await this.options.cache.prepare({ sourcePath: this.options.resolveAudio(request.projectPath, request.snapshot.audio.relativePath),
        sourceSha256: request.snapshot.audio.sha256, expectedDurationMs: request.snapshot.audio.durationMs,
        sampleRate: request.snapshot.sampleRate, positionMs: request.snapshot.positionMs }, abort.signal);
      measured('音源校验与解码预填充');
      if (epoch !== this.epoch) { await lease.release(); throw new Error('音频准备已取消'); }
      this.attachLease(lease);
      if (lease.durationMs + 1 < request.snapshot.endMs) throw new Error('实际解码音频短于节目播放范围');
      if (!this.client) {
        const client = new NativePlaybackClient(this.options.executable, event => {
          if (this.client === client && event.kind === 'clock') this.receive(event);
        }, error => { if (this.client === client) this.fail(error); });
        this.client = client; await client.start();
      }
      measured('原生进程准备');
      this.requireEpoch(epoch);
      const snapshot = request.snapshot;
      await this.client.command({ protocol: 4, requestId: ++this.requestId, generation: ++this.nativeGeneration, kind: 'prepare',
        pcmPath: lease.path, pcmBaseMs: lease.baseMs, streaming: lease.streaming, audioDeviceId: request.audioDeviceId, sampleRate: snapshot.sampleRate, frameRate: snapshot.frameRate,
        midiDevice, startMs: snapshot.positionMs, endMs: snapshot.endMs, offsetMs: snapshot.offsetMs, volume: snapshot.volume });
      const clock = await this.client.readClock(this.nativeGeneration);
      measured('音频设备与时钟准备');
      this.requireEpoch(epoch);
      if (clock.audioError || clock.state === 'error') throw new Error(`Windows 音频准备失败：${clock.audioError}`);
      this.patch({ status: 'ready', enginePid: this.client.identity!.pid, engineTitle: this.client.identity!.title,
        mtcPortName: midiDevice === null ? null : midi[0]!.name });
      this.receive(clock);
    });
    return this.finish(operation, epoch);
  }

  control(input: NativePlayerControl): Promise<NativePlayerStatus> {
    const request = nativePlayerControlSchema.parse(input);
    const state = this.state;
    if (!state || request.sessionId !== state.sessionId || request.generation < state.generation) return Promise.reject(new Error('播放控制属于已失效会话'));
    if (this.closing) return Promise.reject(new Error('正式音频服务正在关闭'));
    if (request.kind === 'stop' && this.stopping?.epoch === this.epoch && this.stopping.sessionId === request.sessionId) {
      this.patch({ generation: request.generation }); return this.stopping.task;
    }
    if (request.kind !== 'stop' && this.queued >= 32) return Promise.reject(new Error('音频控制队列已满；本次操作未入队'));
    if (request.kind !== 'stop' && (state.status === 'error' || state.status === 'stopped' || state.status === 'preparing' || !this.lease)) return Promise.reject(new Error('正式音频尚未准备或已停止，请重新准备节目'));
    if (request.kind === 'seek' && (!this.source || request.positionMs < this.source.snapshot.startMs || request.positionMs >= this.source.snapshot.endMs)) return Promise.reject(new Error('定位超出节目裁剪范围'));
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
        if (request.kind !== 'stop') throw new Error('正式音频引擎尚未准备');
      } else {
        if (request.kind === 'seek') {
          // Decode from the requested source position, never wait for hours of
          // preceding PCM or change the original source/timecode coordinates.
          const snapshot = this.source!.snapshot;
          const midiDevice = await this.resolveMidi(epoch);
          this.requireEpoch(epoch);
          await this.send({ kind: 'stop' }); await this.preload.cancel(); await this.releaseLease(); this.requireEpoch(epoch);
          const lease = await this.options.cache.prepare({ sourcePath: this.options.resolveAudio(this.source!.projectPath, snapshot.audio.relativePath),
            sourceSha256: snapshot.audio.sha256, expectedDurationMs: snapshot.audio.durationMs,
            sampleRate: snapshot.sampleRate, positionMs: request.positionMs }, signal!);
          if (epoch !== this.epoch) { await lease.release(); throw new Error('音频定位已取消'); }
          this.attachLease(lease);
          await this.client.command({ protocol: 4, requestId: ++this.requestId, generation: ++this.nativeGeneration, kind: 'prepare',
            pcmPath: lease.path, pcmBaseMs: lease.baseMs, streaming: lease.streaming, audioDeviceId: this.source!.audioDeviceId, sampleRate: snapshot.sampleRate, frameRate: snapshot.frameRate,
            midiDevice, startMs: request.positionMs, endMs: snapshot.endMs, offsetMs: snapshot.offsetMs, volume: this.volume });
          this.requireEpoch(epoch);
          await this.send({ kind: 'pause' });
        } else await this.send(request);
        if (request.kind !== 'volume') {
          const clock = await this.client.readClock(this.nativeGeneration);
          this.requireEpoch(epoch);
          if (clock.audioError || clock.state === 'error') throw new Error(`Windows 音频控制失败：${clock.audioError}`);
          this.receive(clock);
        }
      }
      this.requireEpoch(epoch);
      if (request.kind === 'volume') this.volume = request.volume;
      if (request.kind === 'stop-mtc') this.patch({ mtcPortName: null });
      if (request.kind === 'stop') { this.patch({ status: 'stopped' }); await this.preload.cancel(); await this.releaseLease(); }
      if (request.kind === 'play' && this.source?.nextSnapshot) this.preload.start(this.source.projectPath, this.source.nextSnapshot);
    });
    const result = this.finish(operation, epoch);
    if (request.kind !== 'stop') return result;
    const task = result.finally(() => { if (this.stopping?.task === task) this.stopping = null; });
    this.stopping = { epoch, sessionId: request.sessionId, task }; return task;
  }

  async close(): Promise<void> {
    this.closing = true; ++this.epoch; this.abort?.abort();
    await this.pending;
    const client = this.client;
    try { await Promise.all([client?.close(), this.deviceQuery.close(), this.audioDeviceQuery.close()]); }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); throw error; }
    this.client = null; await this.preload.cancel(); await this.releaseLease();
    if (this.state) this.patch({ status: 'stopped', enginePid: null, engineTitle: null });
  }

  private async releaseLease(): Promise<void> {
    const lease = this.lease; this.lease = null; await lease?.release();
  }
  private attachLease(lease: NativeAudioLease): void {
    this.lease = lease;
    void lease.completion.then(result => {
      if (result.ok || this.lease !== lease || this.closing) return;
      // Decoder failure is an audio-clock failure. Stop MIDI/audio and invalidate
      // any in-flight prepare before reporting a usable next session.
      ++this.epoch; this.abort?.abort(); this.fail(result.error);
      const cleanup = this.pending.then(async () => {
        if (this.lease !== lease) return;
        if (this.client) await this.send({ kind: 'stop' });
        await this.releaseLease();
      });
      this.pending = cleanup.catch(error => this.fail(error instanceof Error ? error : new Error(String(error))));
    });
  }
  private async resolveMidi(epoch: number): Promise<number | null> {
    if (!this.state?.mtcPortName || this.state.mtcError) return null;
    const name = this.state.mtcPortName, devices = await this.devices();
    this.requireEpoch(epoch);
    const ports = devices.midiOutputs.filter(port => port.name === name);
    if (ports.length !== 1) {
      const message = 'MIDI 时间码目标已改变；该通道停止，音频继续。请明确重新准备节目后恢复时间码';
      this.patch({ mtcPortName: null, mtcError: message }); this.options.error(message);
      return null;
    }
    return ports[0]!.id;
  }
  private send(command: { kind: 'play' | 'pause' | 'stop' | 'stop-mtc' } | { kind: 'volume'; volume: number; durationMs?: number | undefined }): Promise<void> {
    if (!this.client) return Promise.reject(new Error('正式音频引擎尚未准备'));
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
    const audioError = clock.audioError ? `Windows 音频输出失败：${clock.audioError}` : this.state.audioError;
    const mtcError = clock.midiError ? `Windows MIDI 输出失败${this.state.mtcPortName ? `（${this.state.mtcPortName}）` : ''}：${clock.midiError === 4 ? '端口资源已被占用（错误码 4）；请完全退出 P1 等使用该接口的软件后手动重新播放' : `错误码 ${clock.midiError}，请检查接口和驱动后手动重新播放`}` : this.state.mtcError;
    if (audioError && audioError !== this.state.audioError) this.options.error(audioError);
    if (mtcError && mtcError !== this.state.mtcError) this.options.error(mtcError);
    // The engine restarts its count on every prepare; keep the song's total here.
    const added = clock.midiInterruptions >= this.engineInterruptions ? clock.midiInterruptions - this.engineInterruptions : clock.midiInterruptions;
    this.engineInterruptions = clock.midiInterruptions;
    const mtcInterruptions = this.state.mtcInterruptions + added;
    if (added) this.options.error(`时间码输出中断（${clock.midiInterruption === -2 ? '音频时钟超过一帧未更新' : '发送线程迟到超过一帧'}），迟到的时间码未补发，已按实际音频位置用整帧重新同步；本首共 ${mtcInterruptions} 次`);
    this.patch({ status: clock.state === 'empty' ? 'stopped' : clock.state, positionMs: clock.positionMs,
      mtcSent: clock.midiSent, underruns: clock.underruns, mtcInterruptions,
      audioError, mtcError, gain: clock.gain, analysis: clock.analysis }, clock.qpc100ns);
  }
  private fail(error: Error): void {
    this.options.error(error.message); if (this.state) this.patch({ status: 'error', audioError: error.message });
  }
  private patch(patch: Partial<NativePlayerStatus>, qpc100ns: string | null = null): void { if (this.state) { this.state = { ...this.state, ...patch }; this.publish(qpc100ns); } }
  private publish(qpc100ns: string | null = null): void { if (this.state) this.options.changed(nativePlayerStatusSchema.parse(this.state), qpc100ns); }
}
