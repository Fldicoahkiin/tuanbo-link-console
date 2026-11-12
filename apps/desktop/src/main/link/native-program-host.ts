import { NativeProgramPlayer, type InternalPlayerDependencies, type InternalPlayerState, type LinkDesktopApi, type ProgramClock, type ProgramLightingOutput,
  type ProgramNextApi } from '@tb/core/link';
import type { LinkProject, NativeObsRetarget, NativePlayerControl, NativePlayerStatus } from '@tb/schema';
import { NativeMidiHost, type ActionMidiRecovery, type NativeMidiChannelState } from './native-midi-host';
import type { MidiClaim, MidiClaimOwner } from './midi-port-broker';

type AudioApi = Pick<LinkDesktopApi, 'prepareNativePlayback' | 'controlNativePlayback' | 'getNativePlaybackDevices'
  | 'prepareNativeObs' | 'stopNativeObs' | 'onNativeObsStatus' | 'preloadNativeObs' | 'cancelNativeObsPreload'> & ProgramNextApi;
type Dependencies = {
  executable: string;
  api: AudioApi;
  /** The application's one lights-off ledger (LightingOffService): the console runs the lighting from the timecode, and
   * this switches off the executors a stop or a song change lets go (design 01 R13). */
  lighting: ProgramLightingOutput;
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
  /** A newer version of the held song's picture plan, for its picture session (0.5.9 R9, NativeObsRequests.retarget). */
  retargetPicture?(request: NativeObsRetarget): void;
  notice(message: string, itemId: string | null): void;
  /** A failure no window sees in the player's state (the lights-off a stop owed): after the program closed, or while it
   * plays on without a window. NativeProgramService passes it to closedProgramFaultReporter, which logs it as an error
   * and shows it in red, in the window or in the next window that opens a program. `leftOpen`: the action MIDI did not
   * close as the program closed; the quit does not ask about it (InternalPlayerDependencies.closedFault). */
  closedFault(message: string, itemId: string | null, kind?: 'leftOpen'): void;
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
      prepare: async (itemId, positionMs, { signal, pass }) => {
        const audio = dependencies.audio();
        if (!audio || audio.itemId !== itemId || audio.positionMs !== positionMs) throw new Error('MIDI 准备的起点和当前音频对不上');
        const cancelled = () => { void this.midi.stop().catch(cleanup => error(`取消 MIDI 准备失败：${String(cleanup)}`)); };
        if (signal?.aborted) throw new Error('MIDI 准备已取消');
        signal?.addEventListener('abort', cancelled, { once: true });
        try {
          // The version whose actions the song sends, not the one this host was built with (0.5.9 S7: the program stays
          // open while the window edits; S8b: a held song's actions follow a newer version, also as it plays on).
          await this.midi.prepare(this.controller.actionsProject(), { sessionId: audio.sessionId, generation: audio.generation, itemId }, pass);
          if (signal?.aborted || this.disposed) throw new Error('MIDI 准备已取消');
        } finally { signal?.removeEventListener('abort', cancelled); }
      },
      // MIDI observes the exact native QPC below, independently of the UI-facing
      // controller's coalesced state ingestion. This is not another sender.
      ingest: () => Promise.resolve(), pause: () => this.midi.stop(), stop: () => this.midi.stop(),
      retargetActions: (project, itemId) => this.midi.retarget(project, itemId),
      resolveAudio: () => Promise.reject(new Error('后台节目宿主不使用浏览器音源地址')),
      configuration: () => dependencies.configuration(), preciseSeeking: () => dependencies.preciseSeeking(),
      changed: state => dependencies.changed(state), notice: (message, itemId) => dependencies.notice(message, itemId),
      closedFault: (message, itemId, kind) => dependencies.closedFault(message, itemId, kind),
      obsChanged: state => dependencies.obsChanged?.(state)
    }, {
      ...dependencies.api,
      controlNativePlayback: request => { this.interrupt(request); return dependencies.api.controlNativePlayback(request); },
      onNativePlaybackStatus: listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    }, dependencies.lighting, dependencies.retargetPicture ? { retarget: ({ revision, snapshot }) => {
      // The picture session of this program's song; answered by its status (`appliedRevision`).
      const audio = dependencies.audio();
      try {
        if (!audio) throw new Error('这首歌已经停了');
        dependencies.retargetPicture?.({ version: 1, sessionId: audio.sessionId, revision, snapshot });
      } catch (failure) { error(`这次修改的画面没能用上，画面照原来的播：${failure instanceof Error ? failure.message : String(failure)}`); }
    } } : undefined);
  }

  /** `status` feeds this host's own player; the outputs read only `clock`, made from it (`clockFromNativeStatus`). */
  observe(status: NativePlayerStatus, clock: ProgramClock): void {
    if (this.disposed) return;
    this.midi.observe(clock);
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
