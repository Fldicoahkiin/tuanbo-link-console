import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { AUTOMATIC_ARCHIVE_LIMIT, projectArchives } from './project-archives';

it('存档与工程同目录，完整保留内容且不覆盖；仅列出和定位当前工程存档', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-archive-'));
  const projectPath = join(directory, 'test.tblink');
  const content = JSON.stringify(createEmptyLinkProject('原工程'));
  await writeFile(projectPath, content);
  const documents = { inspect: (text: string) => Promise.resolve(parseLinkProject(JSON.parse(text)).name),
    save: async (path: string, text: string) => { await writeFile(path, text, { flag: 'wx' }); } };
  const reveal = vi.fn(); const trash = vi.fn(() => Promise.resolve());
  const base = { version: 1 as const, projectPath };
  const first = await projectArchives({ ...base, action: 'create', content, reason: 'before-sync' }, documents, reveal, trash);
  const second = await projectArchives({ ...base, action: 'create', content, reason: 'manual' }, documents, reveal, trash);
  expect(second.entries).toHaveLength(2); expect(second.createdPath).not.toBe(first.createdPath);
  expect(dirname(first.createdPath!)).toBe(directory);
  expect(await readFile(first.createdPath!, 'utf8')).toBe(content);
  expect(await readFile(projectPath, 'utf8')).toBe(content);
  await projectArchives({ ...base, action: 'reveal', name: first.entries[0]!.name }, documents, reveal, trash);
  expect(reveal).toHaveBeenCalledWith(first.createdPath);
  await expect(projectArchives({ ...base, action: 'reveal', name: '../test.tblink' }, documents, reveal, trash)).rejects.toThrow('不属于');
  const other = join(directory, 'other.tblink'); await writeFile(other, content);
  expect((await projectArchives({ version: 1, projectPath: other, action: 'list' }, documents, reveal, trash)).entries).toEqual([]);
  const failed = { ...documents, save: () => Promise.reject(new Error('磁盘已满')) };
  await expect(projectArchives({ ...base, action: 'create', content, reason: 'manual' }, failed, reveal, trash)).rejects.toThrow('磁盘已满');
  expect((await projectArchives({ ...base, action: 'list' }, documents, reveal, trash)).entries).toHaveLength(2);
});

it('同步前自动存档每个工程只保留最近的上限份，超出的移到回收站；旧格式与手动存档从不清理', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-archive-'));
  const projectPath = join(directory, 'show.tblink');
  const content = JSON.stringify(createEmptyLinkProject('原工程'));
  await writeFile(projectPath, content);
  const legacy = join(directory, `show.存档.2026-10-01T00-00-00.000Z.before-sync.${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}.tblink`);
  await writeFile(legacy, content);
  const documents = { inspect: (text: string) => Promise.resolve(parseLinkProject(JSON.parse(text)).name),
    save: async (path: string, text: string) => { await writeFile(path, text, { flag: 'wx' }); } };
  const trashed: string[] = [];
  const trash = vi.fn((path: string) => { trashed.push(path); return unlink(path); });
  const created: string[] = [];
  await projectArchives({ version: 1, projectPath, action: 'create', content, reason: 'manual' }, documents, vi.fn(), trash);
  for (let index = 0; index < AUTOMATIC_ARCHIVE_LIMIT + 2; index++) {
    created.push((await projectArchives({ version: 1, projectPath, action: 'create', content, reason: 'before-sync' }, documents, vi.fn(), trash)).createdPath!);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  expect(trashed).toEqual(created.slice(0, 2));
  const entries = (await projectArchives({ version: 1, projectPath, action: 'list' }, documents, vi.fn(), trash)).entries;
  expect(entries.filter(entry => entry.name.includes('.auto.'))).toHaveLength(AUTOMATIC_ARCHIVE_LIMIT);
  expect(entries.some(entry => entry.path === legacy && entry.reason === 'before-sync')).toBe(true);
  expect(entries.filter(entry => entry.reason === 'manual')).toHaveLength(1);
});
