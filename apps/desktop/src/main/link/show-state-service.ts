import { deriveShowState, showGate, type ShowGate, type ShowInputs, type ShowOperation, type ShowState } from '@tb/core/link';
import { linkShowActivitySchema, type LinkShowActivity, type LinkShowState } from '@tb/schema';
import type { NativeProgramSnapshot } from './native-program-service';

/** The background program as the show reads it: NativeProgramService. */
export type ShowProgramSource = {
  snapshot(): NativeProgramSnapshot | null;
  onStateChanged(listener: () => void): () => void;
};

/** The lights-off ledger as the show reads it (LightingOffService): an Off on its way keeps a stopped program stopping. */
export type ShowLightingSource = { sending(): boolean; onChanged(listener: () => void): () => void };

/** P1 followed in the main process (p1-follow-wiring.ts, 0.5.9 P3f): its state as the show's P1 input while the host has
 * a follow; `undefined` while it has none. The only P1 of the show (0.5.9 P4): the window reports none. */
export type ShowP1Source = { input(): ShowInputs['p1'] | undefined };

const noActivity: LinkShowActivity = { version: 1, preview: false };

/**
 * The one live source of the show state (packages/core show-state.ts, 00-order §2.4): derived again on every change of
 * the background program, of the main process's P1 follow and of what the window reports (its previews), never stored anywhere else. The
 * window mirrors it (useShowStateStore) to disable what has to wait; the main process asks `gate` again and has the
 * last word. What the window reported goes with its page: its previews end with the page (a P1 follow does not).
 * `lighting`: the lights-off ledger (01 R13). `lightingOffOwed` is an Off still on its way to the console: the stop is
 * not finished until the console answered. An Off that did not go out and waits for the console does not hold the show:
 * waiting is not failing (AGENTS §4), it stays red in the ledger instead.
 */
export class ShowStateService {
  private activity: LinkShowActivity = noActivity;
  private p1: ShowP1Source | null = null;
  private show: ShowState;
  private published: string;

  constructor(private readonly program: ShowProgramSource, private readonly publish: (show: LinkShowState) => void,
    private readonly lighting: ShowLightingSource | null = null) {
    this.show = this.derive(); this.published = JSON.stringify(this.show);
    program.onStateChanged(() => this.update());
    lighting?.onChanged(() => this.update());
  }

  current(): ShowState { return this.show; }

  /** Whether `op` may run now: the main process's own question, asked again after the window's. */
  gate(op: ShowOperation, itemId?: string): ShowGate { return showGate(op, this.show, itemId); }

  /** The window reports what only it knows (link:show-activity). */
  report(value: unknown): void {
    this.activity = linkShowActivitySchema.parse(value);
    this.update();
  }

  /** The main process follows P1 itself from now on (`source`); `p1Changed` says when its state changed. */
  followP1(source: ShowP1Source): void { this.p1 = source; this.update(); }
  p1Changed(): void { this.update(); }

  /** The window's page is gone (its renderer exited, or a new page replaced it): what it reported is gone with it. */
  pageGone(): void {
    this.activity = noActivity;
    this.update();
  }

  private derive(): ShowState {
    const program = this.program.snapshot();
    const internal: ShowInputs['internal'] = program ? { status: program.state.status, itemId: program.state.itemId,
      positionMs: program.state.positionMs, durationMs: program.state.durationMs, lightingOffOwed: this.lighting?.sending() ?? false } : null;
    const p1 = this.p1?.input() ?? null;
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
