/** Serial cleanup barrier for cancellable OBS preparation. In-flight network
 * operations settle before cleanup; no later preparation step may run. */
export class InternalPreparationScope {
  private abort: AbortController | null = null;
  private pending: Promise<void> | null = null;

  async run(stop: () => Promise<void>, operation: (assertCurrent: () => void) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const stopping = stop();
    const abort = new AbortController(); this.abort = abort;
    const assertCurrent = (): void => { if (abort.signal.aborted || signal?.aborted) throw new Error('本次画面联动准备已取消'); };
    await stopping; assertCurrent();
    const pending = operation(assertCurrent); this.pending = pending;
    try { await pending; assertCurrent(); }
    finally { if (this.pending === pending) this.pending = null; if (this.abort === abort) this.abort = null; }
  }

  cancel(): void { this.abort?.abort(); }

  settledBefore(cleanupTail: Promise<void>): Promise<void> {
    // The operation caller still receives its rejection. This barrier only
    // orders cleanup after requests which have already left the process.
    return this.pending ? Promise.allSettled([cleanupTail, this.pending]).then(() => undefined) : cleanupTail;
  }
}
