import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  ExternalProcessManager,
  type DetectedProcess,
  type ExternalProcessConfiguration,
  type ExternalProcessTools
} from './external-process-manager';

describe('ExternalProcessManager', () => {
  it('相同 PID 被复用但启动时间改变时撤销所有权', async () => {
    const tools = fakeTools([]);
    tools.detectedAfterLaunch = [processInfo(321)];
    const manager = new ExternalProcessManager(tools, idleObs());
    await manager.start('obs', configuration());
    tools.detectedAfterLaunch = [{ ...processInfo(321), startTime: '2026-09-15T00:00:00.000Z' }];
    expect(await manager.refresh('obs', configuration())).toMatchObject({ owned: false });
    await expect(manager.stop('obs', 100)).rejects.toThrow('不是本次由联动台启动');
    expect(tools.closedPids).toEqual([]);
  });
  it('刷新时按集成档案精确识别既有程序且不取得所有权', async () => {
    const tools = fakeTools([processInfo(100)]);
    const manager = new ExternalProcessManager(tools, idleObs());

    await expect(manager.refresh('p1', configuration())).resolves.toMatchObject({
      status: 'running',
      pid: 100,
      owned: false,
      executablePath: 'C:\\Apps\\P1.exe'
    });
    await expect(manager.stop('p1', 10)).rejects.toThrow('不是本次由联动台启动');
  });

  it('只连接用户原本运行的程序且拒绝关闭', async () => {
    const detected = processInfo(100);
    const tools = fakeTools([detected]);
    const manager = new ExternalProcessManager(tools, idleObs());
    const snapshot = await manager.start('p1', configuration());

    expect(snapshot.owned).toBe(false);
    await expect(manager.stop('p1', 10)).rejects.toThrow('不是本次由联动台启动');
    expect(tools.closedPids).toEqual([]);
  });

  it('同一路径存在多个 Chromium 进程时选择唯一主窗口且不取得所有权', async () => {
    const main = processInfo(100);
    const worker = { ...processInfo(101), windowTitle: '' };
    const tools = fakeTools([worker, main, { ...worker, pid: 102 }]);
    const manager = new ExternalProcessManager(tools, idleObs());

    await expect(manager.start('p1', configuration())).resolves.toMatchObject({
      status: 'running',
      pid: 100,
      owned: false,
      windowTitle: 'P1'
    });
  });

  it('同一路径存在多个主窗口时明确拒绝猜测连接目标', async () => {
    const tools = fakeTools([processInfo(100), { ...processInfo(101), windowTitle: '另一个窗口' }]);
    const manager = new ExternalProcessManager(tools, idleObs());

    await expect(manager.start('p1', configuration())).rejects.toThrow('无法由唯一主窗口确定连接目标');
  });

  it('本次启动的程序使用精确 PID 正常关闭', async () => {
    const tools = fakeTools([]);
    tools.detectedAfterLaunch = [processInfo(321)];
    const manager = new ExternalProcessManager(tools, idleObs());
    const started = await manager.start('p1', configuration());
    expect(started).toMatchObject({ status: 'running', pid: 321, owned: true });

    tools.closeAccepted = true;
    const stoppedPromise = manager.stop('p1', 100);
    setTimeout(() => tools.child.emit('exit', 0, null), 0);
    await expect(stoppedPromise).resolves.toMatchObject({ status: 'notRunning', pid: null, owned: false });
    expect(tools.closedPids).toEqual([321]);
  });

  it('重复启动检测到同一 PID 时保留本次启动所有权', async () => {
    const tools = fakeTools([]);
    tools.detectedAfterLaunch = [processInfo(321)];
    const manager = new ExternalProcessManager(tools, idleObs());

    await expect(manager.start('p1', configuration())).resolves.toMatchObject({ owned: true, pid: 321 });
    await expect(manager.start('p1', configuration())).resolves.toMatchObject({ owned: true, pid: 321 });

    tools.closeAccepted = true;
    const stopped = manager.stop('p1', 100);
    setTimeout(() => tools.child.emit('exit', 0, null), 0);
    await expect(stopped).resolves.toMatchObject({ status: 'notRunning' });
  });

  it('已跟踪 PID 退出但同路径程序已重启时连接新实例而不重复启动', async () => {
    const tools = fakeTools([processInfo(100)]);
    const manager = new ExternalProcessManager(tools, idleObs());
    await expect(manager.refresh('p1', configuration())).resolves.toMatchObject({ pid: 100, owned: false });

    tools.detectedBeforeLaunch = [processInfo(200)];
    await expect(manager.start('p1', configuration())).resolves.toMatchObject({ pid: 200, owned: false });
    expect(tools.launchCount).toBe(0);
  });

  it('本次启动的进程未通过路径核验时保留所有权并拒绝重复启动', async () => {
    const tools = fakeTools([]);
    const manager = new ExternalProcessManager(tools, idleObs());
    const fastFailure = { ...configuration(), startupTimeoutMs: 1 };

    await expect(manager.start('p1', fastFailure)).rejects.toThrow('未通过路径核验');
    expect(manager.getSnapshot('p1')).toMatchObject({ status: 'error', pid: 321, owned: true });
    await expect(manager.start('p1', fastFailure)).rejects.toThrow('拒绝重复启动');
    expect(tools.launchCount).toBe(1);

    tools.closeAccepted = true;
    const stopped = manager.stop('p1', 100);
    setTimeout(() => tools.child.emit('exit', 0, null), 0);
    await expect(stopped).resolves.toMatchObject({ status: 'notRunning', pid: null, owned: false });
  });

  it('原有外部进程消失后刷新会清空旧 PID 和所有权', async () => {
    const tools = fakeTools([processInfo(100)]);
    const manager = new ExternalProcessManager(tools, idleObs());
    await manager.refresh('p1', configuration());
    tools.detectedBeforeLaunch = [];

    await expect(manager.refresh('p1', configuration())).resolves.toMatchObject({
      status: 'error',
      pid: null,
      owned: false,
      error: '进程已退出'
    });
  });

  it('OBS 推流或录像时拒绝发送关闭请求', async () => {
    const tools = fakeTools([]);
    tools.detectedAfterLaunch = [processInfo(321)];
    const manager = new ExternalProcessManager(tools, {
      readOutputStatus: () => Promise.resolve({ streaming: true, recording: false })
    });
    await manager.start('obs', configuration());

    await expect(manager.stop('obs', 10)).rejects.toThrow('正在推流或录像');
    expect(tools.closedPids).toEqual([]);
  });

  it('程序拒绝关闭或正常关闭超时时保留进程且不强制结束', async () => {
    const rejectedTools = fakeTools([]);
    rejectedTools.detectedAfterLaunch = [processInfo(321)];
    const rejectedManager = new ExternalProcessManager(rejectedTools, idleObs());
    await rejectedManager.start('p1', configuration());
    await expect(rejectedManager.stop('p1', 10)).rejects.toThrow('没有接受正常关闭请求');
    expect(rejectedManager.getSnapshot('p1')).toMatchObject({ status: 'running', pid: 321, owned: true });

    const timeoutTools = fakeTools([]);
    timeoutTools.detectedAfterLaunch = [processInfo(321)];
    timeoutTools.closeAccepted = true;
    const timeoutManager = new ExternalProcessManager(timeoutTools, idleObs());
    await timeoutManager.start('p1', configuration());
    await expect(timeoutManager.stop('p1', 1)).rejects.toThrow('正常关闭超时');
    expect(timeoutManager.getSnapshot('p1')).toMatchObject({ status: 'running', pid: 321, owned: true });
  });
});

