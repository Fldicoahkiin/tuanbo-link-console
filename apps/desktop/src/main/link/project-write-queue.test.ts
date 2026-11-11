import { it, expect } from 'vitest';
import { createEmptyLinkProject } from '@tb/schema';
import { ProjectWriteQueue } from './project-write-queue';

it('慢磁盘期间只写当前与最新修订，确认不会早于实际落盘', async () => {
  const releases: (() => void)[] = [], written: string[] = [], confirmed: number[] = [];
  const queue = new ProjectWriteQueue(async (_path, project) => {
    written.push(project.name);
    await new Promise<void>(resolve => releases.push(resolve));
    return null;
  });
  const project = createEmptyLinkProject('0');
  const operations = Array.from({ length: 100 }, (_, index) => queue.enqueue('C:/shows/load.tblink', { ...project, name: String(index) }).then(() => { confirmed.push(index); }));
  expect(written).toEqual(['0']); expect(confirmed).toEqual([]);
  releases[0]!(); await operations[0];
  expect(written).toEqual(['0', '99']); expect(confirmed).toEqual([0]);
  releases[1]!(); await Promise.all(operations);
  expect(confirmed).toHaveLength(100); expect(written).toHaveLength(2);
});

it('写入失败向调用方报错，另一工程与之后的明确保存独立运行', async () => {
  let fail: (error: Error) => void = () => { throw new Error('尚未开始'); };
  let first = true;
  const queue = new ProjectWriteQueue(async path => {
    if (path.includes('blocked') && first) { first = false; await new Promise<void>((_resolve, reject) => { fail = reject; }); }
    return null;
  });
  const project = createEmptyLinkProject('工程');
  const result = queue.enqueue('C:/shows/blocked.tblink', project).then(() => 'saved', error => String(error));
  await expect(queue.enqueue('C:/shows/independent.tblink', project)).resolves.toBeNull();
  fail(new Error('写盘被拒绝'));
  expect(await result).toContain('写盘被拒绝');
  await expect(queue.enqueue('C:/shows/blocked.tblink', project)).resolves.toBeNull();
});

it('最新合并批次没有落盘时不能把任何中间修订标为已保存', async () => {
  let release: () => void = () => { throw new Error('尚未开始'); };
  let calls = 0;
  const queue = new ProjectWriteQueue(async () => {
    if (++calls === 1) await new Promise<void>(resolve => { release = resolve; });
    else throw new Error('磁盘空间不足');
    return null;
  });
  const project = createEmptyLinkProject('工程');
  const first = queue.enqueue('C:/shows/merged.tblink', project);
  const second = queue.enqueue('C:/shows/merged.tblink', { ...project, name: '第二版' });
  const third = queue.enqueue('C:/shows/merged.tblink', { ...project, name: '第三版' });
  const settled = Promise.allSettled([second, third]);
  release(); await first;
  expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(calls).toBe(2);
});

it('合并的保存只要有一次同意了覆盖旧版本能打开的文件，就按同意写，并把留下的备份告诉每个调用方', async () => {
  let release: () => void = () => { throw new Error('尚未开始'); };
  const seen: boolean[] = [];
  const queue = new ProjectWriteQueue(async (_path, _project, options) => {
    seen.push(options.replaceOlderFormat);
    if (seen.length === 1) await new Promise<void>(resolve => { release = resolve; });
    return options.replaceOlderFormat ? 'C:/shows/merged（旧版本可打开的备份）.tblink' : null;
  });
  const project = createEmptyLinkProject('工程');
  const first = queue.enqueue('C:/shows/merged.tblink', project);
  const second = queue.enqueue('C:/shows/merged.tblink', project, { replaceOlderFormat: true });
  const third = queue.enqueue('C:/shows/merged.tblink', project);
  release();
  expect(await first).toBeNull();
  expect(await Promise.all([second, third])).toEqual(['C:/shows/merged（旧版本可打开的备份）.tblink', 'C:/shows/merged（旧版本可打开的备份）.tblink']);
  expect(seen).toEqual([false, true]);
});
