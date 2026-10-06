import { MidiProgramSession } from '@tb/core/link';
import type { IntegrationProfile, LinkProject, NativePlayerControl, NativePlayerStatus } from '@tb/schema';
import { NativeMidiPorts } from './native-midi-ports';

type Identity = Pick<NativePlayerStatus, 'sessionId' | 'generation' | 'itemId'>;
export type NativeMidiChannelState = Identity & { state: 'preparing' | 'ready' | 'running' | 'stopped' | 'failed'; reason: string | null;
  currentCueId: string | null };
type Ports = Pick<NativeMidiPorts, 'prepare' | 'send' | 'close'>;
type Dependencies = {
  audio(): NativePlayerStatus | null;
  profile(): IntegrationProfile | null;
  executable: string;
  authorize(): Promise<void>;
  changed(state: NativeMidiChannelState): void;
  error(message: string): void;
  now?: () => number;
  ports?: (failed: (error: Error) => void) => Ports;
};
type Entry = { identity: Identity; session: MidiProgramSession; state: NativeMidiChannelState };

/** Program-owned generic MIDI. Receives only NativePlayerService observations,
 * never renderer positions or an independent playback timer. */
export class NativeMidiHost {
  private entry: Entry | null = null;
  private epoch = 0;
  private stopped: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => Number(process.hrtime.bigint()) / 1e6);
  }
  get status(): NativeMidiChannelState | null { return this.entry?.state ?? null; }

  async prepare(project: LinkProject, identity: Identity): Promise<void> {
    this.admit(identity);
    const stopped = this.stop(), epoch = this.epoch;
    await stopped;
    if (epoch !== this.epoch) throw new Error('后台 MIDI 准备已被更新操作取消');
    const audio = this.admit(identity);
    const failed = (error: Error) => {
      if (this.entry?.identity === identity) this.entry.session.abort(error.message);
      else this.dependencies.error(`旧 MIDI 会话：${error.message}`);
    };
    const ports = this.dependencies.ports?.(failed) ?? new NativeMidiPorts(this.dependencies.profile(), {
      executable: this.dependencies.executable, authorize: () => this.dependencies.authorize(), failed
    });
    const session = new MidiProgramSession(project, identity.itemId, {
      prepare: (ids, signal) => ports.prepare(ids, signal), send: (id, bytes, deadline) => ports.send(id, bytes, deadline),
      close: () => ports.close(), now: this.now,
      sent: cueId => { if (this.entry?.session === session) this.patch({ currentCueId: cueId }); },
      failed: error => {
        this.dependencies.error(error.message);
        if (this.entry?.session === session) this.patch({ state: 'failed', reason: error.message });
      }
    });
    const state: NativeMidiChannelState = { ...identity, state: 'preparing', reason: null, currentCueId: null };
    const entry: Entry = { identity, session, state }; this.entry = entry; this.dependencies.changed(state);
    try {
      await session.prepare(audio.positionMs);
      if (epoch !== this.epoch || this.entry !== entry) throw new Error('后台 MIDI 准备已取消');
      this.admit(identity);
      if (session.error) throw session.error;
      this.patch({ state: 'ready' });
    } catch (error) {
      if (this.entry === entry) this.patch({ state: 'failed', reason: toError(error).message });
      try { await session.close(); } catch (cleanup) { this.dependencies.error(`MIDI 准备取消后的关闭失败：${toError(cleanup).message}`); }
      throw error;
    }
  }

  observe(audio: NativePlayerStatus, qpc100ns: string | null): void {
    const entry = this.entry;
    if (!entry || entry.state.state === 'stopped' || entry.state.state === 'failed') return;
    if (audio.sessionId !== entry.identity.sessionId || audio.itemId !== entry.identity.itemId) {
      const current = this.dependencies.audio();
      if (current?.sessionId === entry.identity.sessionId && current.itemId === entry.identity.itemId) return;
      this.stopReported(); return;
    }
    if (audio.generation < entry.state.generation) return;
    if (audio.status === 'error' || audio.audioError || audio.status === 'stopped' || audio.status === 'preparing') { this.stopReported(); return; }
    if (entry.state.state === 'preparing') {
      if (audio.generation !== entry.identity.generation || !['ready', 'paused'].includes(audio.status)) {
        entry.session.abort('MIDI 准备完成前音频已改变；本轮未参与，不中途补发');
      }
      return;
    }
    if (audio.generation > entry.state.generation) this.patch({ generation: audio.generation });
    if (audio.status === 'paused') { if (entry.state.state === 'running') this.stopReported(); return; }
    if (audio.status !== 'playing' && audio.status !== 'ended' || !qpc100ns || qpc100ns === '0') return;
    entry.session.clock(audio.positionMs, Number(qpc100ns) / 10000);
    if (!entry.session.error && entry.state.state !== 'running') this.patch({ state: 'running' });
  }

  interrupt(request: NativePlayerControl): void {
    const entry = this.entry;
    if (!entry || request.sessionId !== entry.identity.sessionId || request.generation < entry.state.generation) return;
    if (request.kind === 'stop' || request.kind === 'pause' || request.kind === 'seek') this.stopReported();
  }

  stop(): Promise<void> {
    this.epoch++;
    const entry = this.entry; this.entry = null;
    if (entry) {
      this.dependencies.changed({ ...entry.state, state: entry.state.state === 'failed' ? 'failed' : 'stopped' });
      this.stopped = entry.session.close();
    }
    return this.stopped;
  }

  private admit(identity: Identity): NativePlayerStatus {
    const audio = this.dependencies.audio();
    if (!audio || audio.sessionId !== identity.sessionId || audio.generation !== identity.generation || audio.itemId !== identity.itemId
      || !['ready', 'paused'].includes(audio.status) || audio.audioError) throw new Error('MIDI 准备不属于当前待播放的音频会话');
    return audio;
  }
  private patch(patch: Partial<NativeMidiChannelState>): void {
    if (!this.entry) return;
    this.entry.state = { ...this.entry.state, ...patch }; this.dependencies.changed(this.entry.state);
  }
  private stopReported(): void { void this.stop().catch(error => this.dependencies.error(`后台 MIDI 关闭失败：${toError(error).message}`)); }
}

function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
