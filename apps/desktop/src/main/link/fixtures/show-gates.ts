import { showGate, type ShowGateReader, type ShowState } from '@tb/core/link';

/** The show as the MA2 services' tests set it: each reader answers through the real `showGate`, as ShowStateService does. */
export const idleShow: ShowState = { phase: 'idle', program: null };
export const runningShow: ShowState = { phase: 'running', source: 'internal', itemId: 'song', program: null };
export const pausedShow: ShowState = { phase: 'held', source: 'internal', itemId: 'song', reason: 'paused', program: null };

export const showReader = (show: () => ShowState): ShowGateReader => op => showGate(op, show());
export const showStopped: ShowGateReader = showReader(() => idleShow);
export const showRunning: ShowGateReader = showReader(() => runningShow);
export const showPaused: ShowGateReader = showReader(() => pausedShow);
/** The program moves while `moving()` says so, otherwise it is stopped. */
export const showMovingWhen = (moving: () => boolean): ShowGateReader => showReader(() => moving() ? runningShow : idleShow);
