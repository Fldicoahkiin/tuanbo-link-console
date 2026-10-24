export type MtcRecoveryReport = { portName: string; interruptedAt: string; recoveredAt: string; durationMs: number };
type Output = { id: number; name: string };
type Dependencies = {
  /** Windows MIDI outputs as listed now (enumeration only). */
  list(): Promise<readonly Output[]>;
  /** Opens the port at this index again; the opened handle must carry this name. */
  reopen(device: number, name: string): Promise<void>;
  /** Only while the song plays: a reopened port is confirmed by the timecode it then sends. */
  active(): boolean;
  recovered(report: MtcRecoveryReport): void;
  /** A change worth a log line: a non-unique name or a failed reopen, once per distinct message. */
  log(message: string): void;
  intervalMs?: number;
};
type Watch = { portName: string; since: number; message: string | null; timer: ReturnType<typeof setTimeout> | null };

/**
 * Waits for the configured timecode port to come back after it was lost, then opens it again
 * (authorised 2026-10-24). Only the same port name, and only when exactly one output carries it;
 * never another port. One check right away, then one per second, never two at once; while the
 * song is paused it only waits.
 */
export class MtcPortRecovery {
  private watch: Watch | null = null;
  constructor(private readonly dependencies: Dependencies) {}

  get watching(): string | null { return this.watch?.portName ?? null; }

  /** Repeated reports of the same lost port (every telemetry tick) keep the first watch. */
  lost(portName: string): void {
    if (this.watch?.portName === portName) return;
    this.cancel();
    const watch: Watch = { portName, since: Date.now(), message: null, timer: null };
    this.watch = watch;
    void this.check(watch);
  }

  cancel(): void {
    if (this.watch?.timer) clearTimeout(this.watch.timer);
    this.watch = null;
  }

  private async check(watch: Watch): Promise<void> {
    watch.timer = null;
    try {
      if (!this.dependencies.active()) { this.next(watch); return; }
      const matches = (await this.dependencies.list()).filter(output => output.name === watch.portName);
      if (this.watch !== watch) return;
      if (matches.length === 1) {
        await this.dependencies.reopen(matches[0]!.id, watch.portName);
        if (this.watch !== watch) return;
        this.watch = null;
        const recoveredAt = Date.now();
        this.dependencies.recovered({ portName: watch.portName, interruptedAt: new Date(watch.since).toISOString(),
          recoveredAt: new Date(recoveredAt).toISOString(), durationMs: recoveredAt - watch.since });
        return;
      }
      if (matches.length > 1) this.note(watch, `时间码端口名称不唯一（${matches.length} 个「${watch.portName}」）：等只剩一个时再恢复，不会改用其他端口`);
    } catch (error) {
      if (this.watch !== watch) return;
      this.note(watch, `时间码端口恢复未成功（${watch.portName}）：${error instanceof Error ? error.message : String(error)}；继续每秒检查`);
    }
    this.next(watch);
  }
  private next(watch: Watch): void {
    if (this.watch === watch) watch.timer = setTimeout(() => { void this.check(watch); }, this.dependencies.intervalMs ?? 1000);
  }

  private note(watch: Watch, message: string): void {
    if (watch.message === message) return;
    watch.message = message; this.dependencies.log(message);
  }
}
