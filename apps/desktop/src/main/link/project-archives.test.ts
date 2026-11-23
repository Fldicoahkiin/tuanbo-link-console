import { mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { DEFAULT_ARCHIVE_SETTINGS, ProjectArchiveSettingsStore, projectArchives } from './project-archives';

const documents = { inspect: (text: string) => Promise.resolve(parseLinkProject(JSON.parse(text)).name),
  save: async (path: string, text: string) => { parseLinkProject(JSON.parse(text)); await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); return null; } };
async function setup(name = 'show') {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-archive-'));
  const projectPath = join(directory, 'project', `${name}.tblink`);
  const content = JSON.stringify(createEmptyLinkProject('原工程'));
  await mkdir(dirname(projectPath), { recursive: true }); await writeFile(projectPath, content);
  const store = new ProjectArchiveSettingsStore(join(directory, 'userData', 'archive-settings.json'), join(directory, 'Documents', '团播联动台', '存档'));
  const trash = vi.fn((path: string) => unlink(path).then(() => true));
  let clock = new Date(2026, 9, 21, 14, 30, 5).getTime();
  const now = () => new Date(clock += 1000);
  const run = (request: object) => projectArchives({ version: 1, projectPath, ...request }, documents, store, vi.fn(), trash, now);
  return { directory, projectPath, content, store, trash, run, root: store.defaultDirectory, setClock: (value: number) => { clock = value; } };
}

it('存档放在 文档\\团播联动台\\存档\\<工程名>，文件名可读；内容完整，工程文件不变', async () => {
  const t = await setup();
  const auto = await t.run({ action: 'create', content: t.content, reason: 'before-sync' });
  const manual = await t.run({ action: 'create', content: t.content, reason: 'manual' });
  expect(dirname(auto.createdPath!)).toBe(join(t.root, 'show'));
  expect(auto.createdPath!.endsWith('show 2026-10-21 14-30-06 同步前.tblink')).toBe(true);
  expect(manual.createdPath!.endsWith('show 2026-10-21 14-30-07 手动.tblink')).toBe(true);
  expect(await readFile(auto.createdPath!, 'utf8')).toBe(t.content);
  expect(manual.entries.map(entry => entry.reason)).toEqual(['manual', 'before-sync']);
  await expect(t.run({ action: 'reveal', name: '../show.tblink' })).rejects.toThrow('不属于');
  await expect(projectArchives({ version: 1, projectPath: t.projectPath, action: 'create', content: t.content, reason: 'manual' }, { ...documents, save: () => Promise.reject(new Error('磁盘已满')) }, t.store, vi.fn(), t.trash)).rejects.toThrow('磁盘已满');
});

it('同步只等存档和索引写好，坏工程不会入档，随后打开列表仍能找到完整的存档', async () => {
  const t = await setup();
  const request = { action: 'create', reason: 'before-sync', includeEntries: false };
  await expect(t.run({ ...request, content: 'broken' })).rejects.toThrow();
  const result = await t.run({ ...request, content: t.content });
  expect(result.entries).toEqual([]);
  expect(await readFile(result.createdPath!, 'utf8')).toBe(t.content);
  expect((await t.run({ action: 'list' })).entries.map(entry => entry.path)).toEqual([result.createdPath]);
});
it('同一秒的手动存档和同步前存档并发时，两份内容和记录都在', async () => {
  const t = await setup();
  await t.store.write({ ...DEFAULT_ARCHIVE_SETTINGS, nameTemplate: '{工程名}' });
  const edits = ['手动', '同步前'].map(name => JSON.stringify(createEmptyLinkProject(name)));
  const saved = await Promise.all(edits.map((content, i) => t.run({ action: 'create', content, reason: i ? 'before-sync' : 'manual' })));
  expect(new Set(saved.map(item => item.createdPath)).size).toBe(2);
  expect(await Promise.all(saved.map(item => readFile(item.createdPath!, 'utf8')))).toEqual(edits);
  expect((await t.run({ action: 'list' })).entries).toHaveLength(2);
});

