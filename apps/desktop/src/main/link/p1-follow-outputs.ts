import type { P1FollowOutputs, ProgramClock } from '@tb/core/link';

/** One output of a P1 follow and the name the run log gives it. */
export type P1FollowOutputEntry = { name: string; output: P1FollowOutputs };

/**
 * The outputs of one P1 follow as one (0.5.9 P3f): every call goes to each output in turn, in the order listed. One that
 * throws is reported (`failed`, which logs it and shows it in red) and never reaches the follow, and the outputs after
 * it are told all the same. Nothing is retried. Today the list holds the action MIDI (p1-midi-output.ts); the picture
 * joins it as one more entry.
 */
export class P1FollowOutputList implements P1FollowOutputs {
  constructor(private readonly entries: readonly P1FollowOutputEntry[], private readonly failed: (name: string, error: Error) => void) {}

  observe(clock: ProgramClock): void { this.each(output => output.observe(clock)); }
  hold(): void { this.each(output => output.hold()); }
  reconcileAt(clock: ProgramClock, playsOn: boolean): void { this.each(output => output.reconcileAt(clock, playsOn)); }
  expect(itemId: string | null): void { this.each(output => output.expect?.(itemId)); }

  private each(step: (output: P1FollowOutputs) => void): void {
    for (const { name, output } of this.entries) {
      try { step(output); } catch (error) { this.failed(name, error instanceof Error ? error : new Error(String(error))); }
    }
  }
}
