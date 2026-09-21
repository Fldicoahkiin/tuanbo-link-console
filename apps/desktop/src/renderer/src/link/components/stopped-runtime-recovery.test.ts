import { describe, expect, it } from 'vitest';
import { needsStoppedRuntimeRecovery } from './useStoppedRuntimeRecovery';
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
});
