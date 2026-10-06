import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createEmptyLinkProject } from '@tb/schema';
import { Ma2MaterialRecovery } from './ma2-material-recovery';
import { LinkProjectService } from './link-project-service';

it('素材读取中断后恢复已落盘序列；损坏一条不丢其他条，来源未核对不冒充完成', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tblink-material-'));
  const path = join(root, 'test.tblink');
  const project = createEmptyLinkProject('素材恢复');
  const service = new LinkProjectService(); await service.save(path, project);
  const recovery = new Ma2MaterialRecovery(path, project.projectId, '本机 onPC');
  const directory = { show: '离线恢复测试', generation: 'one', version: '3.7.0.5', entries: [{ target: 36, name: '原名称' }, { target: 37, name: '第二条' }] };
  await recovery.record({ phase: 'library', completed: 0, total: 3, detail: '开始', checkpoint: { directory, readAt: '2026-10-05T00:00:00.000Z' } });
  for (const entry of directory.entries) await recovery.record({ phase: 'library', completed: 1, total: 3, detail: '完成', sequences: [{ sequence: entry.target, name: entry.name, cues: [{ index: 1, number: '1.100', name: '原步名' }] }] });
  const restored = (await service.open(path)).ma2MaterialLibrary;
  expect(restored?.library.sequences).toHaveLength(2);
  expect(restored?.library.sourceUnverified).toBe(true);
  const directoryName = (await readdir(`${path}.ma2-material-recovery`)).find(name => name !== 'active.json')!;
  await writeFile(join(`${path}.ma2-material-recovery`, directoryName, '37.json'), '{broken');
  const damaged = (await service.open(path)).ma2MaterialLibrary;
  expect(damaged?.library.sequences[0]?.cues[0]?.number).toBe('1.100');
  expect(damaged?.library.errors[0]?.sequence).toBe(37);
  await service.save(path, createEmptyLinkProject('其他工程'));
  expect((await service.open(path)).ma2MaterialLibrary).toBeUndefined();
});
