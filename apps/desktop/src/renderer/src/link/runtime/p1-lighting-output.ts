import { lightingTimeOrigin, timecodeToMilliseconds, type MtcSample } from '@tb/core/link';
import type { IntegrationProfile, RundownItem } from '@tb/schema';
import { LightingMidiOutput } from '../../registry/lighting-midi-output';

/** P1 owns the clock; suspension cancels unsent actions without replaying missed points. */
export class P1LightingOutput {
  private readonly output = new LightingMidiOutput();
  private ready = false;
  private suspended = false;
  private originMs = 0;
  private generation = 0;

  async prepare(item: RundownItem | undefined, profile: IntegrationProfile | null, autoFollow: boolean, sample?: MtcSample): Promise<void> {
    this.stop();
    if (!item?.lighting) return;
    const generation = this.generation;
    // Auto-follow has already converted allocated P1 ranges to song-local time.
    this.originMs = autoFollow ? 0 : lightingTimeOrigin(item.lighting, item.playback?.mtcOffsetMs ?? 0);
    await this.output.prepare(item.lighting, profile, Math.max(0, sample ? this.position(sample) : 0));
    if (generation !== this.generation) throw new Error('P1 灯光准备期间播放状态变了');
    this.ready = true;
  }
  tick(sample: MtcSample): void {
    if (!this.ready) return;
    const position = this.position(sample);
    if (position < 0) return;
    if (this.suspended) { this.output.locate(position); this.suspended = false; }
    this.output.tick(position);
  }
  suspend(sample: MtcSample | null): void {
    if (!this.ready) return;
    this.suspended = true;
    try { this.output.locate(Math.max(0, sample ? this.position(sample) : 0)); }
    catch (error) { this.ready = false; throw error; }
  }
  restart(): void { if (this.ready) { this.output.locate(0); this.suspended = false; } }
  stop(): void { this.generation += 1; this.ready = false; this.suspended = false; this.output.stop(); }
  private position(sample: MtcSample): number { return timecodeToMilliseconds(sample.timecode, sample.frameRate) - this.originMs; }
}
