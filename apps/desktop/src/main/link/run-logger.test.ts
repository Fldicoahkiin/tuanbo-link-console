import { mkdir, readFile, rmdir, unlink, utimes, writeFile } from 'node:fs/promises';
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
    // Without a limit the newest 500 are read; a filter still searches the whole session.
    expect(await logger.query()).toHaveLength(500);
    expect(await logger.query({ limit: 5000 })).toHaveLength(5000);
    const selected = await logger.query({ itemId: 'selected' });
    expect(selected.map(value => value.message)).toEqual(['最后一条']);
    selected[0]!.message = '调用方修改';
    expect((await logger.query({ itemId: 'selected' }))[0]!.message).toBe('最后一条');
  });

  it('损坏日志报告物理行号，包括空行和分块 UTF-8 内容', async () => {
    const directory = await createTestDirectory();
    const logger = new LinkRunLogger(directory);
    const file = join(directory, 'broken.jsonl'); cleanupFiles.push(file);
    const entry = { id: 'entry', sessionId: 'session', timestamp: new Date().toISOString(), monotonicMs: 0, level: 'info', category: 'state', message: '中文'.repeat(40000) };
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

  it('导出时才得知的密钥也从已写入的日志里去掉', async () => {
    const directory = await createTestDirectory();
    const secrets: string[] = [];
    const logger = new LinkRunLogger(directory, () => secrets);
    cleanupFiles.push(join(directory, `${logger.sessionId}.jsonl`));
    await logger.record({ level: 'info', category: 'device', message: '连接 late-secret', details: { url: 'ws://late-secret@host' } });
    secrets.push('late-secret');
    const packagePath = join(directory, 'late.tbdiag.gz'), textPath = join(directory, 'late.txt'); cleanupFiles.push(packagePath, textPath);
    await logger.exportDiagnosticPackage(packagePath, {}); await logger.exportText(textPath, '团播联动台');
    expect((await gunzipAsync(await readFile(packagePath))).toString('utf8')).not.toContain('late-secret');
    expect(await readFile(textPath, 'utf8')).not.toContain('late-secret');
  });

  it('重复记录只落盘前三条，查询前写出合并记录，合并记录同样脱敏', async () => {
    const directory = await createTestDirectory();
    let now = Date.parse('2026-10-25T12:00:00.000Z');
    const logger = new LinkRunLogger(directory, () => ['console-secret'], () => now);
    cleanupFiles.push(join(directory, `${logger.sessionId}.jsonl`));
    for (let index = 0; index < 12; index++) {
      await logger.record({ level: 'error', category: 'device', device: 'MA2', message: '控台 console-secret 无响应', result: 'failed', details: { attempt: index } });
      now += 1000;
    }
    await logger.record({ level: 'info', category: 'system', message: '其他记录' });
    const disk = (await readFile(join(directory, `${logger.sessionId}.jsonl`), 'utf8')).trim().split('\n');
    expect(disk).toHaveLength(4);
    const entries = await logger.query();
    expect(entries.map(entry => entry.message)).toEqual(['控台 [REDACTED] 无响应', '控台 [REDACTED] 无响应', '控台 [REDACTED] 无响应', '其他记录',
      '控台 [REDACTED] 无响应（在 8 秒内又重复 9 次，已合并为本条）']);
    expect(entries.at(-1)?.details).toMatchObject({ repeat: { merged: 9 }, lastDetails: { attempt: 11 } });
    await logger.flush();
    expect(await logger.query()).toHaveLength(5);
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

const DAY = 24 * 60 * 60 * 1000;

/** A finished session's log: `lines` entries stamped `ageDays` ago, last written then. */
async function pastSession(directory: string, name: string, ageDays: number, lines: string[]): Promise<string> {
  const file = join(directory, `${name}.jsonl`); cleanupFiles.push(file);
  await writeFile(file, `${lines.join('\n')}\n`);
  const at = new Date(Date.now() - ageDays * DAY);
  await utimes(file, at, at);
  return file;
}
const line = (sessionId: string, message: string, ageDays: number, extra: Record<string, unknown> = {}): string => JSON.stringify({
  id: crypto.randomUUID(), sessionId, timestamp: new Date(Date.now() - ageDays * DAY).toISOString(), monotonicMs: 0, level: 'info', category: 'system', message, ...extra });

describe('LinkRunLogger 有界读取', () => {
  it('日志页查询从最新的会话往前读，凑够条数就停，不读更早的会话', async () => {
    const directory = await createTestDirectory();
    await pastSession(directory, 'oldest', 5, ['损坏行，读到就会被报告']);
    await pastSession(directory, 'older', 3, Array.from({ length: 50 }, (_, index) => line('older', `较早 ${index}`, 3)));
    await pastSession(directory, 'newer', 1, Array.from({ length: 50 }, (_, index) => line('newer', `较新 ${index}`, 1)));
    const logger = new LinkRunLogger(directory);
    const entries = await logger.query({ limit: 60 });
    expect(entries).toHaveLength(60);
    expect(entries.at(-1)?.message).toBe('较新 49');
    expect(entries[0]?.message).toBe('较早 40');
    expect(entries.some(entry => entry.message.includes('损坏'))).toBe(false);
  });

  it('筛选条件很少命中时最多查找最近 20 个会话', async () => {
    const directory = await createTestDirectory();
    await pastSession(directory, 'beyond', 30, ['损坏行，超出查找范围']);
    for (let index = 0; index < 20; index++) await pastSession(directory, `session-${index}`, 20 - index * 0.5, [line(`session-${index}`, `会话 ${index}`, 20 - index * 0.5)]);
    const logger = new LinkRunLogger(directory);
    expect(await logger.query({ cueId: 'none' })).toEqual([]);
    expect((await logger.query({ limit: 100 })).map(entry => entry.message)).toEqual(Array.from({ length: 20 }, (_, index) => `会话 ${index}`));
  });

  it('按会话查询只读该会话的文件，名字不能指向日志目录以外', async () => {
    const directory = await createTestDirectory();
    await pastSession(directory, 'wanted', 2, [line('wanted', '目标会话', 2)]);
    await pastSession(directory, 'other', 1, ['损坏行，不该被读']);
    const logger = new LinkRunLogger(directory);
    expect((await logger.query({ sessionId: 'wanted' })).map(entry => entry.message)).toEqual(['目标会话']);
    expect(await logger.query({ sessionId: '../wanted' })).toEqual([]);
  });

  it('导出只含所选天数内的日志，更早的会话文件不读；默认最近 7 天', async () => {
    const directory = await createTestDirectory();
    await pastSession(directory, 'ancient', 10, ['损坏行，十天前的会话不该被读']);
    await pastSession(directory, 'mixed', 1, [line('mixed', '八天前', 8), line('mixed', '两天前', 2), line('mixed', '一天前', 1)]);
    const logger = new LinkRunLogger(directory);
    await logger.record({ level: 'info', category: 'system', message: '本次会话' });
    cleanupFiles.push(join(directory, `${logger.sessionId}.jsonl`));
    const week = join(directory, 'week.txt'); cleanupFiles.push(week);
    await logger.exportText(week, '团播联动台 0.5.0');
    const text = await readFile(week, 'utf8');
    expect(text).toContain('最近 7 天');
    expect(text.indexOf('两天前')).toBeLessThan(text.indexOf('一天前'));
    expect(text.indexOf('一天前')).toBeLessThan(text.indexOf('本次会话'));
    expect(text).not.toContain('八天前'); expect(text).not.toContain('损坏');
    const day = join(directory, 'day.tbdiag.gz'); cleanupFiles.push(day);
    await logger.exportDiagnosticPackage(day, { note: '现场' }, { days: 1 });
    const unpacked = JSON.parse((await gunzipAsync(await readFile(day))).toString('utf8')) as { range: { days: number }; context: { note: string }; logs: { message: string }[] };
    expect(unpacked.range).toEqual({ days: 1 });
    expect(unpacked.context.note).toBe('现场');
    expect(unpacked.logs.map(entry => entry.message)).toEqual(['本次会话']);
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
