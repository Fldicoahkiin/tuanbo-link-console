import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionExecutionResult } from '@tb/core/link';
import { useRuntimeStore } from '../stores/runtime-store';
import { appendRetryActionReport } from './runtime-report-store';

describe('runtime report store', () => {
  beforeEach(() => useRuntimeStore.getState().reset());

  it('把单动作重试作为新的执行记录追加到面板', () => {
    const action = {
      id: 'retry-action',
      label: '重试切换场景',
      kind: 'obs.setProgramScene' as const,
      sceneName: '主场景'
    };
    const result = {
      executionId: 'retry-run',
      cueId: 'cue-1',
      actionId: action.id,
      action,
      kind: action.kind,
      status: 'succeeded',
      startedAt: 10,
      finishedAt: 12,
      durationMs: 2
    } satisfies ActionExecutionResult;

    appendRetryActionReport(result, 'live');

    expect(useRuntimeStore.getState().reports).toEqual([{
      executionId: 'retry-run',
      cueId: 'cue-1',
      mode: 'live',
      startedAt: 10,
      finishedAt: 12,
      results: [result]
    }]);
  });
});
