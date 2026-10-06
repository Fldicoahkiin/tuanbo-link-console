import { nativeObsPreloadSchema, nativeObsStopSchema, type NativeObsPrepare, type NativeObsPreload, type NativeObsStop } from '@tb/schema';
import type { NativeObsOutputs } from './native-obs-outputs';

type Entry = { request: NativeObsPreload; cancelled: boolean; outputs: NativeObsOutputs | null; task: Promise<void>; assertOwner: (() => void) | null };
type Dependencies = {
  authorize: (request: NativeObsPreload) => Promise<void>;
  create: (request: NativeObsPrepare, positionMs: number) => NativeObsOutputs;
};

/** One selected, silent program. Ownership transfers to the formal session only
 * on an exact snapshot/position match. Cleanup always precedes a replacement. */
export class NativeObsPreloadPool {
  private entry: Entry | null = null;
  private cleanup: Promise<void> = Promise.resolve();
  constructor(private readonly dependencies: Dependencies) {}

  preload(value: unknown): Promise<void> {
    const request = nativeObsPreloadSchema.parse(value);
    if (this.entry?.request.sessionId === request.sessionId && request.generation <= this.entry.request.generation) return Promise.reject(new Error('节目预备请求已过期'));
    const previous = this.discard();
    const entry: Entry = { request, cancelled: false, outputs: null, task: Promise.resolve(), assertOwner: null }; this.entry = entry;
    const current = (): void => { if (entry.cancelled) throw new Error('节目预备已取消'); entry.assertOwner?.(); };
    entry.task = (async () => {
      await previous; current(); await this.dependencies.authorize(request); current();
      entry.outputs = this.dependencies.create(request, request.positionMs);
      await entry.outputs.guardOutput(() => { current(); return true; }, () => entry.outputs!.preloadResources(current)); current();
    })();
    return entry.task;
  }

  async take(request: NativeObsPrepare, positionMs: number, assertOwner: () => void): Promise<NativeObsOutputs> {
    const entry = this.entry;
    if (entry && !entry.cancelled && entry.request.sessionId === request.sessionId && resourceKey(entry.request, entry.request.positionMs) === resourceKey(request, positionMs)) {
      this.entry = null; entry.assertOwner = assertOwner;
      try { await entry.task; return entry.outputs!; }
      catch (error) { await entry.outputs?.releaseOutputs(); throw error; }
    }
    await this.discard(); assertOwner();
    return this.dependencies.create(request, positionMs);
  }

  cancel(value: NativeObsStop): Promise<void> {
    const request = nativeObsStopSchema.parse(value);
    if (!this.entry || this.entry.request.sessionId !== request.sessionId || this.entry.request.generation !== request.generation) return Promise.resolve();
    return this.discard();
  }
  close(): Promise<void> { return this.discard(); }
  private discard(): Promise<void> {
    const entry = this.entry; this.entry = null;
    if (!entry) return this.cleanup;
    entry.cancelled = true;
    this.cleanup = entry.task.then(() => undefined, () => undefined).then(async () => { await entry.outputs?.releaseOutputs(); });
    return this.cleanup;
  }
}

function resourceKey(request: NativeObsPrepare, positionMs: number): string {
  return JSON.stringify([request.projectPath, request.preciseSeeking, request.snapshot, positionMs]);
}
