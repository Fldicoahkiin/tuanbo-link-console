export type Ma2CommandPriority = 'normal' | 'playback' | 'stop';
/** How long one command waited for the console line: what was on it when the command was queued, and how many
 * commands went out before it. Measured, never estimated; the run log reads it for a lights-off. */
export type Ma2QueueWait = { waitedMs: number; runningKind: string | null; sentBefore: number };
type Job = { priority: Ma2CommandPriority; kind: string; queuedAt: number; runningKind: string | null; sentAtQueue: number; run: (wait: Ma2QueueWait) => Promise<string>; resolve: (value: string) => void; reject: (reason: unknown) => void };

/** Stop commands pass queued reads/cues, but never interrupt the protocol's in-flight response. */
export class Ma2CommandQueue {
  private running: string | null = null;
  private sent = 0;
  private queue: Job[] = [];
  constructor(private readonly now: () => number = () => performance.now()) {}
  /** `kind` names the command for the wait of the commands queued behind it (`ma2CommandKind`). */
  schedule(run: (wait: Ma2QueueWait) => Promise<string>, priority: Ma2CommandPriority, kind = 'command'): Promise<string> {
    return new Promise((resolve, reject) => {
      this.queue.push({ run, priority, kind, queuedAt: this.now(), runningKind: this.running, sentAtQueue: this.sent, resolve, reject });
      void this.drain();
    });
  }
  private async drain(): Promise<void> {
    if (this.running !== null) return;
    while (this.queue.length) {
      const urgent = this.queue.findIndex(entry => entry.priority === 'stop');
      const playback = this.queue.findIndex(entry => entry.priority === 'playback');
      const job = this.queue.splice(urgent >= 0 ? urgent : playback >= 0 ? playback : 0, 1)[0]!;
      const wait: Ma2QueueWait = { waitedMs: this.now() - job.queuedAt, runningKind: job.runningKind, sentBefore: this.sent - job.sentAtQueue };
      this.running = job.kind; this.sent += 1;
      try { job.resolve(await job.run(wait)); } catch (error) { job.reject(error); }
      finally { this.running = null; }
    }
  }
}
