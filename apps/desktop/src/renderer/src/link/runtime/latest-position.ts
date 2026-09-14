/** At most one operation is in flight and one latest position is waiting. */
export class LatestPosition {
  private pending: number | null = null;
  private running = false;
  private cancelled = false;
  constructor(private readonly apply: (position: number) => Promise<void>, private readonly settled: () => void,
    private readonly failed: (error: unknown) => void) {}
  push(position: number): void { this.pending = position; if (!this.running) void this.flush(); }
  cancel(): void { this.cancelled = true; this.pending = null; }
  private async flush(): Promise<void> {
    this.running = true;
    try {
      while (!this.cancelled && this.pending !== null) {
        const position = this.pending; this.pending = null;
        await this.apply(position);
      }
      if (!this.cancelled) this.settled();
    } catch (error) { this.pending = null; if (!this.cancelled) { this.failed(error); this.settled(); } }
    finally { this.running = false; }
  }
}
