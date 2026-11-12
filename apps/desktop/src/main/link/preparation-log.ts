import type { LinkLogInput } from './run-logger';

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

/** The timed steps of one preparation of the next song ahead (NativeAudioPreload): `add` as each step ends, `done` once
 * it is prepared. One that is let go before it is prepared (replaced, another song next, stop) never calls `done`. */
export type AheadSteps = { add: (step: string, ms: number) => void; done: (totalMs: number) => void };
/** Steps for one preparation ahead of the song `itemId`, kept apart from every other preparation. */
export type MeasureAhead = (itemId: string) => AheadSteps;

/** The next song prepared ahead in the run log: each preparation keeps its own steps and, once it is prepared, writes
 * one 下一首的音频已提前准备好 entry for its song, so none of them reach the 音频已准备好 entry or a notice of another song.
 * A slow step is reported as it happens, as for the song being prepared. A log that cannot be written goes to the console. */
export function aheadAudioLog(slow: (step: string, ms: number) => void, record: (entry: LinkLogInput) => Promise<unknown>): MeasureAhead {
  return itemId => {
    const steps = new PreparationSteps(slow);
    return {
      add: (step, ms) => steps.add(step, ms),
      done: totalMs => {
        void record({ level: 'info', category: 'system', device: '音频', itemId, message: '下一首的音频已提前准备好',
          details: { totalMs: Math.round(totalMs), steps: steps.take() } })
          .catch((failure: unknown) => console.error('下一首音频准备日志写入失败', failure));
      }
    };
  };
}

/** The audio player's error entries in the run log, as the player's `error` and `preloadError`. A failure of the song
 * being prepared takes the steps it got through. Whatever goes wrong with the next song prepared ahead is not that
 * song's failure, so it is recorded without taking them, and they stay for its 音频已准备好 entry. A log that cannot be
 * written goes to the console. */
export function audioErrorLog(steps: PreparationSteps, record: (entry: LinkLogInput) => Promise<unknown>):
  { error: (message: string) => void; preloadError: (message: string) => void } {
  const write = (entry: LinkLogInput): void => {
    void record(entry).catch((failure: unknown) => console.error('正式音频日志写入失败', failure));
  };
  return {
    error: message => {
      const taken = steps.take();
      write({ level: 'error', category: 'device', device: '音频', message, result: 'failed', ...(taken.length ? { details: { steps: taken } } : {}) });
    },
    preloadError: message => write({ level: 'error', category: 'device', device: '音频', message, result: 'failed' })
  };
}
