import { mkdir, open, unlink, statfs } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { LightingTempoMap } from '@tb/core/link';
import type { MusicMonitorRequest, MusicMonitorStatus } from '@tb/schema';
import { NativeAudioCache, type NativeAudioLease } from './native-audio-cache';
import { NativePlaybackClient, readNativePlaybackDevices } from './native-playback-client';
import type { LinkProjectService } from './link-project-service';
import type { ObsWebSocketAdapter } from './obs-websocket-adapter';

/** Separate WASAPI process, no MIDI device, no formal playback service or OBS mutations. */
export class MusicMonitorService {
  private current: { client: NativePlaybackClient; abort: AbortController; lease: NativeAudioLease | null; file: string | null; producer: Promise<void> | null; unsubscribe: () => void } | null = null;
  private pending: Promise<void> = Promise.resolve();
  private starting = false;
  private generation = 0;
  private sessionId: string | null = null;
  constructor(private readonly executable: string, private readonly projects: Pick<LinkProjectService,'resolveReferenceAudio'>, private readonly obs: Pick<ObsWebSocketAdapter,'assertMusicMonitorIsolation'|'subscribeMusicMonitorRouteChange'>, private readonly report: (error: Error) => void, private readonly changed: (status: MusicMonitorStatus) => void) {}
  async start(request: MusicMonitorRequest): Promise<MusicMonitorStatus> {
    if (this.starting) throw new Error('监听正在准备，请等待或停止');
    this.starting = true;
    try { return await this.prepare(request); } finally { this.starting = false; }
  }
  private async prepare(request: MusicMonitorRequest): Promise<MusicMonitorStatus> {
    await this.stop();
    const generation = this.generation;
    const devices = await readNativePlaybackDevices(this.executable); const device = devices.audio.find(value => value.id === request.deviceId);
    if (generation !== this.generation) throw new Error('监听已取消');
    if (!device) throw new Error('监听设备已断开，不自动切换设备');
    this.sessionId = request.sessionId;
    this.changed({ version: 1, sessionId: request.sessionId, state: 'preparing', message: '正在核对监听线路' });
    const abort = new AbortController();
    const stopOnFailure = (error: Error): void => { if (generation !== this.generation) return; this.report(error); this.changed({ version: 1, sessionId: request.sessionId, state: 'error', message: error.message }); void this.stop(false).catch(this.report); };
    const client = new NativePlaybackClient(this.executable, event => { if (event.kind !== 'clock') return; if (event.audioError || event.state === 'error') stopOnFailure(new Error('监听音频输出失败，已停止')); else if (event.state === 'ended' && generation === this.generation) void this.stop().catch(this.report); }, stopOnFailure);
    const state = { client, abort, lease: null as NativeAudioLease | null, file: null as string | null, producer: null as Promise<void> | null, unsubscribe: () => {} }; this.current = state;
    try {
      await client.start();
      const identity = client.identity; if (!identity) throw new Error('监听进程身份未确认');
      await this.obs.assertMusicMonitorIsolation(device.id, device.isDefault, { executable: basename(this.executable), title: identity.title, windowClass: identity.windowClass, ownerExecutable: basename(process.execPath) });
      state.unsubscribe = this.obs.subscribeMusicMonitorRouteChange(() => stopOnFailure(new Error('OBS 音频线路已变化，监听已停止，请重新核对后试听')));
      const directory = join(dirname(request.projectPath), 'cache', 'music-monitor'); await mkdir(directory, { recursive: true });
      let pcmPath: string; let pcmBaseMs: number; let streaming: boolean;
      if (request.mode === 'segment') {
        if (!ffmpegPath) throw new Error('音频解码组件缺失');
        const cache = new NativeAudioCache(directory, ffmpegPath.replace('app.asar', 'app.asar.unpacked'));
        state.lease = await cache.prepare({ sourcePath: this.projects.resolveReferenceAudio(request.projectPath, request.source.relativePath), sourceSha256: request.source.sha256, expectedDurationMs: request.source.durationMs, sampleRate: 48000, positionMs: request.startMs }, abort.signal);
        pcmPath = state.lease.path; pcmBaseMs = state.lease.baseMs; streaming = state.lease.streaming;
      } else {
        pcmPath = join(directory, `${request.sessionId}.pcm`); state.file = pcmPath; pcmBaseMs = request.startMs; streaming = true;
        let readyResolve: () => void = () => {}; let readyReject: (error: unknown) => void = () => {};
        const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        state.producer = writeMetronome(pcmPath, request, abort.signal, readyResolve).catch(error => { readyReject(error); if (!abort.signal.aborted) stopOnFailure(error instanceof Error ? error : new Error(String(error))); });
        await ready;
      }
      if (abort.signal.aborted || this.current !== state) throw new Error('监听已取消');
      await client.command({ protocol: 4, requestId: 1, generation: 1, kind: 'prepare', pcmPath, pcmBaseMs, streaming, audioDeviceId: device.id, sampleRate: 48000, frameRate: 30, midiDevice: null, startMs: request.startMs, endMs: request.endMs, offsetMs: 0, volume: request.volume });
      if (abort.signal.aborted) throw new Error('监听已取消');
      await client.command({ protocol: 4, requestId: 2, generation: 1, kind: 'play' });
      if (abort.signal.aborted || this.current !== state) throw new Error('监听已取消');
      const status: MusicMonitorStatus = { version: 1, sessionId: request.sessionId, state: 'playing', message: '独立监听中', pid: identity.pid, title: identity.title };
      this.changed(status); return status;
    } catch (error) { await this.stop(); throw error; }
  }
  stop(notify = true): Promise<void> {
    this.generation++;
    const sessionId = this.sessionId; this.sessionId = null;
    const state = this.current; this.current = null;
    if (!state) return this.pending;
    state.abort.abort(); state.unsubscribe();
    const close = this.pending.then(async () => { await state.client.close(); await state.producer; await state.lease?.release(); if (state.file) { try { await unlink(state.file); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; } } if (notify && sessionId) this.changed({ version: 1, sessionId, state: 'stopped', message: '' }); });
    this.pending = close.catch(error => { this.report(error instanceof Error ? error : new Error(String(error))); });
    return close;
  }
}

