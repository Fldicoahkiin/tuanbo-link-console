import { expect, it, vi } from 'vitest';
import { emptyInternalPlayerState } from '../runtime/internal-playback-controller';
import { PlayerViewStore } from './player-view-store';

it('连续设备时钟只通知时钟订阅者，保留每次原始偏移与完整发送位置', () => {
  const store = new PlayerViewStore(), controls = vi.fn(), clocks = vi.fn();
  store.subscribeControl(controls); store.subscribeClock(clocks);
  const state = { ...emptyInternalPlayerState, status: 'playing' as const, itemId: 'song', mtcSentPositionMs: 480000, mtcPositionMs: 480000 };
  store.publish(state); const snapshot = store.readControl(); controls.mockClear(); clocks.mockClear();
  for (let index = 1; index <= 1000; index++) {
    store.publish({ ...state, positionMs: index * 50, mtcPositionMs: 480000 + index * 50, mtcSentPositionMs: 480000 + index * 50 });
  }
  expect(controls).not.toHaveBeenCalled(); expect(clocks).toHaveBeenCalledTimes(1000);
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
  const store = new PlayerViewStore(), control = vi.fn(), clock = vi.fn();
  const off = store.subscribeClock(clock); store.subscribeControl(control);
  store.publish(emptyInternalPlayerState); expect(control).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
  const paused = { ...emptyInternalPlayerState, status: 'paused' as const, positionMs: 90000 };
  store.publish(paused); control.mockClear(); clock.mockClear();
  for (let index = 0; index < 20; index++) store.publish({ ...paused });
  expect(control).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
  off(); store.publish(emptyInternalPlayerState);
  expect(store.readClock().positionMs).toBe(0); expect(clock).not.toHaveBeenCalled();
  expect(control).toHaveBeenCalledOnce();
});
