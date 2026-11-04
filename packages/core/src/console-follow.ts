import type { LinkProject } from '@tb/schema';
import { ma2BindingHold } from './ma2-pairing-state';
import { songLightingStatus } from './song-lighting-status';

/** One trigger the song's Timecode show fires on the console, as the console last confirmed it. */
export type ConsoleTrigger = { atMs: number; executor: string; action: 'go' | 'goto' | 'off'; cue: string | null; label: string };

/** An executor read back from the console while the song plays. Null: nothing sits on that executor. */
export type ExecutorObservation = { running: boolean; cue: string; name: string } | null;

/**
 * What the console should be doing now, to confirm it runs with the timecode (root cause 6 of the
 * 2026-10-29 review: the software knew the port was open, never whether the console followed).
 * - `executor`: the last trigger fired at least `settleMs` ago, on that executor;
 * - `wait`: nothing to compare yet (before the first trigger, or a trigger just fired);
 * - `unknown`: this song cannot be checked, and why.
 */
export type ConsoleFollowTarget =
  | { kind: 'unknown'; reason: string }
  | { kind: 'wait'; reason: string }
  | { kind: 'executor'; trigger: ConsoleTrigger; page: number; slot: number };

/** What the status shows: `checking` until the first comparison, `not-following` after two misses in a row. */
export type ConsoleFollow = { state: 'unknown' | 'checking' | 'following' | 'not-following'; detail: string; misses: number };

export const CONSOLE_FOLLOW_SETTLE_MS = 1000;
/** Misses in a row before "not following" is shown: one read can fall between a trigger and the console's reaction. */
export const CONSOLE_FOLLOW_MISSES = 2;

const EXECUTOR = /^([1-9]\d{0,3})\.([1-9]\d{0,2})$/;
const ACTIONS: Record<string, ConsoleTrigger['action']> = { go: 'go', 'go+': 'go', goto: 'goto', off: 'off' };

/**
 * The triggers the console holds for the song, never the local edits not yet written: a song with its
 * own Sequence uses the points as last written; a console show uses the binding's confirmed baseline,
 * or the show's events as last read when the song never took its Cues.
 */
export function consoleTriggers(project: LinkProject, itemId: string): { triggers: ConsoleTrigger[] } | { reason: string } {
  const item = project.rundown.find(entry => entry.id === itemId);
  if (!item) return { reason: '节目单里没有这首歌' };
  const own = item.lighting?.consoleSong;
  if (own) {
    if (!own.timecode || !own.executor) return { reason: '控台上还没有这首歌的时间码节目' };
    const executor = own.executor;
    return { triggers: own.points.flatMap(point => point.atMs === undefined ? [] : [{ atMs: point.atMs, executor, action: 'goto' as const, cue: point.cue, label: `Cue ${point.cue}` }]) };
  }
  const status = songLightingStatus(project, itemId);
  if (status.state === 'duplicate') return { reason: `控台上 Timecode ${status.timecodes.join('、')} 的起点和这首歌相同，分不清控台跑的是哪一个` };
  if (status.state === 'unmatched') return { reason: status.reason ?? '控台上没有和这首歌同一起点的时间码节目' };
  const binding = item.lighting?.ma2Bindings?.find(entry => entry.timecode === status.timecode);
  if (binding) {
    const held = ma2BindingHold(project, itemId, binding.timecode);
    if (held) return { reason: held };
    return { triggers: binding.baselineTracks.flatMap(track => track.clips.flatMap(clip => clip.events.flatMap(event =>
      event.kind === 'ma2' && event.executor ? [{ atMs: clip.start + event.at, executor: event.executor, action: event.action, cue: event.cue ?? null, label: event.label }] : []))) };
  }
  const entry = project.ma2ReadState?.catalog.entries.find(value => value.target === status.timecode);
  if (!entry) return { reason: `还没读过控台 Timecode ${status.timecode} 的内容` };
  return { triggers: entry.events.flatMap(event => {
    const action = ACTIONS[event.action.trim().toLowerCase()];
    return action && EXECUTOR.test(event.executor) && /^\d+(?:\.\d+)?$/.test(event.time)
      ? [{ atMs: Number(event.time) * 1000 / 30, executor: event.executor, action, cue: event.cue, label: event.name ?? (event.cue ? `Cue ${event.cue}` : event.action) }] : [];
  }) };
}

/**
 * The trigger to check at `positionMs`: the last one fired since `sinceMs` (where this run of the song
 * started: after a start or a jump the console only fires what it passes), at least `settleMs` ago, and
 * with no later trigger on the same executor still settling.
 */
export function consoleFollowTarget(triggers: readonly ConsoleTrigger[], positionMs: number, sinceMs: number, settleMs = CONSOLE_FOLLOW_SETTLE_MS): ConsoleFollowTarget {
  if (!triggers.length) return { kind: 'unknown', reason: '这首歌在控台上没有触发执行器的灯光点' };
  const fired = triggers.filter(trigger => trigger.atMs >= sinceMs && trigger.atMs <= positionMs).sort((a, b) => a.atMs - b.atMs);
  const settled = fired.filter(trigger => trigger.atMs <= positionMs - settleMs);
  const last = settled.at(-1);
  if (!last) return { kind: 'wait', reason: fired.length ? '灯光点刚触发，稍后核对' : '还没到这次播放的第一个灯光点' };
  if (fired.some(trigger => trigger.executor === last.executor && trigger.atMs > last.atMs)) return { kind: 'wait', reason: '灯光点刚触发，稍后核对' };
  const [, page, slot] = EXECUTOR.exec(last.executor)!;
  return { kind: 'executor', trigger: last, page: Number(page), slot: Number(slot) };
}

/** The number at the start of the console's cue text, such as "  12.5 Chorus". */
function cueNumber(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)(?:\s|$)/.exec(text);
  return match ? Number(match[1]) : null;
}

/** Whether the executor shows what the trigger should have done. */
export function consoleFollowVerdict(trigger: ConsoleTrigger, observed: ExecutorObservation): { following: boolean; detail: string } {
  const where = `执行器 ${trigger.executor}`;
  if (!observed) return { following: false, detail: `${where} 上没有东西，按时间线这里应该跑“${trigger.label}”` };
  if (trigger.action === 'off') return observed.running
    ? { following: false, detail: `${where} 还在跑，按时间线“${trigger.label}”时应该已经关了` }
    : { following: true, detail: `${where} 按时间线已关闭` };
  if (!observed.running) return { following: false, detail: `${where} 没在跑，按时间线这时应该在跑“${trigger.label}”` };
  if (trigger.action === 'go' || trigger.cue === null) return { following: true, detail: `${where} 在跑` };
  const current = cueNumber(observed.cue);
  // An executor that runs but shows no readable Cue number is not called a miss: no false alarm mid-show.
  if (current === null) return { following: true, detail: `${where} 在跑（读不出当前 Cue 编号）` };
  if (current === Number(trigger.cue)) return { following: true, detail: `${where} 在 Cue ${trigger.cue}，和时间线一致` };
  return { following: false, detail: `${where} 现在在 Cue ${current}，按时间线应该在 Cue ${trigger.cue}（${trigger.label}）` };
}

export function nextConsoleFollow(previous: ConsoleFollow, verdict: { following: boolean; detail: string }): ConsoleFollow {
  if (verdict.following) return { state: 'following', detail: verdict.detail, misses: 0 };
  const misses = previous.misses + 1;
  return misses >= CONSOLE_FOLLOW_MISSES ? { state: 'not-following', detail: verdict.detail, misses }
    : { ...previous, state: previous.state === 'unknown' ? 'checking' : previous.state, misses };
}
