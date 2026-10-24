import { describe, expect, it, vi } from 'vitest';
import type { ActionExecutionEvent, LinkDesktopApi } from '@tb/core/link';
import { recordRuntimeAction } from './runtime-action-log';

const mocks = vi.hoisted(() => ({ recordLog: vi.fn<(entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise<void>>(() => Promise.resolve()) }));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { recordLog: mocks.recordLog } }));

const event = (status: ActionExecutionEvent['status'], extra: Partial<ActionExecutionEvent> = {}): ActionExecutionEvent => ({
  executionId: 'execution', cueId: 'cue', actionId: 'action', label: '灯光 Cue', kind: 'midi.noteOn', status, at: 10, ...extra });

describe('recordRuntimeAction', () => {
  it('排队和执行中不写日志；结果带耗时，失败和跳过写明原因', async () => {
    await recordRuntimeAction('project', undefined, event('queued'));
    await recordRuntimeAction('project', undefined, event('running'));
    expect(mocks.recordLog).not.toHaveBeenCalled();
    await recordRuntimeAction('project', undefined, event('succeeded', { durationMs: 4 }));
    await recordRuntimeAction('project', undefined, event('failed', { durationMs: 2000, error: 'MIDI 输出超时' }));
    await recordRuntimeAction('project', undefined, event('skipped', { durationMs: 0, error: '运行已暂停，未发送该动作' }));
    expect(mocks.recordLog.mock.calls.map(([entry]) => [entry.level, entry.message, entry.details?.['durationMs']])).toEqual([
      ['info', '灯光 Cue · succeeded', 4],
      ['error', '灯光 Cue · failed：MIDI 输出超时', 2000],
      ['info', '灯光 Cue · skipped：运行已暂停，未发送该动作', 0]]);
    expect(mocks.recordLog.mock.calls.map(([entry]) => entry.device)).toEqual(['midi', 'midi', 'midi']);
  });
});
