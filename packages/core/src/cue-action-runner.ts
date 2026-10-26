import type { LinkAction, LinkCue } from '@tb/schema';
import type { LinkRunMode } from './cue-runtime';

export type ActionExecutionStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';

export type ActionExecutionResult = {
  executionId: string;
  cueId: string;
  actionId: string;
  action: LinkAction;
  kind: LinkAction['kind'];
  status: ActionExecutionStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  error?: string;
};

export type LinkActionExecutor = {
  readonly id: string;
  supports(action: LinkAction): boolean;
  execute(action: LinkAction): Promise<void>;
};

export type CueExecutionReport = {
  executionId: string;
  cueId: string;
  mode: LinkRunMode;
  startedAt: number;
  finishedAt: number;
  results: ActionExecutionResult[];
};

export type ActionExecutionEvent = {
  executionId: string;
  cueId: string;
  actionId: string;
  label: string;
  kind: LinkAction['kind'];
  status: ActionExecutionStatus;
  at: number;
  /** Results only (succeeded, failed, skipped): how long the action took. */
  durationMs?: number;
  error?: string;
};

/**
 * The run-log entry for an action event, or null: only a result is recorded, with how long the action took
 * and, when it failed or was skipped, why. Every external action has a time limit, so a result always follows.
 */
export function actionResultLog(event: ActionExecutionEvent): { level: 'info' | 'error'; message: string; result: 'succeeded' | 'failed' | 'skipped'; details: Record<string, unknown> } | null {
  if (event.status === 'queued' || event.status === 'running') return null;
  return { level: event.status === 'failed' ? 'error' : 'info', message: `${event.label} · ${event.status}${event.error ? `：${event.error}` : ''}`, result: event.status,
    details: { kind: event.kind, at: event.at, durationMs: event.durationMs ?? 0, ...(event.error ? { error: event.error } : {}) } };
}

type RunnerOptions = {
  stopOnFailure?: boolean;
  now?: () => number;
  createExecutionId?: () => string;
  obsTimeoutMs?: number;
  onStatus?: (event: ActionExecutionEvent) => Promise<void>;
};

export class CueActionRunner {
  private readonly stopOnFailure: boolean;
  private readonly now: () => number;
  private readonly createExecutionId: () => string;
  private readonly obsTimeoutMs: number;
  private readonly onStatus: ((event: ActionExecutionEvent) => Promise<void>) | null;

  constructor(private readonly executors: readonly LinkActionExecutor[], options: RunnerOptions = {}) {
    this.stopOnFailure = options.stopOnFailure ?? false;
    this.now = options.now ?? (() => performance.now());
    this.createExecutionId = options.createExecutionId ?? (() => crypto.randomUUID());
    this.obsTimeoutMs = options.obsTimeoutMs ?? 2_000;
    this.onStatus = options.onStatus ?? null;
  }

  async run(cue: LinkCue, mode: LinkRunMode, canExecute: () => boolean = () => true): Promise<CueExecutionReport> {
    const executionId = this.createExecutionId();
    const startedAt = this.now();
    const results: ActionExecutionResult[] = [];
    let blocked = false;

    for (const action of cue.actions) {
      if (blocked) {
        const at = this.now();
        const skipped = createResult(executionId, cue.id, action, 'skipped', at, at, mode === 'rehearsal' ? '排练时前面的动作失败了，后面的动作不再执行' : '这个输出前面的动作失败了，后面的动作不再执行');
        results.push(skipped);
        await this.emit(action, skipped.status, executionId, cue.id, at, skipped.error, 0);
        continue;
      }
      const result = await this.executeAction(executionId, cue.id, action, canExecute);
      results.push(result);
      if ((mode === 'rehearsal' || this.stopOnFailure) && result.status === 'failed') blocked = true;
    }

    return {
      executionId,
      cueId: cue.id,
      mode,
      startedAt,
      finishedAt: this.now(),
      results
    };
  }

  async retry(cueId: string, action: LinkAction): Promise<ActionExecutionResult> {
    return this.executeAction(this.createExecutionId(), cueId, action);
  }

  async skip(cue: LinkCue, mode: LinkRunMode, error: string): Promise<CueExecutionReport> {
    const executionId = this.createExecutionId();
    const startedAt = this.now();
    const results: ActionExecutionResult[] = [];
    for (const action of cue.actions) {
      const at = this.now();
      const result = createResult(executionId, cue.id, action, 'skipped', at, at, error);
      results.push(result);
      await this.emit(action, result.status, executionId, cue.id, at, error, 0);
    }
    return { executionId, cueId: cue.id, mode, startedAt, finishedAt: this.now(), results };
  }

  private async executeAction(executionId: string, cueId: string, action: LinkAction, canExecute: () => boolean = () => true): Promise<ActionExecutionResult> {
    const queuedAt = this.now();
    await this.emit(action, 'queued', executionId, cueId, queuedAt);
    const startedAt = this.now();
    await this.emit(action, 'running', executionId, cueId, startedAt);
    if (!canExecute()) {
      const finishedAt = this.now();
      const result = createResult(executionId, cueId, action, 'skipped', startedAt, finishedAt, '运行已暂停或停止，这个动作没有发送');
      await this.emit(action, result.status, executionId, cueId, finishedAt, result.error, result.durationMs);
      return result;
    }
    const executor = this.executors.find((candidate) => candidate.supports(action));
    if (!executor) {
      const finishedAt = this.now();
      const result = createResult(executionId, cueId, action, 'failed', startedAt, finishedAt, `没有执行器支持 ${action.kind}`);
      await this.emit(action, result.status, executionId, cueId, finishedAt, result.error, result.durationMs);
      return result;
    }

    let result: ActionExecutionResult;
    try {
      const execution = executor.execute(action);
      await (action.kind.startsWith('obs.') ? withTimeout(execution, this.obsTimeoutMs, action.kind) : execution);
      const finishedAt = this.now();
      result = createResult(executionId, cueId, action, 'succeeded', startedAt, finishedAt);
    } catch (error) {
      const finishedAt = this.now();
      const message = error instanceof Error ? error.message : String(error);
      result = createResult(executionId, cueId, action, 'failed', startedAt, finishedAt, message);
    }
    await this.emit(action, result.status, executionId, cueId, result.finishedAt, result.error, result.durationMs);
    return result;
  }

  private async emit(
    action: LinkAction,
    status: ActionExecutionStatus,
    executionId: string,
    cueId: string,
    at: number,
    error?: string,
    durationMs?: number
  ): Promise<void> {
    if (!this.onStatus) return;
    await this.onStatus({
      executionId,
      cueId,
      actionId: action.id,
      label: action.label,
      kind: action.kind,
      status,
      at,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(error ? { error } : {})
    });
  }
}

function createResult(
  executionId: string,
  cueId: string,
  action: LinkAction,
  status: ActionExecutionStatus,
  startedAt: number,
  finishedAt: number,
  error?: string
): ActionExecutionResult {
  return {
    executionId,
    cueId,
    actionId: action.id,
    action,
    kind: action.kind,
    status,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    ...(error ? { error } : {})
  };
}

function withTimeout(promise: Promise<void>, timeoutMs: number, kind: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${kind} 执行超时（${timeoutMs} ms）`)), timeoutMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
