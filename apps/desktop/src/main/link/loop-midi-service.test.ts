import { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { LoopMidiStatus } from '@tb/schema';
import { LoopMidiService } from './loop-midi-service';

const installed: LoopMidiStatus = { state: 'installed', executablePath: 'C:\\MIDI\\loopMIDI.exe', pid: null, startTime: null };
const running: LoopMidiStatus = { ...installed, state: 'running', pid: 123, startTime: '2026-09-14T00:00:00Z' };
function setup(status: LoopMidiStatus) {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 123 });
  const process = { pid: 123, executablePath: installed.executablePath!, startTime: running.startTime!, processName: 'loopMIDI.exe', windowTitle: '', fileVersion: '1' };
  const tools = {
    findByExecutable: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([process]),
    launch: vi.fn(() => { queueMicrotask(() => child.emit('spawn')); return child; }),
    requestClose: vi.fn().mockResolvedValue(false)
  };
  return { tools, child, service: new LoopMidiService(() => Promise.resolve(status), tools) };
}

describe('loopMIDI dependency lifecycle', () => {
  it('未安装时返回缺失，不尝试启动或关闭进程', async () => {
    const { service, tools } = setup({ state: 'missing', executablePath: null, pid: null, startTime: null });
    expect((await service.start()).state).toBe('missing');
    expect(tools.launch).not.toHaveBeenCalled();
    expect(tools.requestClose).not.toHaveBeenCalled();
  });
  it('复用用户已运行的程序', async () => {
    const { service, tools } = setup(running);
    expect(await service.start()).toEqual(running);
    expect(tools.launch).not.toHaveBeenCalled();
  });
  it('并发启动合并为一次，并通过路径和 PID 核验', async () => {
    const { service, tools } = setup(installed);
    const results = await Promise.all([service.start(), service.start()]);
    expect(results).toEqual([running, running]);
    expect(tools.launch).toHaveBeenCalledTimes(1);
    expect(tools.findByExecutable).toHaveBeenCalledWith(installed.executablePath);
  });
  it('启动失败明确返回且不自动重试', async () => {
    const { service, tools, child } = setup(installed);
    tools.launch.mockImplementation(() => { queueMicrotask(() => child.emit('error', new Error('启动被拒绝'))); return child; });
    await expect(service.start()).rejects.toThrow('启动被拒绝');
    expect(tools.launch).toHaveBeenCalledTimes(1);
  });
  it('拒绝不明确的同路径进程', async () => {
    const { service, tools } = setup(installed);
    tools.findByExecutable.mockReset().mockResolvedValue([{}, {}]);
    await expect(service.start()).rejects.toThrow('多个');
    expect(tools.launch).not.toHaveBeenCalled();
  });
});
