import { nativeObsPreloadSchema, nativeObsStopSchema, type NativeObsPrepare, type NativeObsPreload, type NativeObsStop } from '@tb/schema';
import { ObsPreparationCancelled, type NativeObsOutputs } from './native-obs-outputs';
import { materialSceneTargets, pictureCleanupReason, projectFromObsSnapshot, toUserErrorMessage } from '@tb/core/link';

/** `settled`: the preparation itself has ended; its result goes to whoever asked for it, unless `taken`:
 * a song took it over before it ended, and that song hears its result. */
type Entry = { origin: 'selection' | 'next'; request: NativeObsPreload; cancelled: boolean; settled: boolean; taken: boolean;
  outputs: NativeObsOutputs | null; task: Promise<void>; assertOwner: (() => void) | null };
type Dependencies = {
  authorize: (request: NativeObsPreload) => Promise<void>;
  create: (request: NativeObsPrepare, positionMs: number) => NativeObsOutputs;
  /** A failure no caller hears about, reported once: the failed cleanup of a preparation
   * that was replaced, or a preparation that failed after its song took it over. */
  report: (message: string) => void;
};

/** One silent selected or upcoming program. Ownership transfers to the formal session only
 * on an exact snapshot/position match. Cleanup always precedes a replacement. */
export class NativeObsPreloadPool {
  private entry: Entry | null = null;
  /** What a replacement waits for. It never rejects: a failed cleanup belongs to whoever
   * discarded that preparation, and must not become every later song's failure (2026-11-09). */
  private cleanup: Promise<void> = Promise.resolve();
  constructor(private readonly dependencies: Dependencies) {}