type FakeTools = ExternalProcessTools & {
  child: EventEmitter;
  closedPids: number[];
  detectedAfterLaunch: DetectedProcess[];
  closeAccepted: boolean;
  detectedBeforeLaunch: DetectedProcess[];
  launchCount: number;
};

function fakeTools(initial: DetectedProcess[]): FakeTools {
  let launched = false;
  const child = Object.assign(new EventEmitter(), { pid: 321, exitCode: null });
  const result: FakeTools = {
    child,
    closedPids: [],
    detectedAfterLaunch: [],
    detectedBeforeLaunch: initial,
    closeAccepted: false,
    launchCount: 0,
    findByExecutable: () => Promise.resolve(launched ? result.detectedAfterLaunch : result.detectedBeforeLaunch),
    launch: () => {
      launched = true;
      result.launchCount += 1;
      queueMicrotask(() => child.emit('spawn'));
      return child as unknown as ChildProcess;
    },
    requestClose: (pid) => {
      result.closedPids.push(pid);
      return Promise.resolve(result.closeAccepted);
    }
  };
  return result;
}

function configuration(): ExternalProcessConfiguration {
  return {
    executablePath: 'C:\\Apps\\P1.exe',
    arguments: [],
    workingDirectory: 'C:\\Apps',
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 100
  };
}

function processInfo(pid: number): DetectedProcess {
  return {
    pid,
    processName: 'P1.exe',
    executablePath: 'C:\\Apps\\P1.exe',
    startTime: '2026-08-26T00:00:00.000Z',
    windowTitle: 'P1',
    fileVersion: '1.0.0'
  };
}

function idleObs() {
  return { readOutputStatus: () => Promise.resolve({ streaming: false, recording: false }) };
}
