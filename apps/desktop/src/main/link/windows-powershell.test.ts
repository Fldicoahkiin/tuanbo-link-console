import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { windowsPowerShellExecutable } from './windows-powershell';
import { executePowerShell } from './windows-integration-detector';
import { WindowsProcessTools } from './external-process-manager';
import { LoopMidiService } from './loop-midi-service';

afterEach(() => vi.unstubAllEnvs());

function clearSearchPath(): void {
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() === 'path') vi.stubEnv(key, '');
  }
}

describe('Windows 系统 PowerShell 定位', () => {
  it('按系统目录定位，支持空格和中文，不使用 PATH', async () => {
    await mkdir(resolve('artifacts'), { recursive: true });
    const root = await mkdtemp(resolve('artifacts', '系统目录 '));
    const directory = join(root, 'System32', 'WindowsPowerShell', 'v1.0');
    await mkdir(directory, { recursive: true });
    const executable = join(directory, 'powershell.exe');
    await writeFile(executable, 'path fixture; never executed');
    vi.stubEnv('SystemRoot', root);
    clearSearchPath();
    expect(await windowsPowerShellExecutable({ SYSTEMROOT: root })).toBe(executable);
  });

  it.each([undefined, '', 'Windows', '\\Windows'])('拒绝缺失或不完整的系统目录：%s', async (root) => {
    await expect(windowsPowerShellExecutable({ SystemRoot: root })).rejects.toThrow('系统目录');
  });

  it('系统组件缺失时给出修复说明，不回退到 PATH 中的程序', async () => {
    vi.stubEnv('SystemRoot', resolve('artifacts', 'missing-windows-components'));
    await expect(windowsPowerShellExecutable()).rejects.toThrow('Windows 系统命令组件缺失或不可访问');
  });
});

describe.skipIf(process.platform !== 'win32')('Windows 原生无 PATH 回归', () => {
  it('PATH 为空仍能执行系统 PowerShell 并完整读取中文输出', async () => {
    clearSearchPath();
    await expect(executePowerShell("if($env:PATH){throw 'PATH must be empty'}; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write('兼容性验证')", 10_000)).resolves.toBe('兼容性验证');
  }, 15_000);

  it('PATH 为空仍能按精确路径检测当前进程', async () => {
    clearSearchPath();
    const processes = await new WindowsProcessTools().findByExecutable(process.execPath);
    expect(processes.some((entry) => entry.pid === process.pid)).toBe(true);
  }, 15_000);

  it('只把读不到程序位置的同名进程当作无法核对；当前进程可读，不在结果里', async () => {
    clearSearchPath();
    const pids = await new WindowsProcessTools().findUnverifiable(process.execPath);
    expect(Array.isArray(pids)).toBe(true);
    expect(pids).not.toContain(process.pid);
  }, 15_000);

  it('PATH 为空仍能返回实际 loopMIDI 检测结果', async () => {
    clearSearchPath();
    const result = await new LoopMidiService().detect();
    expect(['running', 'installed', 'missing']).toContain(result.state);
  }, 20_000);
});
