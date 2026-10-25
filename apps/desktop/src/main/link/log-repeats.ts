/**
 * Folds identical run-log entries so one fault repeating every second cannot bury the rest of the log.
 *
 * Entries are identical when level, category, device, message, the project/item/cue/action/execution ids and
 * the result all match; details may differ, and the latest details travel with the summary. The first `keep`
 * entries of a burst are written as usual, later ones are only counted, and once the window ends one summary
 * entry states how many were merged and when the first and last happened. While the fault keeps repeating the
 * window doubles up to `maxWindowMs`, and only summaries are written, so an hour of the same error costs a
 * handful of lines instead of thousands.
 */
export const LOG_REPEAT = { windowMs: 60_000, maxWindowMs: 10 * 60_000, keep: 3, maxKeys: 500 } as const;

export type RepeatableEntry = {
  level: string;
  category: string;
  message: string;
  device?: string;
  projectId?: string;
  itemId?: string;
  cueId?: string;
  actionId?: string;
  executionId?: string;
  result?: string;
  details?: Readonly<Record<string, unknown>>;
};

type Burst<T extends RepeatableEntry> = {
  sample: T;
  startedAt: number;
  windowMs: number;
  written: number;
  /** Merged and not yet summarised. */
  merged: number;
  /** Merged in this window, summarised or not: decides whether the next window continues the fault. */
  mergedInWindow: number;
  firstMergedAt: number;
  lastMergedAt: number;
  lastDetails: Readonly<Record<string, unknown>> | undefined;
  /** True once the fault outlived a window: the next window writes summaries only. */
  continuing: boolean;
};

export type RepeatDecision = 'write' | 'merge';

export class LogRepeats<T extends RepeatableEntry> {
  private readonly bursts = new Map<string, Burst<T>>();

  constructor(private readonly limits: { windowMs: number; maxWindowMs: number; keep: number; maxKeys: number } = LOG_REPEAT) {}

  /** Whether `entry` is written now or only counted into its burst. */
  admit(entry: T, now: number): RepeatDecision {
    const key = repeatKey(entry);
    const burst = this.bursts.get(key);
    if (!burst || now - burst.startedAt >= burst.windowMs) {
      // A fresh burst; a fault that kept repeating straight through the last window continues without new copies.
      const continuing = burst !== undefined && burst.mergedInWindow > 0 && now - burst.startedAt < burst.windowMs * 2;
      const windowMs = continuing ? Math.min(burst.windowMs * 2, this.limits.maxWindowMs) : this.limits.windowMs;
      if (!continuing) this.trim();
      const next: Burst<T> = { sample: entry, startedAt: now, windowMs, written: continuing ? this.limits.keep : 1, merged: continuing ? 1 : 0,
        mergedInWindow: continuing ? 1 : 0, firstMergedAt: now, lastMergedAt: now, lastDetails: entry.details, continuing };
      this.bursts.delete(key); this.bursts.set(key, next);
      return continuing ? 'merge' : 'write';
    }
    if (burst.written < this.limits.keep) { burst.written++; return 'write'; }
    if (burst.merged === 0) burst.firstMergedAt = now;
    burst.merged++; burst.mergedInWindow++; burst.lastMergedAt = now; burst.lastDetails = entry.details;
    return 'merge';
  }

  /**
   * Summaries owed at `now`: every burst whose window ended with merged entries, or with `all`, every burst
   * holding merged entries (before a query, an export or quitting). A summarised burst keeps its window.
   */
  settle(now: number, all = false): T[] {
    const summaries: T[] = [];
    for (const burst of this.bursts.values()) {
      if (burst.merged === 0 || !all && now - burst.startedAt < burst.windowMs) continue;
      summaries.push(summary(burst));
      burst.merged = 0;
    }
    return summaries;
  }

  /** When the next window with merged entries ends, or null. */
  nextDue(): number | null {
    let due: number | null = null;
    for (const burst of this.bursts.values()) {
      if (burst.merged === 0) continue;
      const end = burst.startedAt + burst.windowMs;
      if (due === null || end < due) due = end;
    }
    return due;
  }

  /** Keeps the table bounded: the oldest bursts with nothing left to summarise go first. A burst still owing a
   * summary always stays; the timer summarises it within one window, after which it can go. */
  private trim(): void {
    for (const [key, burst] of this.bursts) {
      if (this.bursts.size < this.limits.maxKeys) return;
      if (burst.merged === 0) this.bursts.delete(key);
    }
  }
}

function repeatKey(entry: RepeatableEntry): string {
  return JSON.stringify([entry.level, entry.category, entry.device ?? null, entry.message, entry.projectId ?? null, entry.itemId ?? null,
    entry.cueId ?? null, entry.actionId ?? null, entry.executionId ?? null, entry.result ?? null]);
}

function summary<T extends RepeatableEntry>(burst: Burst<T>): T {
  const seconds = Math.max(1, Math.round((burst.lastMergedAt - burst.firstMergedAt) / 1000));
  const span = burst.merged === 1 ? '' : `在 ${seconds} 秒内`;
  return {
    ...burst.sample,
    message: `${burst.sample.message}（${span}又重复 ${burst.merged} 次，已合并为本条）`,
    details: {
      repeat: { merged: burst.merged, firstAt: new Date(burst.firstMergedAt).toISOString(), lastAt: new Date(burst.lastMergedAt).toISOString(),
        continuing: burst.continuing },
      ...(burst.lastDetails ? { lastDetails: burst.lastDetails } : {})
    }
  };
}
