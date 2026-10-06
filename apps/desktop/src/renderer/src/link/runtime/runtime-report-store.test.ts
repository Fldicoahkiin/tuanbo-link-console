import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionExecutionResult, CueExecutionReport } from '@tb/core/link';
import { useRuntimeStore } from '../stores/runtime-store';
import { appendCueReport, appendMediaReport, appendRetryActionReport } from './runtime-report-store';

describe('runtime report store', () => {
  beforeEach(() => useRuntimeStore.getState().reset());

  it('五万次执行仅保留最近界面记录，完整原报告不被修改', () => {
    const report: CueExecutionReport = { executionId: 'run', cueId: 'cue', mode: 'live', startedAt: 0, finishedAt: 1, results: [] };
    for (let index = 0; index < 50000; index++) appendCueReport({ ...report, executionId: String(index) });
    expect(useRuntimeStore.getState().reports).toHaveLength(256);
    expect(useRuntimeStore.getState().reports[0]!.executionId).toBe('49744');
    expect(useRuntimeStore.getState().reports.at(-1)!.executionId).toBe('49999');
    const action = { id: 'scene', label: '场景', kind: 'obs.setProgramScene' as const, sceneName: 'A' };
    const results: ActionExecutionResult[] = Array.from({ length: 3000 }, (_, index) => ({ executionId: 'big', cueId: 'cue', actionId: String(index),
      action, kind: action.kind, status: 'succeeded', startedAt: 0, finishedAt: 1, durationMs: 1 }));
    appendCueReport({ ...report, results });
    expect(results).toHaveLength(3000);
    expect(useRuntimeStore.getState().reports.flatMap(entry => entry.results)).toHaveLength(2048);
    expect(useRuntimeStore.getState().reports.at(-1)!.results[0]!.actionId).toBe('952');
    useRuntimeStore.getState().reset();
    expect(useRuntimeStore.getState().reports).toEqual([]);
  });

  it('长节目素材执行报告同样有界，失败结果保持可见', () => {
    const event = { id: 'event', itemId: 'song', clipId: 'clip', layerId: 'layer', assetId: 'asset', assetName: '素材', assetKind: 'video' as const,
      sourceName: 'source', relativePath: 'media.mp4', frameNumber: 0, phase: 'start' as const, sourceOffsetMs: 0,
      layerIndex: 0, layerCount: 1, embeddedAudioEnabled: false, transform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 } };
    for (let index = 0; index < 1000; index++) appendMediaReport({ executionId: String(index), event, status: 'failed', startedAt: index, finishedAt: index + 1, durationMs: 1, error: '输出失败' });
    expect(useRuntimeStore.getState().mediaReports).toHaveLength(256);
    expect(useRuntimeStore.getState().mediaReports.at(-1)).toMatchObject({ executionId: '999', status: 'failed', error: '输出失败' });
  });

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
