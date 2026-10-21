import { expect, it } from 'vitest';
import type { NativePlayerStatus } from '@tb/schema';
import { NativePlayerUiPublisher } from './native-player-ui-publisher';

it('密集时钟只向界面发布每50ms最新位置，故障/切歌/代数变化立即发布', () => {
  let now = 0;
  const sent: NativePlayerStatus[] = [];
  const publisher = new NativePlayerUiPublisher(status => sent.push(status), () => now);
  const state: NativePlayerStatus = { version: 1, sessionId: 'song', generation: 1, itemId: 'one', status: 'playing',
    positionMs: 0, offsetMs: 480000, sampleRate: 48000, enginePid: 1, engineTitle: 'test', mtcPortName: null,
    mtcSent: 0, audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: 1, analysis: null };
  for (now = 0; now <= 100; now += 10) publisher.publish({ ...state, positionMs: now });
  expect(sent.map(status => status.positionMs)).toEqual([0, 50, 100]);
  now = 101; publisher.publish({ ...state, audioError: '设备失效', status: 'error' });
  now = 102; publisher.publish({ ...state, itemId: 'two', generation: 2 });
  now = 103; publisher.publish({ ...state, itemId: 'two', generation: 3, status: 'paused' });
  now = 104; publisher.publish({ ...state, itemId: 'two', generation: 3, status: 'paused', underruns: 1 });
  expect(sent.slice(3).map(status => [status.status, status.generation, status.underruns]))
    .toEqual([['error', 1, 0], ['playing', 2, 0], ['paused', 3, 0], ['paused', 3, 1]]);
});
