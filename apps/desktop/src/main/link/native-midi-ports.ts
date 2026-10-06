import type { IntegrationProfile } from '@tb/schema';
import { NativeMidiOutput, type NativeMidiReceipt } from './native-midi-output';

type Port = { open(name: string): Promise<void>; send(bytes: readonly number[], deadline100ns: bigint): Promise<NativeMidiReceipt>; close(): Promise<void> };
type Dependencies = { executable: string; authorize(): Promise<void>; failed(error: Error): void;
  create?: (failed: (error: Error) => void) => Port };

/** Machine mappings are resolved once per preparation. No project port names,
 * index fallback, automatic reopen, or Web MIDI access participates here. */
export class NativeMidiPorts {
  private readonly byProfile = new Map<string, Port>();
  private readonly owned = new Set<Port>();
  private preparing: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private state: 'new' | 'preparing' | 'ready' | 'closed' = 'new';
  private failure: Error | null = null;
  private readonly cancellation = new AbortController();

  constructor(private readonly profile: Pick<IntegrationProfile, 'midiPortProfiles'> | null, private readonly dependencies: Dependencies) {}

  prepare(ids: readonly string[], signal: AbortSignal): Promise<void> {
    if (this.state !== 'new') return Promise.reject(new Error('MIDI 端口会话已经准备或关闭'));
    this.state = 'preparing';
    const abort = () => { void this.close().catch(error => this.dependencies.failed(toError(error))); };
    const work = async (): Promise<void> => {
      const requireCurrent = () => { if (signal.aborted || this.state === 'closed') throw new Error('MIDI 端口准备已取消'); if (this.failure) throw this.failure; };
      requireCurrent();
      const mappings = [...new Set(ids)].map(id => {
        const matches = this.profile?.midiPortProfiles.filter(entry => entry.id === id && entry.direction === 'output') ?? [];
        if (matches.length !== 1 || !matches[0]?.portName) throw new Error(`MIDI 输出档案不存在或不唯一：${id}`);
        return matches[0];
      });
      if (mappings.length) { await this.authorize(); requireCurrent(); }
      const names = new Map<string, Port>();
      for (const mapping of mappings) {
        requireCurrent();
        let output = names.get(mapping.portName);
        if (!output) {
          const failed = (error: Error) => {
            if (this.state === 'closed' || this.failure) return;
            this.failure = error; this.dependencies.failed(error);
            void this.close().catch(cleanup => this.dependencies.failed(toError(cleanup)));
          };
          output = this.dependencies.create?.(failed) ?? new NativeMidiOutput(this.dependencies.executable, failed);
          this.owned.add(output); names.set(mapping.portName, output);
          await output.open(mapping.portName); requireCurrent();
        }
        this.byProfile.set(mapping.id, output);
      }
      requireCurrent(); this.state = 'ready';
    };
    signal.addEventListener('abort', abort, { once: true });
    this.preparing = work().catch(error => {
      void this.close().catch(cleanup => this.dependencies.failed(toError(cleanup))); throw error;
    }).finally(() => signal.removeEventListener('abort', abort));
    return this.preparing;
  }

  /** deadlineAtMs uses QPC milliseconds, matching the native audio clock. */
  async send(profileId: string, bytes: readonly number[], deadlineAtMs: number): Promise<void> {
    if (!Number.isFinite(deadlineAtMs) || deadlineAtMs < 0) throw new Error('MIDI 动作截止时间无效');
    if (this.state !== 'ready' || this.failure) throw this.failure ?? new Error('MIDI 输出未准备或已取消');
    const output = this.byProfile.get(profileId);
    if (!output) throw new Error(`本轮未准备 MIDI 输出：${profileId}`);
    await this.authorize();
    if (this.state !== 'ready' || this.failure) throw this.failure ?? new Error('MIDI 动作在许可检查期间已取消');
    await output.send(bytes, BigInt(Math.floor(deadlineAtMs * 10000)));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = 'closed'; this.cancellation.abort(); this.byProfile.clear();
    // Close all currently owned helpers before waiting for preparation. An
    // open operation may itself be waiting on a slow driver acknowledgement.
    const closing = [...this.owned].map(output => Promise.resolve().then(() => output.close()));
    const preparing = this.preparing;
    this.closing = Promise.allSettled(closing).then(async results => {
      if (preparing) await Promise.allSettled([preparing]);
      const failures = results.flatMap(result => result.status === 'rejected' ? [toError(result.reason)] : []);
      if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('；'));
    });
    return this.closing;
  }

  private async authorize(): Promise<void> {
    const signal = this.cancellation.signal;
    let cancel: (() => void) | undefined;
    try {
      await Promise.race([this.dependencies.authorize(), new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new Error('MIDI 动作在许可检查期间已取消'));
        if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
      })]);
    } finally { if (cancel) signal.removeEventListener('abort', cancel); }
  }
}

function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
