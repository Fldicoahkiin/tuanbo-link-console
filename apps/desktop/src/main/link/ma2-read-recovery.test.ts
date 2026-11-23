import { mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createEmptyLinkProject, type Ma2Catalog } from '@tb/schema';
import { Ma2ReadRecovery, recoverMa2Read } from './ma2-read-recovery';
import { LinkProjectService } from './link-project-service';
import { reconcileMa2ReadState, saveMa2ReadStateCommand } from '@tb/core/link';

it('已保存的时间线不会在重开时被之前另一个 Show 的目录替换', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-saved-show-')), 'show.tblink');
  const project = createEmptyLinkProject('现场');
  const service = new LinkProjectService();
  const entry = { target: 3, name: '节目', eventCount: 0, frameFormat: null, offset: '0', slot: null, events: [], warnings: [], error: null };
  const catalog: Ma2Catalog = { directory: { show: '原 Show', generation: 'one', version: '3.7.0.5', entries: [{ target: 3, name: entry.name }] },
    readAt: '2026-10-01T00:00:00.000Z', entries: [entry] };
  const saved = saveMa2ReadStateCommand(reconcileMa2ReadState(project, 'onPC', catalog)).execute(project);
  await service.save(path, saved);
  const other = { ...catalog, readAt: '2026-10-02T00:00:00.000Z', directory: { ...catalog.directory, show: '另一个 Show' } };
  const recovery = new Ma2ReadRecovery(path, project.projectId, 'onPC');
  await recovery.checkpoint(other, entry);
  const stamp = new Date(other.readAt);
  await utimes(`${path}.ma2-recovery/active.json`, stamp, stamp);
  await utimes(path, new Date(catalog.readAt), new Date(catalog.readAt));
  expect((await service.open(path)).ma2ReadState?.catalog.directory.show).toBe('另一个 Show');
  await service.save(path, saved);
  const resaved = new Date(stamp.getTime() + 1000);
  await utimes(path, resaved, resaved);
  expect((await service.open(path)).ma2ReadState?.catalog.directory.show).toBe('原 Show');
});

it('中断后从逐条检查点恢复；一条损坏不丢其余结果，另一工程不接收', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tblink-recovery-'));
  const path = join(root, 'show.tblink');
  const project = createEmptyLinkProject('恢复测试');
  const service = new LinkProjectService();
  await service.save(path, project);
  const catalog: Ma2Catalog = { directory: { show: '现场', generation: 'session', version: '3.7.0.5', entries: [1, 2].map(target => ({ target, name: `时间线${target}` })) }, readAt: new Date().toISOString(), entries: [] };
  const recovery = new Ma2ReadRecovery(path, project.projectId, 'console');
  await recovery.checkpoint(catalog);
  for (const object of catalog.directory.entries) await recovery.checkpoint(catalog, { ...object, sourceXml: `<MA target="${object.target}"/>`, eventCount: 0, frameFormat: '30 FPS', offset: '0', slot: null, events: [], error: null, warnings: [] });
  expect((await service.open(path)).ma2ReadState?.catalog.entries).toHaveLength(2);
  const checkpointDirectory = (await readdir(`${path}.ma2-recovery`)).find(value => value !== 'active.json');
  if (!checkpointDirectory) throw new Error('检查点目录未生成');
  await writeFile(join(`${path}.ma2-recovery`, checkpointDirectory, '2.json'), '{broken');
  const restored = await service.open(path);
  expect(restored.ma2ReadState?.catalog.entries[0]?.sourceXml).toBe('<MA target="1"/>');
  expect(restored.ma2ReadState?.catalog.entries[1]?.error).toContain('恢复记录损坏');
  expect(await recoverMa2Read(path, createEmptyLinkProject('另一工程'))).not.toHaveProperty('ma2ReadState');
  await service.save(path, restored);
  expect(JSON.parse(await readFile(`${path}.before-ma2-workflow.bak`, 'utf8'))).toEqual(project);
  expect((await service.open(path)).ma2ReadState?.catalog.entries).toHaveLength(2);
});

it('全量扫描已经完成，重开尚未保存读取结果的工程仍能复用；缺少条目继续标记未读全', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tblink-reopen-'));
  const path = join(root, 'show.tblink');
  const project = createEmptyLinkProject('完整读取');
  const service = new LinkProjectService();
  await service.save(path, project);
  const directory = { show: '测试', generation: 'same', version: '3.3.4.3', entries: [{ target: 1, name: 'A' }, { target: 2, name: 'B' }] };
  const catalog = { directory, readAt: new Date().toISOString(), entries: [], sourceUnverified: false };
  for (const count of [2, 1]) {
    const recovery = new Ma2ReadRecovery(path, project.projectId, 'console');
    await recovery.checkpoint({ ...catalog, incomplete: '读取中' });
    for (const object of directory.entries.slice(0, count)) {
      await recovery.checkpoint(catalog, { ...object, eventCount: 0, frameFormat: null, offset: '0', slot: null, events: [], error: null, warnings: [] });
    }
    await recovery.checkpoint(catalog);
    const restored = (await service.open(path)).ma2ReadState!.catalog;
    expect(restored.entries).toHaveLength(count);
    expect(Boolean(restored.incomplete)).toBe(count !== directory.entries.length);
  }
});
