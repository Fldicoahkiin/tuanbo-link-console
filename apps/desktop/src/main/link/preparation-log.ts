/** A preparation step this long is recorded on its own, as it happens. */
export const SLOW_PREPARATION_STEP_MS = 3_000;

/** The timed steps of one preparation, taken as one record when it completes; a slow step is reported as it happens. */
export class PreparationSteps {
  private steps: { step: string; ms: number }[] = [];

  constructor(private readonly slow: (step: string, ms: number) => void) {}

  add(step: string, ms: number): void {
    this.steps.push({ step, ms: Math.round(ms) });
    if (ms >= SLOW_PREPARATION_STEP_MS) this.slow(step, ms);
  }

  take(): { step: string; ms: number }[] {
    const steps = this.steps;
    this.steps = [];
    return steps;
  }
}
