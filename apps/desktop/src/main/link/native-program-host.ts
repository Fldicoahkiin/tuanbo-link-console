import { NativeProgramPlayer, type InternalPlayerDependencies, type InternalPlayerState, type LinkDesktopApi } from '@tb/core/link';
import type { LinkProject, NativePlayerControl, NativePlayerStatus } from '@tb/schema';
import { NativeMidiHost, type NativeMidiChannelState } from './native-midi-host';
import { NativeLightingOutput } from './native-lighting-output';

type AudioApi = Pick<LinkDesktopApi, 'prepareNativePlayback' | 'controlNativePlayback' | 'getNativePlaybackDevices'
  | 'prepareNativeObs' | 'stopNativeObs' | 'onNativeObsStatus' | 'preloadNativeObs' | 'cancelNativeObsPreload'>;
type Dependencies = {
  executable: string;
  api: AudioApi;
  network: Pick<LinkDesktopApi, 'getMa2NetworkStatus' | 'cancelMa2Playback' | 'playMa2Cue'>;
  audio(): NativePlayerStatus | null;
  authorize(): Promise<void>;
  configuration: InternalPlayerDependencies['configuration'];
  preciseSeeking(): boolean;
  changed(state: InternalPlayerState): void;
  midiChanged(state: NativeMidiChannelState): void;
  obsChanged?(state: import('@tb/schema').NativeObsStatus): void;
  notice(message: string, itemId: string | null): void;
};

/** Complete program transport owner. UI operations call this controller;
 * automatic boundaries, MIDI and direct lighting consume the native device
 * observations in main, even when the renderer is busy or hidden. */
export class NativeProgramHost {
  readonly controller: NativeProgramPlayer;
  private readonly midi: NativeMidiHost;
  private readonly lighting: NativeLightingOutput;
  private readonly listeners = new Set<(status: NativePlayerStatus) => void>();
  private disposed = false;
  private closing: Promise<void> | null = null;
  private lightingSession: { sessionId: string; generation: number; itemId: string; ready: boolean } | null = null;

  constructor(project: LinkProject, path: string, revision: number, private readonly dependencies: Dependencies) {
    const error = (message: string) => this.controller.reportUnavailable(message);
    this.midi = new NativeMidiHost({ audio: () => dependencies.audio(), profile: () => dependencies.configuration().lightingProfile ?? null,
      executable: dependencies.executable, authorize: () => dependencies.authorize(), changed: state => dependencies.midiChanged(state), error });
    this.lighting = new NativeLightingOutput({ executable: dependencies.executable, network: dependencies.network,
      authorize: () => dependencies.authorize(), error });
    this.controller = new NativeProgramPlayer(project, path, revision, {
      prepare: async (itemId, positionMs, { signal }) => {
        const audio = dependencies.audio();
        if (!audio || audio.itemId !== itemId || audio.positionMs !== positionMs) throw new Error('MIDI 准备起点与当前音频不一致');
        const cancelled = () => { void this.midi.stop().catch(cleanup => error(`取消 MIDI 准备失败：${String(cleanup)}`)); };
        if (signal?.aborted) throw new Error('MIDI 准备已取消');
        signal?.addEventListener('abort', cancelled, { once: true });
        try {
          await this.midi.prepare(project, { sessionId: audio.sessionId, generation: audio.generation, itemId });
          if (signal?.aborted || this.disposed) throw new Error('MIDI 准备已取消');
        } finally { signal?.removeEventListener('abort', cancelled); }
      },
      // MIDI observes the exact native QPC below, independently of the UI-facing
      // controller's coalesced state ingestion. This is not another sender.
      ingest: () => Promise.resolve(), pause: () => this.midi.stop(), stop: () => this.midi.stop(),
      resolveAudio: () => Promise.reject(new Error('后台节目宿主不使用浏览器音源地址')),
      configuration: () => dependencies.configuration(), preciseSeeking: () => dependencies.preciseSeeking(),
      changed: state => dependencies.changed(state), notice: (message, itemId) => dependencies.notice(message, itemId),
      obsChanged: state => dependencies.obsChanged?.(state)
    }, {
      ...dependencies.api,
      controlNativePlayback: request => { this.interrupt(request); return dependencies.api.controlNativePlayback(request); },
      onNativePlaybackStatus: listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    }, {
      prepare: async (document, profile, positionMs) => {
        const audio = dependencies.audio();
        if (!audio || !['ready', 'paused'].includes(audio.status) || audio.positionMs !== positionMs) throw new Error('灯光准备不属于当前待播放音频');
        const session = { sessionId: audio.sessionId, generation: audio.generation, itemId: audio.itemId, ready: false };
        this.lightingSession = session;
        await this.lighting.prepare(document, profile, positionMs);
        if (this.lightingSession !== session || this.disposed) throw new Error('灯光准备已取消');
        session.ready = true;
      },
      // Command acknowledgements carry no new device timestamp. Only observe()
      // below may tick lighting; otherwise a slow preparation would look stale
      // as soon as the play command is acknowledged, before the first sample.
      tick: () => undefined,
      finish: positionMs => this.lightingSession?.ready ? this.lighting.finish(positionMs) : Promise.resolve(),
      stop: () => this.stopLighting(), close: () => { this.lightingSession = null; return this.lighting.close(); }
    });
  }

  observe(status: NativePlayerStatus, qpc100ns: string | null): void {
    if (this.disposed) return;
    const lighting = this.lightingSession;
    if (lighting && status.sessionId === lighting.sessionId && status.itemId === lighting.itemId && status.generation >= lighting.generation) {
      lighting.generation = status.generation;
      if (status.audioError || ['stopped', 'error', 'preparing'].includes(status.status)) this.stopLighting();
      else if (!lighting.ready && status.status === 'playing') {
        this.controller.reportUnavailable('灯光准备未赶上音频开始；本轮不参与，不中途补发'); this.stopLighting();
      } else if (qpc100ns && qpc100ns !== '0' && lighting.ready) {
        this.lighting.observe(status.positionMs, Number(qpc100ns) / 10000);
        if (status.status === 'playing') {
          try { this.lighting.tick(status.positionMs); }
          catch (error) { this.controller.reportUnavailable(`灯光动作已停止：${String(error)}`); this.stopLighting(); }
        }
      }
    }
    this.midi.observe(status, qpc100ns);
    for (const listener of this.listeners) listener(status);
  }

  interrupt(request: NativePlayerControl): void {
    this.midi.interrupt(request);
    const lighting = this.lightingSession;
    if (lighting && request.sessionId === lighting.sessionId && request.generation >= lighting.generation
      && ['pause', 'stop', 'seek'].includes(request.kind)) this.stopLighting();
  }

  private stopLighting(): void { this.lightingSession = null; this.lighting.stop(); }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.closing = this.controller.dispose().finally(() => this.listeners.clear());
    return this.closing;
  }
}
