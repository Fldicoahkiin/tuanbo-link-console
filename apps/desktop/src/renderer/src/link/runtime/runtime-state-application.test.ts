import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject } from '@tb/schema';
import { useRuntimeStore } from '../stores/runtime-store';
import { applyRuntimeState } from './runtime-state-application';

vi.mock('../view-models/link-desktop-view-model', () => ({
  linkDesktopViewModel: { recordLog: vi.fn(() => Promise.resolve()) }
}));

describe('applyRuntimeState', () => {
  it('持续丢失或错误状态的无原因更新不会清空首次根因', () => {
    useRuntimeStore.getState().reset();
    useRuntimeStore.getState().setState({ state: 'timecodeLost', reason: 'MTC 信号中断' });
    applyRuntimeState({
      project: createEmptyLinkProject('测试'),
      item: undefined,
      nextCueId: null,
      update: { state: 'timecodeLost', dueCues: [], missedCueIds: [] }
    });
    expect(useRuntimeStore.getState().reason).toBe('MTC 信号中断');
  });
});
