/** At most one operation is in flight and one latest position is waiting. */
export class LatestPosition {
  private pending: number | null = null;
  private running = false;
  private cancelled = false;
  private revision = 0;
  private latest: number | null = null;
  constructor(private readonly apply: (position: number, current: () => boolean) => Promise<void>, private readonly settled: () => void,
    private readonly failed: (error: unknown) => void) {}
  push(position: number): void {
    if (this.cancelled || this.running && this.latest === position) return;
    this.latest = position; this.revision++; this.pending = position;
    if (!this.running) void this.flush();
  }
  cancel(): void { this.cancelled = true; this.pending = null; }
  private async flush(): Promise<void> {
    this.running = true;
    try {
      while (!this.cancelled && this.pending !== null) {
        const position = this.pending, revision = this.revision; this.pending = null;
        await this.apply(position, () => !this.cancelled && revision === this.revision);
      }
      if (!this.cancelled) this.settled();
    } catch (error) { this.pending = null; if (!this.cancelled) { this.failed(error); this.settled(); } }
    finally { this.running = false; }
  }
}
