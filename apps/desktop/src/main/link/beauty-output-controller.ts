import { beautyBasicValuesSchema, type BeautyApply, type BeautyFilterState, type BeautyRuntimeState } from '@tb/schema';
import type { BeautyRuntime } from './beauty-runtime';
import type { ObsBeauty } from './obs-beauty';

/** Follows the composed program scene, independent of which renderer page is open. */
export class BeautyOutputController {
  private values: BeautyApply['values'] | null = null;
  private connected = false;
  private revision = 0;
  private pending: Promise<void> | null = null;
  private target: string | null = null;
  private confirmed: BeautyFilterState | null = null;
  private failure: string | null = null;

  constructor(private readonly runtime: Pick<BeautyRuntime, 'start' | 'stop' | 'status'>,
    private readonly beauty: Pick<ObsBeauty, 'programScene' | 'apply' | 'disable'>,
    private readonly log: (message: string) => void) {}

  status(): BeautyRuntimeState {
    if (this.failure) return { phase: 'error', sourceName: this.target, filterName: null, faces: 0, message: this.failure };
    return this.runtime.status();
  }

  connection(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected; this.target = null; this.confirmed = null; this.failure = null;
    this.revision++; this.schedule();
  }

  sceneChanged(): void {
    if (!this.connected || !this.values) return;
    this.target = null; this.confirmed = null; this.failure = null;
    this.revision++; this.schedule();
  }

  async configure(values: BeautyApply['values']): Promise<BeautyFilterState | null> {
    this.values = beautyBasicValuesSchema.parse(values);
    this.revision++; this.schedule();
    await this.pending;
    if (this.failure) throw new Error(this.failure);
    return this.confirmed;
  }

  private schedule(): void {
    if (this.pending) return;
    this.pending = Promise.resolve().then(() => this.drain()).finally(() => { this.pending = null; });
  }

  private async drain(): Promise<void> {
    let handled = -1;
    while (handled !== this.revision) {
      handled = this.revision;
      try {
        if (!this.connected) {
          await this.runtime.stop();
          continue;
        }
        if (!this.values || this.failure) return;
        // Every explicit parameter change verifies the actual output. A missed scene
        // event must not keep edits attached to a cached, no-longer-visible scene.
        const scene = await this.beauty.programScene();
        if (handled !== this.revision) continue;
        this.target = scene;
        const state = this.runtime.status();
        if (state.sourceName !== scene || state.phase === 'idle') {
          if (state.sourceName && state.filterName) await this.beauty.disable({ sourceName: state.sourceName, filterName: state.filterName });
          await this.runtime.stop();
          if (handled !== this.revision) continue;
          await this.runtime.start(scene);
        } else if (state.phase === 'error') {
          throw new Error(state.message);
        }
        if (handled !== this.revision) continue;
        this.confirmed = await this.beauty.apply({ sourceName: scene, filterName: '团播·人像美颜', values: this.values });
      } catch (error) {
        this.confirmed = null;
        this.failure = `全画面美颜未生效：${error instanceof Error ? error.message : String(error)}`;
        this.log(this.failure);
        return;
      }
    }
  }
}
