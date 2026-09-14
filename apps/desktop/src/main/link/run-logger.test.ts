import { mkdir, readFile, rmdir, unlink } from 'node:fs/promises';
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
