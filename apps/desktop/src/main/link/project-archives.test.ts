import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { projectArchives } from './project-archives';

it('存档与工程同目录，完整保留内容且不覆盖；仅列出和定位当前工程存档', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-archive-'));
  const projectPath = join(directory, 'test.tblink');
  const content = JSON.stringify(createEmptyLinkProject('原工程'));
  await writeFile(projectPath, content);
  const documents = { inspect: (text: string) => Promise.resolve(parseLinkProject(JSON.parse(text)).name),
    save: async (path: string, text: string) => { await writeFile(path, text, { flag: 'wx' }); } };
  const reveal = vi.fn();
  const base = { version: 1 as const, projectPath };
  const first = await projectArchives({ ...base, action: 'create', content, reason: 'before-sync' }, documents, reveal);
  const second = await projectArchives({ ...base, action: 'create', content, reason: 'manual' }, documents, reveal);
  expect(second.entries).toHaveLength(2); expect(second.createdPath).not.toBe(first.createdPath);
  expect(dirname(first.createdPath!)).toBe(directory);
  expect(await readFile(first.createdPath!, 'utf8')).toBe(content);
  expect(await readFile(projectPath, 'utf8')).toBe(content);
  await projectArchives({ ...base, action: 'reveal', name: first.entries[0]!.name }, documents, reveal);
  expect(reveal).toHaveBeenCalledWith(first.createdPath);
  await expect(projectArchives({ ...base, action: 'reveal', name: '../test.tblink' }, documents, reveal)).rejects.toThrow('不属于');
  const other = join(directory, 'other.tblink'); await writeFile(other, content);
  expect((await projectArchives({ version: 1, projectPath: other, action: 'list' }, documents, reveal)).entries).toEqual([]);
  const failed = { ...documents, save: () => Promise.reject(new Error('磁盘已满')) };
  await expect(projectArchives({ ...base, action: 'create', content, reason: 'manual' }, failed, reveal)).rejects.toThrow('磁盘已满');
  expect((await projectArchives({ ...base, action: 'list' }, documents, reveal)).entries).toHaveLength(2);
});
