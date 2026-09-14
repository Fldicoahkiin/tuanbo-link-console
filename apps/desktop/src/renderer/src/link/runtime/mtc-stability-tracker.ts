import { isMtcSampleContinuous, type MtcSample } from '@tb/core/link';

const STABILITY_WINDOW_MS = 500;

export class MtcStabilityTracker {
  private continuousSinceMs: number | null = null;

  reset(): void {
    this.continuousSinceMs = null;
  }

  update(previous: MtcSample | null, current: MtcSample): boolean {
    if (!previous || !isMtcSampleContinuous(previous, current)) {
      this.continuousSinceMs = null;
      return false;
    }
    this.continuousSinceMs ??= previous.receivedAtMs;
    return current.receivedAtMs - this.continuousSinceMs >= STABILITY_WINDOW_MS;
  }
}
