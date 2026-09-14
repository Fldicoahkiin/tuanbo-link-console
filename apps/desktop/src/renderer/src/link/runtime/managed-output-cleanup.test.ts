import { describe, expect, it, vi } from 'vitest';
import type { LinkCue } from '@tb/schema';
import type { ManagedMediaExecutionReport } from '../stores/runtime-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { executeManagedOutputCleanup } from './managed-output-cleanup';

describe('executeManagedOutputCleanup', () => {
  it('单个清理失败后仍继续尝试其余媒体和机位，最后聚合错误', async () => {
    useRuntimeStore.getState().reset();
    const cue = cleanupCue();
    const mediaReport = {
      executionId: 'media-run', event: mediaEvent(), status: 'failed',
      startedAt: 0, finishedAt: 1, durationMs: 1, error: '媒体停止失败'
    } satisfies ManagedMediaExecutionReport;
    const runtime = {
      executeMedia: vi.fn(() => Promise.resolve(mediaReport)),
      compileVisualCue: vi.fn((value: LinkCue) => value),
      applyVisualCueResult: vi.fn()
    };
    const runner = {
      run: vi.fn(() => Promise.resolve({
        executionId: 'cue-run', cueId: cue.id, mode: 'live' as const, startedAt: 0, finishedAt: 1,
        results: [{
          executionId: 'cue-run', cueId: cue.id, actionId: cue.actions[0]!.id, action: cue.actions[0]!,
          kind: cue.actions[0]!.kind, status: 'failed' as const, startedAt: 0, finishedAt: 1,
          durationMs: 1, error: '机位隐藏失败'
        }]
      }))
    };

    await expect(executeManagedOutputCleanup({ mediaEvents: [mediaEvent()], cameraCues: [cue] }, runtime, runner))
      .rejects.toThrow('受管 OBS 输出清理不完整：媒体停止失败；机位隐藏失败');
    expect(runtime.executeMedia).toHaveBeenCalledOnce();
    expect(runner.run).toHaveBeenCalledOnce();
    expect(useRuntimeStore.getState()).toMatchObject({ mediaReports: [{ status: 'failed' }], reports: [{ cueId: cue.id }] });
  });
});

function cleanupCue(): LinkCue {
  return {
    id: 'cleanup-camera', name: '停止机位', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
    enabled: true, notes: '', layerId: 'layer', actions: [{
      id: 'hide-camera', label: '隐藏机位', kind: 'obs.setSceneItemEnabled',
      sceneName: '团播联动台输出', sourceName: 'Camera', enabled: false
    }]
  };
}

function mediaEvent() {
  return {
    id: 'managed-media:clip:stop', phase: 'stop' as const, frameNumber: 30,
    itemId: 'item', clipId: 'clip', layerId: 'layer', layerIndex: 0, layerCount: 1,
    sourceName: 'managed', assetId: 'asset', assetName: 'clip.mp4', assetKind: 'video' as const,
    relativePath: 'assets/reference-media/clip.mp4', sourceOffsetMs: 0, embeddedAudioEnabled: true,
    transform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 }
  };
}
