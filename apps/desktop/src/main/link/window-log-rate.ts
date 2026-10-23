/** How often the window may write to the run log: a burst of 200 entries, refilled at 20 per second. */
export class WindowLogRate {
  private static readonly capacity = 200;
  private static readonly perSecond = 20;
  private tokens = WindowLogRate.capacity;
  private updatedAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.updatedAt = now();
  }

  take(): void {
    const now = this.now();
    this.tokens = Math.min(WindowLogRate.capacity, this.tokens + (now - this.updatedAt) * WindowLogRate.perSecond / 1000);
    this.updatedAt = now;
    if (this.tokens < 1) throw new Error(`窗口日志写入过于频繁（持续每秒最多 ${WindowLogRate.perSecond} 条），本条未记录`);
    this.tokens -= 1;
  }
}
