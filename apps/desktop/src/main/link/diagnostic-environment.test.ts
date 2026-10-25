import { mkdir, mkdtemp, rmdir, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { feedbackEnvironment, recentCrashDumps } from './diagnostic-environment';

const created: string[] = [];
afterEach(async () => {
  for (const path of created.splice(0).reverse()) await (path.endsWith('.dmp') || path.endsWith('.txt') ? unlink(path) : rmdir(path));
});

describe('recentCrashDumps', () => {
  it('列出最新的转储文件名、大小和时间，不读内容；目录不存在时为空', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tblink-dumps-')); created.push(root);
    const reports = join(root, 'reports'); await mkdir(reports); created.push(reports);
    for (const [name, minutes] of [['old.dmp', 30], ['new.dmp', 1], ['notes.txt', 0]] as const) {
      const path = join(reports, name); await writeFile(path, 'x'.repeat(10)); created.push(path);
      const at = new Date(Date.now() - minutes * 60_000); await utimes(path, at, at);
    }
    const dumps = await recentCrashDumps(root);
    expect(dumps.map(dump => dump.file)).toEqual([join('reports', 'new.dmp'), join('reports', 'old.dmp')]);
    expect(dumps[0]?.bytes).toBe(10);
    expect(await recentCrashDumps(join(root, 'missing'))).toEqual([]);
  });
});

describe('feedbackEnvironment', () => {
  it('概括系统、连接和播放状态，超长截断', () => {
    expect(feedbackEnvironment({ windowsRelease: '10.0.26100', arch: 'x64', cpu: 'Intel(R) Core(TM) i7', totalMemoryBytes: 32 * 1024 ** 3,
      obs: { status: 'connected', obsVersion: '31.1.2' }, ma2: { state: 'disconnected', version: null }, runtimeActive: true, playerStatus: 'playing' }))
      .toEqual({ os: 'Windows 10.0.26100 · x64 · Intel(R) Core(TM) i7 · 内存 32 GB', obs: 'OBS 已连接 · 31.1.2', ma2: 'MA2 未连接', playback: '演出运行中 · 播放器 playing' });
    expect(feedbackEnvironment({ windowsRelease: '1', arch: 'x64', cpu: 'c'.repeat(300), totalMemoryBytes: 0, obs: { status: 'error', obsVersion: null },
      ma2: { state: 'connected', version: '3.9.60.65' }, runtimeActive: false, playerStatus: null }).os).toHaveLength(160);
  });
});
