import { deriveShowState, showGate, type ShowGate, type ShowInputs, type ShowOperation, type ShowState } from '@tb/core/link';
import { linkShowActivitySchema, type LinkShowActivity, type LinkShowState } from '@tb/schema';
import type { NativeProgramSnapshot } from './native-program-service';

/** The background program as the show reads it: NativeProgramService. */
export type ShowProgramSource = {
  snapshot(): NativeProgramSnapshot | null;
  onStateChanged(listener: () => void): () => void;
};

const noActivity: LinkShowActivity = { version: 1, p1: null, preview: false };

/**
 * The one live source of the show state (packages/core show-state.ts, 00-order §2.4): derived again on every change of
 * the background program and of what the window reports (P1 following, its previews), never stored anywhere else. The
 * window mirrors it (useShowStateStore) to disable what has to wait; the main process asks `gate` again and has the
 * last word. What the window reported goes with its page: P1 following and the previews end with the page.
 * Not yet an input: the Off a stop still owes (`lightingOffOwed`). The player keeps that to itself until the lights-off
 * ledger takes it over (01 R13); until then a stopping internal program shows as idle, as it did before.
 */
export class ShowStateService {
  private activity: LinkShowActivity = noActivity;
  private show: ShowState;
  private published: string;

  constructor(private readonly program: ShowProgramSource, private readonly publish: (show: LinkShowState) => void) {
    this.show = this.derive(); this.published = JSON.stringify(this.show);
    program.onStateChanged(() => this.update());
  }

  current(): ShowState { return this.show; }

  /** Whether `op` may run now: the main process's own question, asked again after the window's. */
  gate(op: ShowOperation, itemId?: string): ShowGate { return showGate(op, this.show, itemId); }

  /** The window reports what only it knows (link:show-activity). */
  report(value: unknown): void {
    this.activity = linkShowActivitySchema.parse(value);
    this.update();
  }

  /** The window's page is gone (its renderer exited, or a new page replaced it): what it reported is gone with it. */
  pageGone(): void {
    this.activity = noActivity;
    this.update();
  }

  private derive(): ShowState {
    const program = this.program.snapshot();
    const internal: ShowInputs['internal'] = program ? { status: program.state.status, itemId: program.state.itemId,
      positionMs: program.state.positionMs, durationMs: program.state.durationMs, lightingOffOwed: false } : null;
    const p1 = this.activity.p1 && this.activity.p1.state !== 'idle' ? { state: this.activity.p1.state, itemId: this.activity.p1.itemId } : null;
    return deriveShowState({ internal, p1, preview: this.activity.preview,
      program: program ? { projectPath: program.projectPath, projectId: program.projectId, watched: program.watched } : null });
  }

  /** Sent only when the show changed: the player's position moves on every state, the show does not. */
  private update(): void {
    const next = this.derive(), text = JSON.stringify(next);
    this.show = next;
    if (text === this.published) return;
    this.published = text;
    this.publish(next);
  }
}
