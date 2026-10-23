import { describe, expect, it } from 'vitest';
import type { LinkRuntimeState } from '@tb/core/link';
import { needsStoppedRuntimeRecovery, stoppedRuntimeRelease } from './useStoppedRuntimeRecovery';
describe('停止播放器残留会话恢复', () => {
  it('只回收已停止或故障且音频确实暂停的内部会话', () => {
    expect(needsStoppedRuntimeRecovery(true, 'stopped', 'running', true)).toBe(true);
    expect(needsStoppedRuntimeRecovery(true, 'error', 'timecodeLost', true)).toBe(true);
    expect(needsStoppedRuntimeRecovery(true, 'stopped', 'paused', true)).toBe(true);
    expect(needsStoppedRuntimeRecovery(true, 'playing', 'running', false)).toBe(false);
    expect(needsStoppedRuntimeRecovery(true, 'stopped', 'running', false)).toBe(false);
    expect(needsStoppedRuntimeRecovery(false, 'stopped', 'running', true)).toBe(false);
    expect(needsStoppedRuntimeRecovery(true, 'preparing', 'preflight', true)).toBe(false);
    expect(needsStoppedRuntimeRecovery(true, 'paused', 'paused', true)).toBe(false);
    expect(needsStoppedRuntimeRecovery(true, 'stopped', 'stopping', true)).toBe(false);
  });

  // Field log 2026-10-23: a failed native play left the view in error; each release set it idle and the
  // next native event mirrored the error back — 2802 releases in two minutes.
  it('播放器停在同一个故障上时，运行视图反复回到 error 也只回收一次；原生播放器不回收', () => {
    const releases = (native: boolean): number => {
      let attempted = false, runtime: LinkRuntimeState = 'error', count = 0;
      for (let event = 0; event < 50; event++) {
        const next = stoppedRuntimeRelease(attempted, { native, internal: true, status: 'error', runtime, audioPaused: true });
        attempted = next.attempted;
        if (next.release) { count++; runtime = 'idle'; } else if (runtime === 'idle') runtime = 'error';
      }
      return count;
    };
    expect(releases(true)).toBe(0);
    expect(releases(false)).toBe(1);
  });

  it('播放器重新开始后，下一次停止留下的会话仍会回收', () => {
    const input = { native: false, internal: true, runtime: 'running' as const, audioPaused: true };
    let state = stoppedRuntimeRelease(false, { ...input, status: 'stopped' });
    expect(state).toEqual({ attempted: true, release: true });
    state = stoppedRuntimeRelease(state.attempted, { ...input, status: 'stopped' });
    expect(state.release).toBe(false);
    state = stoppedRuntimeRelease(state.attempted, { ...input, status: 'preparing', audioPaused: false });
    expect(state).toEqual({ attempted: false, release: false });
    expect(stoppedRuntimeRelease(state.attempted, { ...input, status: 'stopped' }).release).toBe(true);
  });
});