async function writeMetronome(path: string, request: MusicMonitorRequest, signal: AbortSignal, ready: () => void): Promise<void> {
  const map = new LightingTempoMap(request.tempos); const length = request.endMs - request.startMs;
  const available = await statfs(dirname(path)); const bytes = Math.ceil(length * 192);
  if (bytes > available.bavail * available.bsize * .8) throw new Error('监听临时文件所需空间不足；未占用系统临时目录');
  const output = await open(path, 'wx'); const block = Buffer.alloc(48000 * 4);
  let beat = Math.ceil(map.msToBeat(Math.max(0, request.startMs - request.firstBeatMs)));
  let click = request.firstBeatMs + map.beatToMs(beat);
  try {
    for (let elapsed = 0; elapsed < length; elapsed += 1000) {
      if (signal.aborted) throw new Error('监听已取消');
      block.fill(0); const duration = Math.min(1000, length - elapsed); const start = request.startMs + elapsed;
      // Tail from clicks in the preceding block is included without accumulating rounded intervals.
      let currentBeat = Math.max(0, beat - 1); let at = request.firstBeatMs + map.beatToMs(currentBeat);
      while (at < start + duration) {
        const from = Math.max(0, Math.ceil((at - start) * 48)); const to = Math.min(Math.ceil(duration * 48), Math.ceil((at + 15 - start) * 48));
        for (let frame = from; frame < to; frame++) { const seconds = (start + frame / 48 - at) / 1000; const amplitude = Math.sin(seconds * Math.PI * 2 * 1400) * Math.exp(-seconds * 250) * .45; const sample = Math.round(amplitude * 32767); block.writeInt16LE(sample, frame * 4); block.writeInt16LE(sample, frame * 4 + 2); }
        currentBeat++; at = request.firstBeatMs + map.beatToMs(currentBeat);
      }
      beat = currentBeat; click = at;
      await output.writeFile(block.subarray(0, Math.ceil(duration * 48) * 4));
      if (elapsed === 0) ready();
      if (click > request.endMs && elapsed + 1000 >= length) break;
    }
  } finally { await output.close(); }
}
