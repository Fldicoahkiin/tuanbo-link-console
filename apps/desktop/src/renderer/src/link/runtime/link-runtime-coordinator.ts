import { CueActionRunner, CueRuntime, type RuntimeUpdate } from '@tb/core/link';
import type { LinkAction, LinkProject } from '@tb/schema';
import { LinkMidiAdapter } from '../../registry/link-midi-adapter';
import { useIntegrationStore } from '../stores/integration-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { ObsIpcExecutor } from './obs-ipc-executor';
import { recordRuntimeAction, recordRuntimeOperator, reportCoordinatorError } from './runtime-action-log';
import { applyRuntimeState } from './runtime-state-application';
import { EditorScenePreview } from './editor-scene-preview';

/*
 * What the window still does itself around a show: the editor's preview while nothing plays, the editor's single action
 * test, the song chosen under 联动台播放 and the stop it passes to the main-process program. Following P1 is the main
 * process's (0.5.9 P4, p1-follow-host.ts; the window sends commands through runtime/p1-follow-client.ts), and 联动台播放
 * plays in the main-process program host: nothing here reads timecode or runs a show's Cues.
 */
export class LinkRuntimeCoordinator {
  private readonly runtime: CueRuntime;
  private readonly midi: LinkMidiAdapter;
  private readonly runner: CueActionRunner;
  private cueExecutionTail: Promise<void> = Promise.resolve();
  private executionGeneration = 0;
  private disposed = false;
  private readonly editorPreview = new EditorScenePreview();
  private internalStopHandler: (() => void) | null = null;

  /** Internal playback runs in the main-process program host; stopping here stops it too. */
  onInternalStop(handler: (() => void) | null): void { this.internalStopHandler = handler; }
  async stopAndWait(suspendAuto = true, reason?: string): Promise<void> {
    this.stop(suspendAuto, reason); await this.cueExecutionTail;
    if (this.runtime.getState() === 'error') throw new Error(useRuntimeStore.getState().reason ?? '停止清理失败');
  }
  cancelEditorPreview(): void { this.executionGeneration += 1; this.editorPreview.reset(); }

  previewEditor(itemId: string, positionMs: number, preciseSeeking: boolean): Promise<void> {
    const generation = this.executionGeneration;
    const queued = this.editorPreview.enqueue(this.cueExecutionTail, this.project, this.projectPath, itemId, positionMs, preciseSeeking,
      () => !this.disposed && generation === this.executionGeneration && this.runtime.getState() === 'idle');
    this.cueExecutionTail = queued.tail;
    return queued.operation;
  }

  constructor(private readonly project: LinkProject, private readonly projectPath: string | null) {
    this.runtime = new CueRuntime(project);
    this.midi = new LinkMidiAdapter(
      (profileId) => {
        const port = useIntegrationStore.getState().profile?.midiPortProfiles.find((candidate) => candidate.id === profileId);
        return port ?? null;
      },
      (error) => this.reportRuntimeError(error)
    );
    this.runner = new CueActionRunner([new ObsIpcExecutor(), this.midi], {
      onStatus: (event) => recordRuntimeAction(this.project.projectId, this.currentItem(), event)
    });
  }

  /** The song chosen under 联动台播放 (P1's is chosen in stores/p1-follow-store.ts). */
  selectItem(itemId: string, recordOperator = true): void {
    const update = this.runtime.selectItem(itemId, -1);
    if (update.state === 'error' || update.reason) {
      this.applyUpdate(update);
      return;
    }
    useRuntimeStore.getState().setState({ currentItemId: itemId, reports: [], mediaReports: [], currentCueId: null, timecode: null, detectedFrameRate: null, mtcStable: false, lastMtcAt: null });
    this.applyUpdate(update);
    if (recordOperator) this.recordOperatorAction('选择当前节目', { itemId });
  }

  async testAction(action: LinkAction): Promise<void> {
    await this.recordOperatorActionAsync('单步测试动作', { actionId: action.id, kind: action.kind });
    const result = await this.runner.retry('single-action-test', action);
    if (result.status === 'failed') throw new Error(result.error ?? '单步测试失败');
  }

  stop(suspendAuto = true, reason?: string): void {
    this.editorPreview.reset();
    ++this.executionGeneration;
    if (suspendAuto) this.internalStopHandler?.();
    if (this.runtime.getState() === 'stopping') return;
    this.applyUpdate(this.runtime.stop(reason)); if (this.runtime.getState() === 'idle') return;
    if (!reason) this.recordOperatorAction('停止运行');
    // What is still on its way (an editor preview) finishes first.
    this.cueExecutionTail = this.cueExecutionTail.then(() => this.applyUpdate(this.runtime.completeStop()))
      .catch((error: unknown) => this.reportRuntimeError(error));
  }

  dispose(): void {
    this.disposed = true;
    this.executionGeneration += 1;
    this.midi.dispose();
  }

  private applyUpdate(update: RuntimeUpdate): void {
    applyRuntimeState({ project: this.project, item: this.currentItem(), update, nextCueId: this.runtime.getNextCueId(-1) });
  }

  private currentItem() { const id = useRuntimeStore.getState().currentItemId; return this.project.rundown.find((item) => item.id === id); }

  private reportRuntimeError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.applyUpdate(this.runtime.failExecution(message));
    reportCoordinatorError(message, (reason) => useRuntimeStore.getState().setState({ state: 'error', reason }));
  }

  private recordOperatorAction(message: string, details?: Readonly<Record<string, unknown>>): void { void this.recordOperatorActionAsync(message, details).catch((error: unknown) => this.reportRuntimeError(error)); }

  private recordOperatorActionAsync(message: string, details?: Readonly<Record<string, unknown>>): Promise<void> { return recordRuntimeOperator(this.project.projectId, this.currentItem(), message, details); }
}
