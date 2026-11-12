import { describe, expect, expectTypeOf, it } from 'vitest';
import { nativePlayerStatusSchema, type NativePlayerStatus } from '@tb/schema';
import type { P1ClockObservation } from './p1-clock';
import { clockFromNativeStatus, type ProgramClock } from './program-clock';

const STATUSES: readonly NativePlayerStatus['status'][] = ['preparing', 'ready', 'playing', 'paused', 'stopped', 'ended', 'error'];

function status(patch: Partial<NativePlayerStatus> = {}): NativePlayerStatus {
  return nativePlayerStatusSchema.parse({
    version: 1, sessionId: '6f1c2b0e-8a8d-4c47-9a38-0d6a51f1f6a1', generation: 3, itemId: 'song', status: 'playing', positionMs: 1234,
    offsetMs: 0, sampleRate: 48000, enginePid: null, engineTitle: null, mtcPortName: null, mtcSent: 0, audioError: null, mtcError: null,
    underruns: 0, mtcInterruptions: 0, gain: 1, analysis: null, ...patch
  });
}

describe('clockFromNativeStatus', () => {
  it('联动台播放的状态逐个对应到时钟的状态', () => {
    const states = Object.fromEntries(STATUSES.map(value => [value, clockFromNativeStatus(status({ status: value }), null).state]));
    expect(states).toEqual({ preparing: 'stopped', ready: 'ready', playing: 'running', paused: 'held', stopped: 'stopped', ended: 'ended', error: 'stopped' });
  });

  it('声卡出错时不管状态写的是什么都算放下了这首歌，原因原样带着', () => {
    for (const value of STATUSES) {
      expect(clockFromNativeStatus(status({ status: value, audioError: '声卡断开' }), '10000000')).toMatchObject({ state: 'stopped', reason: '声卡断开' });
    }
    expect(clockFromNativeStatus(status(), '10000000').reason).toBeNull();
  });

  it('身份和位置照抄，来源是联动台播放', () => {
    expect(clockFromNativeStatus(status({ generation: 7, itemId: 'other', positionMs: 42 }), '25000')).toEqual({
      source: 'internal', sessionId: '6f1c2b0e-8a8d-4c47-9a38-0d6a51f1f6a1', generation: 7, itemId: 'other', state: 'running',
      positionMs: 42, observedAtMs: 2.5, reason: null
    } satisfies ProgramClock);
  });

  it('只有声卡给了观测时刻才算一次位置观测：没有或为 0 的是只改了状态', () => {
    expect(clockFromNativeStatus(status(), null).observedAtMs).toBeNull();
    expect(clockFromNativeStatus(status(), '0').observedAtMs).toBeNull();
    // 100 ns QPC ticks to ms, the same number the action MIDI host computed before (Number(qpc) / 10000).
    expect(clockFromNativeStatus(status(), '123456789012345').observedAtMs).toBe(Number('123456789012345') / 10000);
  });

  it('宿主以前按播放状态做的判断，换成时钟以后每一种组合都一样', () => {
    for (const value of STATUSES) for (const audioError of [null, '声卡断开']) for (const qpc of [null, '0', '10000000']) {
      const audio = status({ status: value, audioError }), clock = clockFromNativeStatus(audio, qpc);
      // Closes the song (picture and action MIDI).
      expect(clock.state === 'stopped').toBe(['preparing', 'stopped', 'error'].includes(audio.status) || audio.audioError !== null);
      if (clock.state === 'stopped') continue;
      // Paused; ready or paused is where a preparation may still be admitted.
      expect(clock.state === 'held').toBe(audio.status === 'paused');
      expect(['ready', 'held'].includes(clock.state)).toBe(['ready', 'paused'].includes(audio.status));
      // Moves the outputs: playing or ended with a device observation.
      expect((clock.state === 'running' || clock.state === 'ended') && clock.observedAtMs !== null)
        .toBe((audio.status === 'playing' || audio.status === 'ended') && qpc !== null && qpc !== '0');
      expect(clock.state === 'running').toBe(audio.status === 'playing');
    }
  });

  it('P1 的时钟就是 ProgramClock，只是收窄了', () => {
    expectTypeOf<P1ClockObservation>().toMatchTypeOf<ProgramClock>();
    expectTypeOf<P1ClockObservation['source']>().toEqualTypeOf<'p1'>();
  });
});
