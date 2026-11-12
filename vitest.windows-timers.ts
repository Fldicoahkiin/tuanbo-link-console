/**
 * Timers as coarse as on Windows, for a test run on Linux or macOS: `pnpm test:windows-timers`.
 *
 * A Windows timer ticks about every 15.6 ms, so `setTimeout(…, 0)` comes back up to 16 ms later; on Linux it takes
 * about 1 ms. A test that steps through a song with a few hundred of them passes in half a second on Linux and runs
 * past its 5 s limit on the Windows runner, which only a release run would show (2026-11-11, and twice more on
 * 2026-11-12). Here every timer waits a whole number of 16 ms ticks. A test that fails under this, or takes seconds
 * longer than in a normal run, waits on timers it does not need: `setImmediate` after everything was awaited, or
 * fake timers. `setImmediate` is left as it is, as on Windows.
 */
const TICK_MS = 16;

const coarse = (delay: unknown): number => Math.ceil(Math.max(typeof delay === 'number' && Number.isFinite(delay) ? delay : 0, 1) / TICK_MS) * TICK_MS;

function onTicks<T extends typeof setTimeout | typeof setInterval>(timer: T): T {
  return new Proxy(timer, {
    apply: (target, self, [handler, delay, ...rest]: unknown[]): unknown => Reflect.apply(target, self, [handler, coarse(delay), ...rest])
  });
}

globalThis.setTimeout = onTicks(globalThis.setTimeout);
globalThis.setInterval = onTicks(globalThis.setInterval);