it('同一秒重名加序号；命名模板可改，非法字符替换', async () => {
  const t = await setup();
  await t.store.write({ ...DEFAULT_ARCHIVE_SETTINGS, nameTemplate: '备份-{日期}' });
  t.setClock(new Date(2026, 9, 21, 9, 0, 0).getTime());
  const first = await projectArchives({ version: 1, projectPath: t.projectPath, action: 'create', content: t.content, reason: 'manual' }, documents, t.store, vi.fn(), t.trash, () => new Date(2026, 9, 21, 9, 0, 0));
  const second = await projectArchives({ version: 1, projectPath: t.projectPath, action: 'create', content: t.content, reason: 'manual' }, documents, t.store, vi.fn(), t.trash, () => new Date(2026, 9, 21, 9, 0, 0));
  expect([first.createdPath, second.createdPath].map(path => path!.split(/[\\/]/).at(-1))).toEqual(['备份-2026-10-21.tblink', '备份-2026-10-21 (2).tblink']);
  await expect(t.store.write({ ...DEFAULT_ARCHIVE_SETTINGS, nameTemplate: 'a/b' })).rejects.toThrow();
});

it('只按清单清理超出份数的自动存档，移到回收站；手动存档、清单外文件和工程旁旧存档不动', async () => {
  const t = await setup();
  await t.store.write({ ...DEFAULT_ARCHIVE_SETTINGS, keep: 3 });
  const legacy = join(dirname(t.projectPath), `show.存档.2026-10-01T00-00-00.000Z.before-sync.${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}.tblink`);
  await writeFile(legacy, t.content);
  await t.run({ action: 'create', content: t.content, reason: 'manual' });
  const created: string[] = [];
  for (let index = 0; index < 5; index++) created.push((await t.run({ action: 'create', content: t.content, reason: 'before-sync' })).createdPath!);
  await writeFile(join(t.root, 'show', '用户自己放的.tblink'), t.content);
  expect(t.trash.mock.calls.map(call => call[0])).toEqual(created.slice(0, 2));
  const listed = await t.run({ action: 'list' });
  expect(listed.entries.filter(entry => entry.reason === 'before-sync').map(entry => entry.path)).toEqual([...created.slice(2).reverse(), legacy]);
  expect(listed.entries.filter(entry => entry.reason === 'manual')).toHaveLength(1);
  expect((await readdir(join(t.root, 'show'))).includes('用户自己放的.tblink')).toBe(true);
  t.trash.mockResolvedValueOnce(false);
  await t.run({ action: 'create', content: t.content, reason: 'before-sync' });
  expect((await t.store.status()).fileCount).toBe(5);
});

it('关闭自动存档后同步前不再写文件并明确返回已关闭，手动存档照常', async () => {
  const t = await setup();
  await t.store.write({ ...DEFAULT_ARCHIVE_SETTINGS, enabled: false });
  const skipped = await t.run({ action: 'create', content: t.content, reason: 'before-sync' });
  expect(skipped).toMatchObject({ disabled: true, entries: [] }); expect(skipped.createdPath).toBeUndefined();
  expect((await t.run({ action: 'create', content: t.content, reason: 'manual' })).createdPath).toBeDefined();
});

it('同步关闭了自动存档时不访问旧存档位置，手动存档仍提示实际错误', async () => {
  const t = await setup();
  const oldDirectory = join(t.directory, '以前的存档位置');
  await writeFile(oldDirectory, '保留这个文件');
  await t.store.write({ ...DEFAULT_ARCHIVE_SETTINGS, enabled: false, directory: oldDirectory });
  const request = { action: 'create', content: t.content, includeEntries: false };
  await expect(t.run({ ...request, reason: 'before-sync' })).resolves.toMatchObject({ disabled: true, entries: [] });
  await expect(t.run({ ...request, reason: 'manual' })).rejects.toThrow();
  expect(await readFile(oldDirectory, 'utf8')).toBe('保留这个文件');
});

it('恢复时先把当前文件存一份「恢复前」，再把存档写回原工程位置', async () => {
  const t = await setup();
  const archived = await t.run({ action: 'create', content: t.content, reason: 'manual' });
  const edited = JSON.stringify(createEmptyLinkProject('改过的工程'));
  await writeFile(t.projectPath, edited);
  const result = await t.run({ action: 'restore', name: archived.entries[0]!.name });
  expect(await readFile(t.projectPath, 'utf8')).toBe(t.content);
  const before = result.entries.find(entry => entry.name.includes('恢复前'))!;
  expect(await readFile(before.path, 'utf8')).toBe(edited);
});

