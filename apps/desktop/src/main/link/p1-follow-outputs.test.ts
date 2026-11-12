import { describe, expect, it } from 'vitest';
import type { P1FollowOutputs, ProgramClock } from '@tb/core/link';
import { P1FollowOutputList } from './p1-follow-outputs';

const clock: ProgramClock = { source: 'p1', sessionId: 's', generation: 1, itemId: 'song', state: 'running', positionMs: 100, observedAtMs: 1_000, reason: null };

describe('P1 跟随的几路输出（P3f）', () => {
  it('每一路按顺序都收到；一路出错只报这一路，不碰跟随，也不挡后面的', () => {
    const calls: string[] = [], failed: string[] = [];
    const output = (name: string, broken: boolean): P1FollowOutputs => ({
      observe: () => { calls.push(`${name}:observe`); if (broken) throw new Error('坏了'); },
      hold: () => { calls.push(`${name}:hold`); if (broken) throw new Error('也坏了'); },
      reconcileAt: (_clock, playsOn) => { calls.push(`${name}:reconcile:${String(playsOn)}`); }
    });
    const list = new P1FollowOutputList([{ name: '动作 MIDI', output: output('midi', true) }, { name: '画面', output: output('picture', false) }],
      (name, error) => { failed.push(`${name}:${error.message}`); });
    expect(() => { list.observe(clock); list.hold(); list.reconcileAt(clock, true); }).not.toThrow();
    expect(calls).toEqual(['midi:observe', 'picture:observe', 'midi:hold', 'picture:hold', 'midi:reconcile:true', 'picture:reconcile:true']);
    expect(failed).toEqual(['动作 MIDI:坏了', '动作 MIDI:也坏了']);
  });
});