  /** Internal lookahead from the admitted immutable session. Shared sources
   * cannot be paused/reconfigured while the current song owns their decoder. */
  async prepareNext(request: NativeObsPrepare, assertCurrent: () => void): Promise<boolean> {
    const next = request.nextFiles;
    if (!next) return false;
    if (next.snapshot.projectId !== request.snapshot.projectId || next.snapshot.revision !== request.snapshot.revision) {
      throw new Error('下一个节目的准备和当前工程版本对不上');
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
    if (this.entry) throw new Error('已经有一个节目在准备，不能覆盖');
    const entry: Entry = {
      origin: 'next', request: { version: 1, sessionId: request.sessionId, generation: request.generation,
        projectPath: request.projectPath, preciseSeeking: request.preciseSeeking, snapshot: next.snapshot, positionMs: next.positionMs },
      cancelled: false, settled: false, taken: false, outputs: null, task: Promise.resolve(), assertOwner: null
    };
    this.entry = entry;
    const current = (): void => {
      if (entry.cancelled) throw new ObsPreparationCancelled('下一个节目的准备已取消');
      if (entry.assertOwner) entry.assertOwner(); else assertCurrent();
    };
    entry.task = (async () => {
      await this.cleanup; current();
      entry.outputs = this.dependencies.create(entry.request, next.positionMs);
      await entry.outputs.guardOutput(() => { current(); return true; }, () => entry.outputs!.preloadResources(current, 'background'));
      current();
    })().finally(() => { entry.settled = true; });
    try { await entry.task; }
    catch (error) {
      // A failed lookahead is cleaned up, not kept: the next song then prepares
      // the normal way, and later lookaheads are not refused (2026-11-09). The
      // caller gets the lookahead's own failure, once; a failed cleanup is reported apart.
      if (this.entry === entry) await this.discardReported();
      // Taken over while it ran, its failure went to the song that took it over (take).
      if (entry.taken) throw new ObsPreparationCancelled('下一个节目的准备已交给下一首');
      throw error;
    }
    return true;
  }

  /** `checkFiles`: the window's request names its media files; the program's own requests pass none. */
  preload(value: unknown, checkFiles?: (request: NativeObsPreload) => Promise<void>): Promise<void> {
    const request = nativeObsPreloadSchema.parse(value);
    if (this.entry?.origin === 'selection' && this.entry.request.sessionId === request.sessionId && request.generation <= this.entry.request.generation) return Promise.reject(new Error('节目准备请求已过期'));
    const previous = this.discardReported();
    const entry: Entry = { origin: 'selection', request, cancelled: false, settled: false, taken: false, outputs: null, task: Promise.resolve(), assertOwner: null }; this.entry = entry;
    const current = (): void => { if (entry.cancelled) throw new ObsPreparationCancelled('节目准备已取消'); entry.assertOwner?.(); };
    entry.task = (async () => {
      await previous; current();
      // A formal session that takes this preparation meanwhile was admitted on its own; the
      // selection's admission (nothing else preparing or on air) no longer applies to it.
      try { await this.dependencies.authorize(request); }
      catch (error) { if (!entry.assertOwner) throw error; }
      // The window's files are checked either way: the outputs load exactly these.
      await checkFiles?.(request);
      current();
      entry.outputs = this.dependencies.create(request, request.positionMs);
      await entry.outputs.guardOutput(() => { current(); return true; }, () => entry.outputs!.preloadResources(current)); current();
    })().finally(() => { entry.settled = true; });
    return entry.task;
  }

  async take(request: NativeObsPrepare, positionMs: number, assertOwner: () => void): Promise<NativeObsOutputs> {
    const entry = this.entry;
    if (entry && !entry.cancelled && entry.request.sessionId === request.sessionId && resourceKey(entry.request, entry.request.positionMs) === resourceKey(request, positionMs)) {
      // The song taking it over being stopped or replaced cancels the preparation; that is not a failure.
      this.entry = null; entry.assertOwner = () => {
        try { assertOwner(); } catch (error) { throw new ObsPreparationCancelled(errorText(error)); }
      };
      entry.taken = !entry.settled;
      try { await entry.task; return entry.outputs!; }
      catch (error) {
        // A failed preload (a selection refused because this very song started
        // preparing, or a lookahead that could not read its files) is not reused:
        // the song prepares its picture below. A failure from before this song took
        // it over went to whoever asked for it; one after is reported here, once.
        if (entry.taken && !(error instanceof ObsPreparationCancelled)) this.dependencies.report(`提前准备的画面没能用上，已改为重新准备。原因：${toUserErrorMessage(error)}`);
        await this.release(entry).catch((cleanup: unknown) => this.reportCleanup(cleanup));
      }
      assertOwner();
      return this.dependencies.create(request, positionMs);
    }
    await this.discardReported(); assertOwner();
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
  /** Rejects only for this discard's own cleanup; with nothing to discard it only waits for the last one. */
  private discard(): Promise<void> {
    const entry = this.entry; this.entry = null;
    if (!entry) return this.cleanup;
    entry.cancelled = true;
    return this.release(entry);
  }
  /** For a replacement or a failed lookahead: the caller goes ahead either way, and a failed cleanup,
   * which nobody else hears about, is reported once. */
  private discardReported(): Promise<void> {
    if (!this.entry) return this.cleanup;
    return this.discard().catch((error: unknown) => this.reportCleanup(error));
  }
  /** Releases once the preparation has ended. Later preparations wait for it, without its result. */
  private release(entry: Entry): Promise<void> {
    const released = entry.task.then(() => undefined, () => undefined).then(async () => { await entry.outputs?.releaseOutputs(); });
    this.cleanup = released.then(() => undefined, () => undefined);
    return released;
  }
  private reportCleanup(error: unknown): void {
    this.dependencies.report(`提前准备的画面没有清理干净，不影响播放。原因：${pictureCleanupReason(error)}`);
  }
}

function resourceKey(request: NativeObsPrepare, positionMs: number): string {
  return JSON.stringify([request.projectPath, request.preciseSeeking, request.snapshot, positionMs]);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
