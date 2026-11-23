import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { writeFileAtomically } from './atomic-file';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

it.skipIf(process.platform !== 'win32')('Windows 暂时占用同步记录时等待原子替换，后一次保存保留最新内容', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-atomic-'));
  const target = join(directory, 'songs.json');
  await writeFileAtomically(target, 'original');
  const locked = Object.assign(new Error('sharing violation'), { code: 'EPERM' });
  const events = new EventEmitter();
  const firstAttempt = once(events, 'locked');
  vi.mocked(rename).mockImplementationOnce(() => { events.emit('locked'); return Promise.reject(locked); });
  const first = writeFileAtomically(target, 'first');
  await firstAttempt;
  expect(await readFile(target, 'utf8')).toBe('original');
  const latest = writeFileAtomically(target, 'latest');
  await Promise.all([first, latest]);
  expect(await readFile(target, 'utf8')).toBe('latest');
  expect(await readdir(directory)).toEqual(['songs.json']);
});
