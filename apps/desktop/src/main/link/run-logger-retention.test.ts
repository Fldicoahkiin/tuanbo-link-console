import { mkdtemp, readdir, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LinkRunLogger } from './run-logger';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-24T12:00:00.000Z');

/** A session log of `bytes` bytes last written `ageDays` before `now`. */
async function session(directory: string, name: string, bytes: number, ageDays: number): Promise<string> {
  const file = join(directory, `${name}.jsonl`);
  await writeFile(file, 'x'.repeat(bytes));
  const at = new Date(now - ageDays * DAY);
  await utimes(file, at, at);
  return file;
}

/** Trash stands in for the system recycle bin and records what it was given. */
function recordingTrash(): { trash: (path: string) => Promise<void>; trashed: string[] } {
  const trashed: string[] = [];
  return { trashed, trash: async path => { trashed.push(path); await unlink(path); } };
}

describe('LinkRunLogger.pruneSessions', () => {
  it('只超过 30 天：把旧会话移到回收站，近期会话保留', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-log-retention-'));
    const old = await session(directory, 'old', 100, 31), recent = await session(directory, 'recent', 100, 1);
    const logger = new LinkRunLogger(directory);
    const { trash, trashed } = recordingTrash();
    const pruned = await logger.pruneSessions(trash, { maxAgeMs: 30 * DAY, maxBytes: 1_000_000 }, now);
    expect(trashed).toEqual([old]);
    expect(pruned).toEqual([{ file: old, bytes: 100, reason: 'expired' }]);
    expect(await readdir(directory)).toEqual([recent.slice(directory.length + 1)]);
  });

  it('只超过总量：从最旧的会话开始移走，直到不超过上限', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-log-retention-'));
    const first = await session(directory, 'first', 200, 3), second = await session(directory, 'second', 200, 2);
    await session(directory, 'third', 200, 1);
    const { trash, trashed } = recordingTrash();
    const pruned = await new LinkRunLogger(directory).pruneSessions(trash, { maxAgeMs: 30 * DAY, maxBytes: 250 }, now);
    expect(trashed).toEqual([first, second]);
    expect(pruned.map(entry => entry.reason)).toEqual(['over-size', 'over-size']);
  });

  it('两条都超：先移走过期的，再按总量从旧到新移走，取更严的结果', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-log-retention-'));
    const expired = await session(directory, 'expired', 50, 45), older = await session(directory, 'older', 300, 10);
    const newer = await session(directory, 'newer', 300, 1);
    const { trash, trashed } = recordingTrash();
    const pruned = await new LinkRunLogger(directory).pruneSessions(trash, { maxAgeMs: 30 * DAY, maxBytes: 400 }, now);
    expect(trashed).toEqual([expired, older]);
    expect(pruned).toEqual([{ file: expired, bytes: 50, reason: 'expired' }, { file: older, bytes: 300, reason: 'over-size' }]);
    expect(await readdir(directory)).toEqual([newer.slice(directory.length + 1)]);
  });

  it('当前会话的文件即使最旧、最大也不移走；只清理 .jsonl 会话日志', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-log-retention-'));
    const logger = new LinkRunLogger(directory);
    await logger.record({ level: 'info', category: 'system', message: '当前会话' });
    const current = join(directory, `${logger.sessionId}.jsonl`);
    await writeFile(current, 'y'.repeat(5000), { flag: 'a' });
    await utimes(current, new Date(now - 90 * DAY), new Date(now - 90 * DAY));
    await writeFile(join(directory, 'notes.txt'), 'z'.repeat(5000));
    const recent = await session(directory, 'recent', 100, 1);
    const { trash, trashed } = recordingTrash();
    await logger.pruneSessions(trash, { maxAgeMs: 30 * DAY, maxBytes: 1000 }, now);
    expect(trashed).toEqual([recent]);
    expect((await readdir(directory)).sort()).toEqual([`${logger.sessionId}.jsonl`, 'notes.txt'].sort());
  });

  it('日志目录不存在时不清理也不报错', async () => {
    const directory = join(await mkdtemp(join(tmpdir(), 'tblink-log-retention-')), 'missing');
    const { trash, trashed } = recordingTrash();
    expect(await new LinkRunLogger(directory).pruneSessions(trash, { maxAgeMs: 30 * DAY, maxBytes: 1000 }, now)).toEqual([]);
    expect(trashed).toEqual([]);
  });
});
