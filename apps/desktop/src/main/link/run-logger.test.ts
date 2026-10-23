import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { LinkRunLogger, redactValue } from './run-logger';

const gunzipAsync = promisify(gunzip);
const cleanupFiles: string[] = [];
const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const filePath of cleanupFiles.splice(0).reverse()) await unlink(filePath).catch(ignoreMissing);
  for (const directory of cleanupDirectories.splice(0).reverse()) await rmdir(directory).catch(ignoreMissing);
});

describe('LinkRunLogger', () => {
  it('十五万条日志可完整查询并筛选，返回对象不会污染后续读取', async () => {
    const directory = await createTestDirectory();
    const logger = new LinkRunLogger(directory);
    const file = join(directory, 'large.jsonl'); cleanupFiles.push(file);
    const entry = { id: 'entry', sessionId: 'session', timestamp: '2026-09-17T00:00:00.000Z', monotonicMs: 0, level: 'info', category: 'state', message: '大场次日志', itemId: 'other' };
    await writeFile(file, `${JSON.stringify(entry)}\n`.repeat(150000) + JSON.stringify({ ...entry, itemId: 'selected', message: '最后一条' }));
    expect(await logger.query()).toHaveLength(150001);
    const selected = await logger.query({ itemId: 'selected' });
    expect(selected.map(value => value.message)).toEqual(['最后一条']);
    selected[0]!.message = '调用方修改';
    expect((await logger.query({ itemId: 'selected' }))[0]!.message).toBe('最后一条');
  });

  it('损坏日志报告物理行号，包括空行和分块 UTF-8 内容', async () => {
    const directory = await createTestDirectory();
    const logger = new LinkRunLogger(directory);
    const file = join(directory, 'broken.jsonl'); cleanupFiles.push(file);
    const entry = { id: 'entry', sessionId: 'session', timestamp: '2026-09-17T00:00:00.000Z', monotonicMs: 0, level: 'info', category: 'state', message: '中文'.repeat(40000) };
    await writeFile(file, `${JSON.stringify(entry)}\r\n\r\ninvalid`);
    const entries = await logger.query();
    expect(entries).toHaveLength(2);
    expect(entries[1]?.message).toContain('第 3 行损坏');
    const exported = join(directory, 'damaged.tbdiag.gz'); cleanupFiles.push(exported);
    await logger.exportDiagnosticPackage(exported, {});
    const text = (await gunzipAsync(await readFile(exported))).toString('utf8');
    expect(text).toContain('已保留原文件');
    expect(text).toContain('中文');
    expect(await readFile(file, 'utf8')).toContain('invalid');
  });
  it('日志与诊断包均脱敏且支持筛选', async () => {
    const directory = await createTestDirectory();
    const logsDirectory = join(directory, 'logs');
    const logger = new LinkRunLogger(logsDirectory, () => ['obs-password']);
    await logger.record({
      level: 'error',
      category: 'action',
      message: '连接失败 obs-password',
      itemId: 'item',
      cueId: 'cue',
      device: 'obs',
      result: 'failed',
      details: { password: 'obs-password', url: 'ws://user:obs-password@localhost' }
    });
    const logPath = join(logsDirectory, `${logger.sessionId}.jsonl`);
    const packagePath = join(directory, 'diagnostic.tbdiag.gz');
    cleanupFiles.push(logPath, packagePath);
    cleanupDirectories.push(logsDirectory);

    expect(await logger.query({ cueId: 'cue', result: 'failed' })).toHaveLength(1);
    expect(await readFile(logPath, 'utf8')).not.toContain('obs-password');
    await logger.exportDiagnosticPackage(packagePath, { authorization: 'Bearer obs-password', appVersion: '1.0.0' });
    const unpacked = (await gunzipAsync(await readFile(packagePath))).toString('utf8');
    expect(unpacked).not.toContain('obs-password');
    expect(unpacked).toContain('[REDACTED]');
  });

  it('跨会话读取同一日志目录并按 session 筛选', async () => {
    const directory = await createTestDirectory();
    const logsDirectory = join(directory, 'logs');
    const first = new LinkRunLogger(logsDirectory);
    const second = new LinkRunLogger(logsDirectory);
    await first.record({ level: 'info', category: 'state', message: 'first' });
    await second.record({ level: 'info', category: 'state', message: 'second' });
    cleanupFiles.push(join(logsDirectory, `${first.sessionId}.jsonl`), join(logsDirectory, `${second.sessionId}.jsonl`));
    cleanupDirectories.push(logsDirectory);

    expect(await second.query()).toHaveLength(2);
    expect((await second.query({ sessionId: first.sessionId })).map((entry) => entry.message)).toEqual(['first']);
  });

  it('按敏感键名和已知密钥值递归脱敏', () => {
    expect(redactValue({ token: 'abc', nested: ['secret-value'] }, ['secret-value'])).toEqual({
      token: '[REDACTED]',
      nested: ['[REDACTED]']
    });
  });

  it('导出等待已提交日志落盘，文本跨会话脱敏，限量查看仍保留完整导出', async () => {
    const directory = await createTestDirectory();
    const logger = new LinkRunLogger(directory, () => ['private-secret']);
    cleanupFiles.push(join(directory, `${logger.sessionId}.jsonl`));
    const textPath = join(directory, 'all.txt'); cleanupFiles.push(textPath);
    const writes = Array.from({ length: 20 }, (_, index) => logger.record({ level: 'info', category: 'system', message: `记录 ${index} private-secret` }));
    await logger.exportText(textPath, '团播联动台 0.5.0 · 正式 · 提交 abc · com.tuanbo.control'); await Promise.all(writes);
    const last = await logger.query({ limit: 5 });
    expect(last).toHaveLength(5);
    expect(last.at(-1)?.message).toContain('记录 19');
    const contents = await readFile(textPath, 'utf8');
    expect(contents).toContain('记录 0'); expect(contents).toContain('记录 19');
    expect(contents).toContain('导出版本：团播联动台 0.5.0 · 正式 · 提交 abc · com.tuanbo.control');
    expect(contents).not.toContain('private-secret');
    await expect(logger.exportText(join(directory, 'missing', 'all.txt'), '团播联动台 0.5.0 · 正式 · 提交 abc · com.tuanbo.control')).resolves.toBeUndefined();
    cleanupFiles.push(join(directory, 'missing', 'all.txt')); cleanupDirectories.push(join(directory, 'missing'));
    await expect(logger.exportText(join(directory, 'wrong.json'), '团播联动台 0.5.0 · 正式 · 提交 abc · com.tuanbo.control')).rejects.toThrow('.txt');
  });
});

async function createTestDirectory(): Promise<string> {
  const directory = join(tmpdir(), `link-log-${crypto.randomUUID()}`);
  await mkdir(directory);
  cleanupDirectories.push(directory);
  return directory;
}

function ignoreMissing(error: unknown): void {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
  throw error;
}
