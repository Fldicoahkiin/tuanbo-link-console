import { LightingOutputRelease, NativeProgramPlayer, type InternalPlayerDependencies, type InternalPlayerState, type LinkDesktopApi } from '@tb/core/link';
import type { LinkProject, NativePlayerControl, NativePlayerStatus } from '@tb/schema';
import { NativeMidiHost, type ActionMidiRecovery, type NativeMidiChannelState } from './native-midi-host';
import type { MidiClaim, MidiClaimOwner } from './midi-port-broker';

type AudioApi = Pick<LinkDesktopApi, 'prepareNativePlayback' | 'controlNativePlayback' | 'getNativePlaybackDevices'
  | 'prepareNativeObs' | 'stopNativeObs' | 'onNativeObsStatus' | 'preloadNativeObs' | 'cancelNativeObsPreload'>;
type Dependencies = {
  executable: string;
  api: AudioApi;
  /** Switches the song's executors off when it stops; the console runs the lighting from the timecode. */
  network: Pick<LinkDesktopApi, 'getMa2NetworkStatus' | 'playMa2Cue'>;
  audio(): NativePlayerStatus | null;
  /** Windows MIDI outputs as listed now, checked again when the last listing failed: waits for a lost action MIDI port. */
  midiOutputs(): Promise<readonly { id: number; name: string }[]>;
  authorize(): Promise<void>;
  /** Formal playback takes an output from the editor before opening it. */
  claimMidiOutput?: (portName: string, owner: MidiClaimOwner) => Promise<MidiClaim>;
  configuration: InternalPlayerDependencies['configuration'];
  preciseSeeking(): boolean;
  changed(state: InternalPlayerState): void;
  midiChanged(state: NativeMidiChannelState): void;
  /** The action MIDI port came back: logged with the outage's start, end and skipped actions. */
  midiRecovered(report: ActionMidiRecovery, itemId: string): void;
  obsChanged?(state: import('@tb/schema').NativeObsStatus): void;
  notice(message: string, itemId: string | null): void;
  /** A failure after the program closed, which no player shows any more (the lights-off its stop owed): shown in the
   * window in red and logged as an error. */
  closedFault(message: string, itemId: string | null): void;
};

/** Complete program transport owner. UI operations call this controller;
 * automatic boundaries and action MIDI consume the native device observations
 * in main, even when the renderer is busy or hidden. */
export class NativeProgramHost {
  readonly controller: NativeProgramPlayer;
  private readonly midi: NativeMidiHost;
  private readonly listeners = new Set<(status: NativePlayerStatus) => void>();
  private disposed = false;
  private closing: Promise<void> | null = null;

  constructor(project: LinkProject, path: string, revision: number, private readonly dependencies: Dependencies) {
    const error = (message: string) => this.controller.reportUnavailable(message);
    const claim = dependencies.claimMidiOutput;
    this.midi = new NativeMidiHost({ audio: () => dependencies.audio(), profile: () => dependencies.configuration().lightingProfile ?? null,
      executable: dependencies.executable, authorize: () => dependencies.authorize(), changed: state => dependencies.midiChanged(state), error,
      ...claim ? { claim: (name: string) => claim(name, '动作 MIDI') } : {},
      fault: (message, itemId) => { dependencies.notice(message, itemId); this.controller.reportFault(message); },
      outputs: () => dependencies.midiOutputs(), recovered: (report, itemId) => {
        dependencies.midiRecovered(report, itemId); this.controller.clearFault(report.fault);
        this.controller.reportUnavailable(`动作 MIDI 中断 ${(report.durationMs / 1000).toFixed(1)} 秒后已恢复（${report.portName}）`);
      } });
    this.controller = new NativeProgramPlayer(project, path, revision, {
      prepare: async (itemId, positionMs, { signal }) => {
        const audio = dependencies.audio();
        if (!audio || audio.itemId !== itemId || audio.positionMs !== positionMs) throw new Error('MIDI 准备的起点和当前音频对不上');
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
      closedFault: (message, itemId) => dependencies.closedFault(message, itemId),
      obsChanged: state => dependencies.obsChanged?.(state)
    }, {
      ...dependencies.api,
      controlNativePlayback: request => { this.interrupt(request); return dependencies.api.controlNativePlayback(request); },
      onNativePlaybackStatus: listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    }, new LightingOutputRelease(dependencies.network));
  }

  observe(status: NativePlayerStatus, qpc100ns: string | null): void {
    if (this.disposed) return;
    this.midi.observe(status, qpc100ns);
    for (const listener of this.listeners) listener(status);
  }

  interrupt(request: NativePlayerControl): void { this.midi.interrupt(request); }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.closing = this.controller.dispose().finally(() => this.listeners.clear());
    return this.closing;
  }
}
