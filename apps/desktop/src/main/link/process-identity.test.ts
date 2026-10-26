import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toUserErrorMessage } from '@tb/core/link';
import { fileTimeOf, readProcessIdentities } from './process-identity';
import { readObsCommandLine } from './obs-local-connection';

const { reader } = vi.hoisted(() => ({ reader: vi.fn<(file: string, args: string[], options: object) => Promise<{ stdout: string; stderr: string }>>() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  // Production code awaits promisify(execFile), which uses execFile's custom promise form.
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: reader }) };
});

const helper = 'C:\\Program Files\\团播联动台\\resources\\process-identity\\tblink-process-identity.exe';
const obsPath = 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe';
const answer = (value: unknown): void => { reader.mockResolvedValueOnce({ stdout: JSON.stringify(value), stderr: '' }); };

beforeEach(() => reader.mockReset());

describe('进程启动时间换算', () => {
  // Expected values from PowerShell: [DateTime]::FromFileTimeUtc(x).ToString('o') and the reverse.
  it.each([
    ['2025-10-24T20:45:45.6789012Z', 134058123456789012n],
    ['2025-10-24T20:45:45.0000000Z', 134058123450000000n],
    ['2025-10-24T20:45:45Z', 134058123450000000n],
    ['2025-10-24T20:45:45.678Z', 134058123456780000n],
    ['1970-01-01T00:00:00.0000000Z', 116444736000000000n],
    ['2026-10-25T07:29:00.1234567+08:00', 134373581401234567n]
  ])('%s 精确到 100 纳秒', (timestamp, fileTime) => {
    expect(fileTimeOf(timestamp)).toBe(fileTime);
  });

  it.each(['', 'yesterday', '2025-10-24 20:45:45Z', '2025-10-24T20:45:45.12345678Z', '2025-10-24T20:45:45'])('拒绝无法精确换算的时间：%s', (timestamp) => {
    expect(() => fileTimeOf(timestamp)).toThrow('进程启动时间格式无效');
  });
});

describe('进程识别组件', () => {
  it('按顺序读取每个进程，读不到的保留 Windows 错误码', async () => {
    answer([{ pid: 20980, path: obsPath, creationTime: '134058123456789012', commandLine: '"obs64.exe"', handleCount: 412 }, { pid: 20981, error: 5 }]);
    await expect(readProcessIdentities(helper, [20980, 20981])).resolves.toEqual([
      { pid: 20980, path: obsPath, creationTime: '134058123456789012', commandLine: '"obs64.exe"', handleCount: 412 },
      { pid: 20981, error: 5 }
    ]);
    expect(reader).toHaveBeenCalledWith(helper, ['20980', '20981'], expect.objectContaining({ windowsHide: true, timeout: 5_000 }));
  });

  it('句柄数读不到时为 null，旧格式（缺少句柄数）拒绝使用', async () => {
    answer([{ pid: 20980, path: obsPath, creationTime: '134058123456789012', commandLine: null, handleCount: null }]);
    await expect(readProcessIdentities(helper, [20980])).resolves.toEqual([{ pid: 20980, path: obsPath, creationTime: '134058123456789012', commandLine: null, handleCount: null }]);
    answer([{ pid: 20980, path: obsPath, creationTime: '134058123456789012', commandLine: null }]);
    await expect(readProcessIdentities(helper, [20980])).rejects.toThrow();
  });

  it('结果和请求对不上时拒绝使用', async () => {
    answer([{ pid: 20981, error: 5 }, { pid: 20980, error: 5 }]);
    await expect(readProcessIdentities(helper, [20980, 20981])).rejects.toThrow('结果与请求不一致');
    answer([{ pid: 20980, path: obsPath, creationTime: 'yesterday', commandLine: null, handleCount: 412 }]);
    await expect(readProcessIdentities(helper, [20980])).rejects.toThrow();
  });

  it.each([[[]], [[0]], [[-1]], [[1.5]], [[2 ** 32]], [Array.from({ length: 65 }, (_, index) => index + 1)]])('参数无效时不运行组件：%j', async (pids) => {
    await expect(readProcessIdentities(helper, pids)).rejects.toThrow('进程识别参数无效');
    expect(reader).not.toHaveBeenCalled();
  });

  it('组件缺失或运行失败时说明重新安装', async () => {
    reader.mockRejectedValueOnce(Object.assign(new Error(`spawn ${helper} ENOENT`), { code: 'ENOENT' }));
    await expect(readProcessIdentities(helper, [20980])).rejects.toThrow('进程识别组件运行失败，请重新安装联动台');
  });
});

describe('读取以管理员身份运行的 OBS 的启动参数', () => {
  const identity = { pid: 20980, executablePath: obsPath, startTime: '2025-10-24T20:45:45.6789012Z', access: 'limited' as const };

  it('路径和启动时间都对上才返回启动参数，路径大小写不影响', async () => {
    answer([{ pid: 20980, path: obsPath.toUpperCase(), creationTime: '134058123456789012', commandLine: '"C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe" --portable', handleCount: 412 }]);
    await expect(readObsCommandLine(identity, helper)).resolves.toBe('"C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe" --portable');
    expect(reader).toHaveBeenCalledWith(helper, ['20980'], expect.any(Object));
  });

  it('同一 PID 换成了别的进程时拒绝读取，不会拿错 OBS 的密码', async () => {
    answer([{ pid: 20980, path: obsPath, creationTime: '134058123456789013', commandLine: '"obs64.exe"', handleCount: 412 }]);
    await expect(readObsCommandLine(identity, helper)).rejects.toThrow('OBS 好像刚重新打开过');
    answer([{ pid: 20980, path: 'C:\\Other\\obs64.exe', creationTime: '134058123456789012', commandLine: '"obs64.exe"', handleCount: 412 }]);
    await expect(readObsCommandLine(identity, helper)).rejects.toThrow('OBS 好像刚重新打开过');
  });

  it('Windows 不让读取时说明原因，界面原样显示', async () => {
    answer([{ pid: 20980, error: 5 }]);
    const failure = readObsCommandLine(identity, helper);
    await expect(failure).rejects.toThrow('Windows 错误 5');
    const message = await failure.catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(message).toContain('当前 Windows 账户');
    expect(toUserErrorMessage(message)).toBe(message);
  });

  it('Windows 没给出启动参数时不猜测，改用手动连接', async () => {
    answer([{ pid: 20980, path: obsPath, creationTime: '134058123456789012', commandLine: null, handleCount: 412 }]);
    await expect(readObsCommandLine(identity, helper)).rejects.toThrow('请改用下方手动连接');
  });
});
