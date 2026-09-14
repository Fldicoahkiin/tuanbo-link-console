import { describe, expect, it } from 'vitest';
import type { LinkAction, LinkCue } from '@tb/schema';
import { CueActionRunner, type ActionExecutionEvent, type LinkActionExecutor } from './cue-action-runner';

describe('CueActionRunner', () => {
  it('停止发生于异步状态记录期间时不再发送排队动作，显式重试仍可用', async () => {
    const executed: string[] = [];
    let active = true;
    const runner = new CueActionRunner([{
      id: 'recording', supports: () => true,
      execute: (action) => { executed.push(action.id); return Promise.resolve(); }
    }], {
      onStatus: (event) => { if (event.actionId === 'second' && event.status === 'running') active = false; return Promise.resolve(); }
    });
    const report = await runner.run(cue(), 'live', () => active);
    expect(executed).toEqual(['first']);
    expect(report.results.map((result) => result.status)).toEqual(['succeeded', 'skipped', 'skipped']);
    await runner.retry('cue', cue().actions[1]!);
    expect(executed).toEqual(['first', 'second']);
  });

  it('blocks remaining actions after a rehearsal failure', async () => {
    const runner = deterministicRunner(new TestExecutor('second'));
    const report = await runner.run(cue(), 'rehearsal');
    expect(report.results.map((result) => result.status)).toEqual(['succeeded', 'failed', 'skipped']);
  });

  it('continues remaining actions after a live failure', async () => {
    const runner = deterministicRunner(new TestExecutor('second'));
    const report = await runner.run(cue(), 'live');
    expect(report.results.map((result) => result.status)).toEqual(['succeeded', 'failed', 'succeeded']);
  });

  it('reports an unsupported action explicitly', async () => {
    const runner = deterministicRunner();
    const report = await runner.run(cue(), 'live');
    expect(report.results[0]).toMatchObject({ status: 'failed', error: '没有执行器支持 midi.programChange' });
  });

  it('creates a new execution id for a manual retry', async () => {
    let nextId = 0;
    const runner = new CueActionRunner([new TestExecutor()], { createExecutionId: () => `run-${++nextId}` });
    const first = await runner.run(cue(), 'live');
    const retry = await runner.retry('cue', cue().actions[0]!);
    expect(first.executionId).toBe('run-1');
    expect(retry.executionId).toBe('run-2');
    expect(retry.action).toEqual(cue().actions[0]);
  });

  it('为当前排练批次中被前序失败阻断的 Cue 生成完整 skipped 报告', async () => {
    const events: ActionExecutionEvent[] = [];
    const runner = new CueActionRunner([], {
      createExecutionId: () => 'skipped-run',
      onStatus: (event) => { events.push(event); return Promise.resolve(); }
    });

    await expect(runner.skip(cue(), 'rehearsal', '前序动作失败')).resolves.toMatchObject({
      executionId: 'skipped-run',
      results: [
        { actionId: 'first', status: 'skipped', error: '前序动作失败' },
        { actionId: 'second', status: 'skipped', error: '前序动作失败' },
        { actionId: 'third', status: 'skipped', error: '前序动作失败' }
      ]
    });
    expect(events.map((event) => event.status)).toEqual(['skipped', 'skipped', 'skipped']);
  });

  it('按 queued、running 和终态记录每个动作', async () => {
    const events: ActionExecutionEvent[] = [];
    const runner = new CueActionRunner([new TestExecutor('second')], {
      createExecutionId: () => 'execution',
      onStatus: (event) => {
        events.push(event);
        return Promise.resolve();
      }
    });
    await runner.run(cue(), 'rehearsal');
    expect(events.map((event) => `${event.actionId}:${event.status}`)).toEqual([
      'first:queued', 'first:running', 'first:succeeded',
      'second:queued', 'second:running', 'second:failed',
      'third:skipped'
    ]);
  });

  it('OBS 请求默认超时形成明确失败且不自动重试', async () => {
    let calls = 0;
    const executor: LinkActionExecutor = {
      id: 'pending-obs',
      supports: () => true,
      execute: () => {
        calls += 1;
        return new Promise(() => undefined);
      }
    };
    const runner = new CueActionRunner([executor], { obsTimeoutMs: 1 });
    const result = await runner.retry('cue', {
      id: 'obs',
      label: 'OBS 切场景',
      kind: 'obs.setProgramScene',
      sceneName: 'Program'
    });
    expect(result).toMatchObject({ status: 'failed', error: 'obs.setProgramScene 执行超过 1ms' });
    expect(calls).toBe(1);
  });
});

class TestExecutor implements LinkActionExecutor {
  readonly id = 'test';

  constructor(private readonly failureId?: string) {}

  supports(): boolean {
    return true;
  }

  execute(action: LinkAction): Promise<void> {
    return action.id === this.failureId
      ? Promise.reject(new Error('测试失败'))
      : Promise.resolve();
  }
}

function deterministicRunner(executor?: LinkActionExecutor): CueActionRunner {
  let now = 0;
  return new CueActionRunner(executor ? [executor] : [], {
    now: () => ++now,
    createExecutionId: () => 'execution'
  });
}

function cue(): LinkCue {
  const action = (id: string, program: number): LinkAction => ({
    id,
    label: id,
    kind: 'midi.programChange',
    portProfileId: 'p1-output',
    channel: 1,
    program
  });
  return {
    id: 'cue',
    name: '测试 Cue',
    timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
    enabled: true,
    notes: '',
    actions: [action('first', 1), action('second', 2), action('third', 3)]
  };
}