it('首份存档写入失败后重试仍使用为本工程分配的文件夹', async () => {
  const t = await setup();
  const request = { version: 1, projectPath: t.projectPath, action: 'create', content: t.content, reason: 'before-sync' };
  await expect(projectArchives(request, { ...documents, save: () => Promise.reject(new Error('写入失败')) }, t.store, vi.fn(), t.trash)).rejects.toThrow('写入失败');
  expect((await t.run({ action: 'list' })).entries).toHaveLength(0);
  const restored = await t.run(request);
  expect(dirname(restored.createdPath!)).toBe(join(t.root, 'show'));
  expect(await readdir(t.root)).toEqual(['show']);
});

it('百份同名工程仍可同步前存档，移走较早目录也能找回原存档', async () => {
  const t = await setup();
  await mkdir(t.root, { recursive: true });
  // A file with the base name and 98 directories owned by other projects.
  await writeFile(join(t.root, 'show'), 'keep');
  for (let suffix = 2; suffix <= 99; suffix++) {
    const folder = join(t.root, `show (${suffix})`);
    await mkdir(folder);
    await writeFile(join(folder, '.tblink-archives.json'), JSON.stringify({ version: 1, projectPath: join(t.directory, String(suffix), 'show.tblink'), entries: [] }));
  }
  const save = () => t.run({ action: 'create', content: t.content, reason: 'before-sync' });
  const original = await save();
  expect(dirname(original.createdPath!)).toBe(join(t.root, 'show (100)'));
  await unlink(join(t.root, 'show'));
  expect((await t.run({ action: 'list' })).entries.map(entry => entry.path)).toEqual([original.createdPath]);
  const again = await save();
  expect(dirname(again.createdPath!)).toBe(join(t.root, 'show (100)'));
  expect(again.entries).toHaveLength(2);
});

it('存档模板固定时越过第 999 个同名文件，原有文件逐份保留', async () => {
  const t = await setup();
  await t.store.write({ ...DEFAULT_ARCHIVE_SETTINGS, nameTemplate: '{工程名}' });
  const save = () => t.run({ action: 'create', content: t.content, reason: 'manual' });
  const first = await save();
  const folder = dirname(first.createdPath!);
  for (let start = 2; start <= 999; start += 40) {
    await Promise.all(Array.from({ length: Math.min(40, 1000 - start) }, (_, offset) => writeFile(join(folder, `show (${start + offset}).tblink`), 'keep')));
  }
  const next = await save();
  expect(next.createdPath).toBe(join(folder, 'show (1000).tblink'));
  expect(await readFile(join(folder, 'show (999).tblink'), 'utf8')).toBe('keep');
  expect(await readFile(first.createdPath!, 'utf8')).toBe(t.content);
});

it('同名的两个工程分开存放；设置默认开启、20 份，位置必须是完整路径；占用只统计清单内文件', async () => {
  const t = await setup();
  const otherPath = join(t.directory, 'elsewhere', 'show.tblink');
  await mkdir(dirname(otherPath), { recursive: true }); await writeFile(otherPath, t.content);
  const first = await t.run({ action: 'create', content: t.content, reason: 'manual' });
  const other = await projectArchives({ version: 1, projectPath: otherPath, action: 'create', content: t.content, reason: 'manual' }, documents, t.store, vi.fn(), t.trash);
  expect(dirname(first.createdPath!)).toBe(join(t.root, 'show'));
  expect(dirname(other.createdPath!)).toBe(join(t.root, 'show (2)'));
  expect(await t.store.read()).toEqual(DEFAULT_ARCHIVE_SETTINGS);
  expect(DEFAULT_ARCHIVE_SETTINGS).toMatchObject({ enabled: true, keep: 20 });
  await expect(t.store.write({ ...DEFAULT_ARCHIVE_SETTINGS, directory: 'relative' })).rejects.toThrow('完整');
  const status = await t.store.status();
  expect(status).toMatchObject({ directory: t.root, fileCount: 2 });
  expect(status.usageBytes).toBe(Buffer.byteLength(t.content) * 2);
});
