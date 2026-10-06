import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LinkRunLogger } from './run-logger';

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), appendFile: vi.fn()
}));
afterEach(() => vi.restoreAllMocks());
const entry = { level: 'info', category: 'action', message: '画面动作', result: 'queued' } as const;

it('输出日志只等待有界入队；查询和导出仍等待慢磁盘，不丢顺序或敏感信息', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const directory = await actual.mkdtemp(join(tmpdir(), 'tblink-buffered-log-'));
  let release = (): void => { throw new Error('等待未初始化'); };
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const append = vi.mocked(fs.appendFile).mockImplementation(async (...args) => { await blocked; await actual.appendFile(...args); });
  const logger = new LinkRunLogger(directory, () => ['secret-value']), failure = vi.fn();
  try {
    for (let index = 0; index < 3; index++) await logger.recordBuffered({ ...entry, message: `${index} secret-value` }, failure);
    let queried = false;
    const query = logger.query().then(entries => { queried = true; return entries; });
    await Promise.resolve(); expect(queried).toBe(false);
    await expect.poll(() => append.mock.calls.length).toBe(1);
    release();
    expect((await query).map(value => value.message)).toEqual(['0 [REDACTED]', '1 [REDACTED]', '2 [REDACTED]']);
    await logger.flush(); expect(failure).not.toHaveBeenCalled();
  } finally {
    release(); await logger.flush();
    await actual.unlink(join(directory, `${logger.sessionId}.jsonl`)); await actual.rmdir(directory);
  }
});

it('磁盘失败只报告一次、停止接收，已接收证据保留且标明未落盘', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const directory = await actual.mkdtemp(join(tmpdir(), 'tblink-buffered-log-'));
  vi.mocked(fs.appendFile).mockRejectedValue(new Error('磁盘已满'));
  const logger = new LinkRunLogger(directory), failure = vi.fn();
  try {
    await logger.recordBuffered(entry, failure);
    await expect(logger.flush()).rejects.toThrow('磁盘已满');
    expect(failure).toHaveBeenCalledTimes(1);
    await expect(logger.recordBuffered(entry, failure)).rejects.toThrow('磁盘已满');
    const entries = await logger.query();
    expect(entries).toHaveLength(1); expect(entries[0]?.details).toEqual({ persistence: 'failed' });
    expect(failure).toHaveBeenCalledTimes(1);
  } finally { await actual.rmdir(directory); }
});

it('慢磁盘时拒绝第513条待写日志，不创建无限任务队列', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const directory = await actual.mkdtemp(join(tmpdir(), 'tblink-buffered-log-'));
  let release = (): void => { throw new Error('等待未初始化'); };
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fs.appendFile).mockImplementation(() => blocked);
  const logger = new LinkRunLogger(directory), failure = vi.fn();
  try {
    for (let index = 0; index < 512; index++) await logger.recordBuffered(entry, failure);
    await expect(logger.recordBuffered(entry, failure)).rejects.toThrow('队列已满');
    release(); await logger.flush(); expect(failure).not.toHaveBeenCalled();
  } finally { release(); await logger.flush(); await actual.rmdir(directory); }
});
