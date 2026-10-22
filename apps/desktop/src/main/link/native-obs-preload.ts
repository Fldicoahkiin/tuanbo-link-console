import { nativeObsPreloadSchema, nativeObsStopSchema, type NativeObsPrepare, type NativeObsPreload, type NativeObsStop } from '@tb/schema';
import { ObsPreparationCancelled, type NativeObsOutputs } from './native-obs-outputs';
import { materialSceneTargets, projectFromObsSnapshot } from '@tb/core/link';

type Entry = { origin: 'selection' | 'next'; request: NativeObsPreload; cancelled: boolean; outputs: NativeObsOutputs | null; task: Promise<void>; assertOwner: (() => void) | null };
type Dependencies = {
  authorize: (request: NativeObsPreload) => Promise<void>;
  create: (request: NativeObsPrepare, positionMs: number) => NativeObsOutputs;
};

/** One silent selected or upcoming program. Ownership transfers to the formal session only
 * on an exact snapshot/position match. Cleanup always precedes a replacement. */
export class NativeObsPreloadPool {
  private entry: Entry | null = null;
  private cleanup: Promise<void> = Promise.resolve();
  constructor(private readonly dependencies: Dependencies) {}

  /** Internal lookahead from the admitted immutable session. Shared sources
   * cannot be paused/reconfigured while the current song owns their decoder. */
  async prepareNext(request: NativeObsPrepare, assertCurrent: () => void): Promise<boolean> {
    const next = request.nextFiles;
    if (!next) return false;
    if (next.snapshot.projectId !== request.snapshot.projectId || next.snapshot.revision !== request.snapshot.revision) {
      throw new Error('下一节目预备与当前工程修订不一致');
    }
    if (next.snapshot.item.id === request.snapshot.item.id) return false;
    const currentNames = new Set(materialSceneTargets(projectFromObsSnapshot(request.snapshot)).flatMap(target => [target.sourceName, target.sceneName]));
    for (const cue of request.snapshot.item.cues) for (const action of cue.actions) {
      if ('sceneName' in action) currentNames.add(action.sceneName);
      if ('sourceName' in action) currentNames.add(action.sourceName);
      if ('inputName' in action) currentNames.add(action.inputName);
      if (action.kind === 'obs.setProgramScene') for (const name of action.sceneLayers ?? []) currentNames.add(name);
    }
    if (materialSceneTargets(projectFromObsSnapshot(next.snapshot)).some(target => currentNames.has(target.sourceName) || currentNames.has(target.sceneName))) return false;
    assertCurrent();
    if (this.entry) throw new Error('已有节目预备占用，不能覆盖');
    const entry: Entry = {
      origin: 'next', request: { version: 1, sessionId: request.sessionId, generation: request.generation,
        projectPath: request.projectPath, preciseSeeking: request.preciseSeeking, snapshot: next.snapshot, positionMs: next.positionMs },
      cancelled: false, outputs: null, task: Promise.resolve(), assertOwner: null
    };
    this.entry = entry;
    const current = (): void => {
      if (entry.cancelled) throw new ObsPreparationCancelled('下一节目预备已取消');
      if (entry.assertOwner) entry.assertOwner(); else assertCurrent();
    };
    entry.task = (async () => {
      await this.cleanup; current();
      entry.outputs = this.dependencies.create(entry.request, next.positionMs);
      await entry.outputs.guardOutput(() => { current(); return true; }, () => entry.outputs!.preloadResources(current, 'background'));
      current();
    })();
    await entry.task;
    return true;
  }

  preload(value: unknown): Promise<void> {
    const request = nativeObsPreloadSchema.parse(value);
    if (this.entry?.origin === 'selection' && this.entry.request.sessionId === request.sessionId && request.generation <= this.entry.request.generation) return Promise.reject(new Error('节目预备请求已过期'));
    const previous = this.discard();
    const entry: Entry = { origin: 'selection', request, cancelled: false, outputs: null, task: Promise.resolve(), assertOwner: null }; this.entry = entry;
    const current = (): void => { if (entry.cancelled) throw new ObsPreparationCancelled('节目预备已取消'); entry.assertOwner?.(); };
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
    if (!this.entry || this.entry.origin !== 'selection' || this.entry.request.sessionId !== request.sessionId || this.entry.request.generation !== request.generation) return Promise.resolve();
    return this.discard();
  }
  cancelNext(sessionId: string): Promise<void> {
    if (this.entry?.origin !== 'next' || this.entry.request.sessionId !== sessionId) return Promise.resolve();
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
