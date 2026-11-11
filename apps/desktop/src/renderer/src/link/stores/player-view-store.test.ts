import { expect, it, vi } from 'vitest';
import { emptyInternalPlayerState } from '@tb/core/link';
import { PlayerViewStore, type PlayerClockState } from './player-view-store';
import { ClockSelection } from '../usePlayerClock';

/** A hand-ticked requestAnimationFrame: nothing runs until the test says a frame went by. */
function frames(): { request: (callback: () => void) => void; tick: () => void; pending: () => number } {
  let queue: (() => void)[] = [];
  return {
    request: callback => { queue.push(callback); },
    tick: () => { const due = queue; queue = []; for (const callback of due) callback(); },
    pending: () => queue.length
  };
}

it('连续设备时钟只通知时钟订阅者，一帧一次，保留每次原始偏移与完整发送位置', () => {
  const frame = frames(), store = new PlayerViewStore(frame.request), controls = vi.fn(), clocks = vi.fn();
  store.subscribeControl(controls); store.subscribeClock(clocks);
  const state = { ...emptyInternalPlayerState, status: 'playing' as const, itemId: 'song', mtcSentPositionMs: 480000, mtcPositionMs: 480000 };
  store.publish(state); frame.tick(); const snapshot = store.readControl(); controls.mockClear(); clocks.mockClear();
  for (let index = 1; index <= 1000; index++) {
    store.publish({ ...state, positionMs: index * 50, mtcPositionMs: 480000 + index * 50, mtcSentPositionMs: 480000 + index * 50 });
    if (index % 5 === 0) frame.tick();
  }
  expect(controls).not.toHaveBeenCalled(); expect(clocks).toHaveBeenCalledTimes(200);
  expect(store.readControl()).toBe(snapshot);
  expect(store.readClock()).toEqual({ positionMs: 50000, mtcPositionMs: 530000, mtcSentPositionMs: 530000 });
});

it('切歌和定位先提交成对状态，再通知；故障、音量与MTC参与状态仍立即更新', () => {
  const store = new PlayerViewStore(), seen: unknown[] = [];
  store.subscribeControl(() => seen.push([store.readControl().itemId, store.readClock().positionMs]));
  store.publish({ ...emptyInternalPlayerState, itemId: 'next', status: 'paused', positionMs: 1234 });
  expect(seen).toEqual([['next', 1234]]);
  expect(store.readControl().mtcSending).toBe(false);
  store.publish({ ...emptyInternalPlayerState, volume: 45, mtcSentPositionMs: 0 });
  expect(store.readControl()).toMatchObject({ volume: 45, mtcSending: true });
  store.publish({ ...emptyInternalPlayerState, status: 'error', error: '设备失效', mtcConnectionFailed: true });
  expect(store.readControl()).toMatchObject({ status: 'error', error: '设备失效', mtcConnectionFailed: true, mtcSending: false });
});

it('暂停重复上报不刷新界面；取消订阅和工程重置不残留旧位置', () => {
  const frame = frames(), store = new PlayerViewStore(frame.request), control = vi.fn(), clock = vi.fn();
  const off = store.subscribeClock(clock); store.subscribeControl(control);
  store.publish(emptyInternalPlayerState); frame.tick(); expect(control).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
  const paused = { ...emptyInternalPlayerState, status: 'paused' as const, positionMs: 90000 };
  store.publish(paused); frame.tick(); control.mockClear(); clock.mockClear();
  for (let index = 0; index < 20; index++) { store.publish({ ...paused }); frame.tick(); }
  expect(control).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled(); expect(frame.pending()).toBe(0);
  off(); store.publish(emptyInternalPlayerState); frame.tick();
  expect(store.readClock().positionMs).toBe(0); expect(clock).not.toHaveBeenCalled();
  expect(control).toHaveBeenCalledOnce();
});

it('200 次时钟（约 1 秒）只按帧数通知；readClock 一直是最新值', () => {
  const frame = frames(), store = new PlayerViewStore(frame.request), clocks: number[] = [];
  store.subscribeClock(() => clocks.push(store.readClock().positionMs));
  const playing = { ...emptyInternalPlayerState, status: 'playing' as const, itemId: 'song' };
  let ticks = 0;
  for (let index = 1; index <= 200; index++) {
    store.publish({ ...playing, positionMs: index * 5 });
    expect(store.readClock().positionMs).toBe(index * 5);
    if (index % 3 === 0) { frame.tick(); ticks++; }
  }
  frame.tick(); ticks++;
  expect(clocks).toHaveLength(ticks);
  expect(clocks.at(-1)).toBe(1000);
  frame.tick(); expect(clocks).toHaveLength(ticks);
});

it('控制字段一变马上通知，不等下一帧；时钟仍等这一帧', () => {
  const frame = frames(), store = new PlayerViewStore(frame.request), seen: string[] = [];
  store.subscribeControl(() => seen.push(`control:${store.readControl().status}:${store.readClock().positionMs}`));
  store.subscribeClock(() => seen.push(`clock:${store.readClock().positionMs}`));
  store.publish({ ...emptyInternalPlayerState, status: 'playing', itemId: 'song', positionMs: 10 });
  store.publish({ ...emptyInternalPlayerState, status: 'playing', itemId: 'song', positionMs: 20 });
  store.publish({ ...emptyInternalPlayerState, status: 'paused', itemId: 'song', positionMs: 30, error: '声卡断开' });
  expect(seen).toEqual(['control:playing:10', 'control:paused:30']);
  expect(store.readControl().error).toBe('声卡断开');
  frame.tick();
  expect(seen).toEqual(['control:playing:10', 'control:paused:30', 'clock:30']);
});

it('只订阅一个字段：别的字段变了不换值，相等判断可自定', () => {
  const selection = new ClockSelection();
  const clock = (positionMs: number, mtcSentPositionMs: number | null): PlayerClockState => ({ positionMs, mtcPositionMs: positionMs, mtcSentPositionMs });
  const sent = (value: PlayerClockState): number | null => value.mtcSentPositionMs;
  const first = clock(100, null);
  expect(selection.read(first, sent, Object.is)).toBeNull();
  expect(selection.read(clock(200, null), sent, Object.is)).toBeNull();
  expect(selection.read(clock(300, 300), sent, Object.is)).toBe(300);
  // A selector written inline is a new function each render; an equal value stays the same object.
  const second = { second: 1 };
  const bySecond = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
  const kept = selection.read(clock(1000, 1000), () => second, bySecond);
  expect(selection.read(clock(1005, 1005), () => ({ second: 1 }), bySecond)).toBe(kept);
  expect(selection.read(clock(2000, 2000), () => ({ second: 2 }), bySecond)).toEqual({ second: 2 });
  // Same clock and same selector: the cached value, without calling the selector again.
  const whole = vi.fn((value: PlayerClockState) => value), now = clock(5, 5);
  expect(selection.read(now, whole, Object.is)).toBe(now);
  expect(selection.read(now, whole, Object.is)).toBe(now);
  expect(whole).toHaveBeenCalledOnce();
});
