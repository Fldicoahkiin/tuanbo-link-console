import { describe, expect, it } from 'vitest';
import { toUserErrorMessage } from './link-user-error';
import { deriveShowState, isShowWait, showGate, showOperationRules, SHOW_WAIT_CLOCK_MOVING, SHOW_WAIT_SHOW_ON, type ShowOperation, type ShowState } from './show-state';

/**
 * The operator's rules on when the show holds an operation back, one describe block per rule. A change that breaks a
 * rule fails here even when the tests written for that change still pass: fix the change, not this file.
 */

const operations = Object.keys(showOperationRules) as ShowOperation[];
const show = (phase: Exclude<ShowState['phase'], 'idle' | 'held'>, itemId: string | null = 'a'): ShowState => ({ phase, source: 'internal', itemId, program: null });
const held = (reason: 'paused' | 'ended' | 'p1-waiting'): ShowState => ({ phase: 'held', source: reason === 'p1-waiting' ? 'p1' : 'internal', itemId: 'a', reason, program: null });
const heldStates = [held('paused'), held('ended'), held('p1-waiting')];
const busyStates = [show('preparing'), show('running'), show('stopping')];
const allStates: ShowState[] = [{ phase: 'idle', program: null }, ...busyStates, ...heldStates];
/** 第 3 题 opened exactly these: sync the console, refresh its pages, change its executors, check the connections. */
const openedWhileHeld: ShowOperation[] = ['ma2.sync.write', 'ma2.executorPage.refresh', 'ma2.executor.mutate', 'ma2.check'];

describe('2026-11-10 第 3 题：只有节目在走才算在播放；暂停、播完暂停、P1 等下一首时照常同步控台、刷新控台页、改执行器、检查连接', () => {
  it('暂停、播完暂停、P1 等下一首时这四类操作都可以', () => {
    for (const state of heldStates) for (const op of openedWhileHeld) expect(showGate(op, state), `${op} @ ${state.phase}`).toEqual({ kind: 'allow' });
  });

  it('节目在走、准备中、停止中时它们等，单击 Cue 试听也等', () => {
    for (const state of busyStates) for (const op of [...openedWhileHeld, 'ma2.audition'] satisfies ShowOperation[]) {
      expect(showGate(op, state), `${op} @ ${state.phase}`).toMatchObject({ kind: 'wait', until: 'clock-stopped' });
    }
  });

  it('暂停时单击 Cue 照旧直接试听', () => {
    for (const state of heldStates) expect(showGate('ma2.audition', state)).toEqual({ kind: 'allow' });
  });
});

describe('2026-11-11 第 7 题：音乐在走就算在播放，不看 MTC 输出开没开', () => {
  it('联动台播放关掉 MTC 输出时，音乐在放仍算在走，控台操作照样等', () => {
    const playing = { status: 'playing', itemId: 'a', positionMs: 1_000, durationMs: 60_000, lightingOffOwed: false, mtcEnabled: false } as const;
    const state = deriveShowState({ internal: playing, p1: null, preview: false, program: null });
    expect(state).toMatchObject({ phase: 'running' });
    for (const op of openedWhileHeld) expect(showGate(op, state)).toMatchObject({ kind: 'wait' });
  });
});

describe('2026-11-10 第 10 题：onPC 页演出中能按', () => {
  it('ma2.executorPage.press 任何时候都可以', () => {
    for (const state of allStates) expect(showGate('ma2.executorPage.press', state)).toEqual({ kind: 'allow' });
  });
});

describe('2026-11-10 第 2 题：断线自动恢复，任何时候都可以', () => {
  it('ma2.reconnect、obs.reconnect 任何时候都可以', () => {
    for (const state of allStates) for (const op of ['ma2.reconnect', 'obs.reconnect'] satisfies ShowOperation[]) expect(showGate(op, state)).toEqual({ kind: 'allow' });
  });
});

describe('2026-11-11 第 5 题：在台上的歌（准备中、播放中、暂停）换音频、修剪音频、加空白、改 MTC 起始码要停下才能改；画面、机位、灯光点、动作这一遍立即生效', () => {
  it('这首歌在台上时 song.audio.edit 等到停止，别的歌可以改', () => {
    for (const state of [show('preparing'), show('running'), ...heldStates]) {
      expect(showGate('song.audio.edit', state, 'a')).toMatchObject({ kind: 'wait', until: 'idle' });
      expect(showGate('song.audio.edit', state, 'b')).toEqual({ kind: 'allow' });
    }
  });

  it('编辑工程（画面、机位、灯光点、动作）任何时候都可以', () => {
    for (const state of allStates) expect(showGate('edit.document', state)).toEqual({ kind: 'allow' });
  });
});

describe('AGENTS §4 等待不算失败：等待文案固定开头，报错转换时原样保留', () => {
  const waits = operations.flatMap(op => allStates.map(state => showGate(op, state, 'a'))).filter(gate => gate.kind === 'wait');

  it('所有等待都以固定开头开始，认得出是等待', () => {
    expect(waits.length).toBeGreaterThan(0);
    for (const gate of waits) {
      expect(gate.message.startsWith(gate.until === 'clock-stopped' ? SHOW_WAIT_CLOCK_MOVING : SHOW_WAIT_SHOW_ON), gate.message).toBe(true);
      expect(isShowWait(new Error(gate.message))).toBe(true);
    }
  });

  it('toUserErrorMessage 原样保留等待文案，经 Electron 包装也一样', () => {
    for (const gate of waits) {
      expect(toUserErrorMessage(new Error(gate.message))).toBe(gate.message);
      expect(toUserErrorMessage({ message: `Error invoking remote method 'link:any': Error: ${gate.message}` })).toBe(gate.message);
    }
  });
});

describe('00-order §2.4：“现在算不算在演出”全软件只问 showGate', () => {
  it('节目单排序和改歌的音频（含加空白）在表里', () => {
    expect(operations).toEqual(expect.arrayContaining(['rundown.reorder', 'song.audio.edit']));
  });
});
