import { expect, it, vi } from 'vitest';
import { mediaPlaybackClock } from './playback-clock';

class AudioClockSource extends EventTarget {
  currentTime = 1.5; duration = 90; readyState = 4;
  paused = false; ended = false; seeking = false;
}

it('编辑器读取真实音频位置，不根据界面计时器外推；音频关闭后不可继续录制', () => {
  let audio: AudioClockSource | null = new AudioClockSource();
  const clock = mediaPlaybackClock(() => audio);
  expect(clock.read()).toEqual({ positionMs: 1500, durationMs: 90000, ready: true, playing: true, seeking: false });
  audio.currentTime = 32.125; audio.paused = true;
  expect(clock.read()).toMatchObject({ positionMs: 32125, playing: false, ready: true });
  audio = null;
  expect(clock.read()).toEqual({ positionMs: 0, durationMs: 0, ready: false, playing: false, seeking: false });
});

it('暂停、定位和结束边界分别通知录制；订阅清理后旧音源不能再中断新录制', () => {
  const first = new AudioClockSource(); let audio = first;
  const clock = mediaPlaybackClock(() => audio), listener = vi.fn();
  const unsubscribe = clock.subscribeBoundary(listener);
  first.dispatchEvent(new Event('pause')); first.dispatchEvent(new Event('seeking')); first.dispatchEvent(new Event('ended'));
  expect(listener.mock.calls).toEqual([['pause'], ['seek'], ['end']]);
  audio = new AudioClockSource(); unsubscribe(); listener.mockClear();
  first.dispatchEvent(new Event('pause')); audio.dispatchEvent(new Event('pause'));
  expect(listener).not.toHaveBeenCalled();
  const cleanup = clock.subscribeBoundary(listener);
  audio.dispatchEvent(new Event('ended')); expect(listener).toHaveBeenCalledWith('end'); cleanup();
});
