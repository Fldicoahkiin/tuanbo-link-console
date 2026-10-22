import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RecoveryCopies } from './recovery-copies';

const session = '11111111-1111-4111-8111-111111111111';
const otherSession = '22222222-2222-4222-8222-222222222222';

async function copies(times: string[] = []): Promise<{ store: RecoveryCopies; directory: string; written: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-recovery-'));
  const written: string[] = [];
  const clock = [...times];
  const store = new RecoveryCopies(directory, { writeCopy: async (path, content) => { written.push(path); await writeFile(path, content); } },
    () => new Date(clock.shift() ?? '2026-10-22T08:00:00.000Z'));
  return { store, directory, written };
}
const named = { projectPath: 'C:\\shows\\演出.tblink', projectId: 'project-a' };
const write = (owner: { projectPath: string | null; projectId: string }, revision: number, content = `{"revision":${revision}}`, sessionId = session) =>
  ({ version: 1 as const, ...owner, name: '演出', sessionId, revision, content });

describe('RecoveryCopies', () => {
  it('写入恢复副本和记录，不写工程文件；按工程文件找回', async () => {
    const { store, written } = await copies();
    await store.write(write(named, 3));
    const found = await store.find(named);
    expect(found?.manifest).toMatchObject({ projectPath: named.projectPath, projectId: 'project-a', sessionId: session, revision: 3, name: '演出' });
    expect(await readFile(found!.copyPath, 'utf8')).toBe('{"revision":3}');
    expect(written).toEqual([found!.copyPath]);
    expect(written[0]).not.toContain('演出.tblink');
    expect(await store.find({ projectPath: 'C:\\shows\\其他.tblink', projectId: 'project-a' })).toBeNull();
  });

  it('同一工程的写入按调用顺序完成，较早的写入不会覆盖较新的副本', async () => {
    const { store } = await copies();
    await Promise.all([store.write(write(named, 1)), store.write(write(named, 2)), store.write(write(named, 3))]);
    const found = await store.find(named);
    expect(found?.manifest.revision).toBe(3);
    expect(await readFile(found!.copyPath, 'utf8')).toBe('{"revision":3}');
  });

  it('保存后清理只删除不晚于保存版本的副本；保存期间继续编辑写入的副本保留', async () => {
    const { store, directory } = await copies();
    await store.write(write(named, 5));
    expect(await store.discard({ version: 1, ...named, keep: { sessionId: session, revision: 4 } })).toBe(false);
    expect(await store.find(named)).not.toBeNull();
    expect(await store.discard({ version: 1, ...named, keep: { sessionId: session, revision: 5 } })).toBe(true);
    expect(await store.find(named)).toBeNull();
    expect(await readdir(directory)).toEqual([]);
  });

  it('其他会话留下的旧副本在保存后清理，明确丢弃时无论版本都删除', async () => {
    const { store } = await copies();
    await store.write(write(named, 50, '{}', otherSession));
    expect(await store.discard({ version: 1, ...named, keep: { sessionId: session, revision: 1 } })).toBe(true);
    await store.write(write(named, 9));
    expect(await store.discard({ version: 1, ...named })).toBe(true);
    expect(await store.discard({ version: 1, ...named })).toBe(false);
  });

  it('未命名工程按工程身份保存，启动时找最新的一份；有路径的副本不参与', async () => {
    const { store } = await copies(['2026-10-22T08:00:00.000Z', '2026-10-22T09:00:00.000Z', '2026-10-22T10:00:00.000Z']);
    await store.write(write({ projectPath: null, projectId: 'older' }, 1));
    await store.write(write({ projectPath: null, projectId: 'newer' }, 1));
    await store.write(write(named, 1));
    expect((await store.latestUnnamed())?.manifest.projectId).toBe('newer');
    await store.discard({ version: 1, projectPath: null, projectId: 'newer' });
    expect((await store.latestUnnamed())?.manifest.projectId).toBe('older');
  });

  it('副本记录损坏时明确报错，不当作没有副本', async () => {
    const { store, directory } = await copies();
    await store.write(write(named, 1));
    const [manifest] = (await readdir(directory)).filter(name => name.endsWith('.json'));
    await writeFile(join(directory, manifest!), '{broken');
    await expect(store.find(named)).rejects.toThrow('恢复副本记录无法读取');
    await expect(store.latestUnnamed()).rejects.toThrow('恢复副本记录无法读取');
  });

  it('副本文件已被移走时没有可恢复的内容', async () => {
    const { store, directory } = await copies();
    await store.write(write(named, 1));
    const [copy] = (await readdir(directory)).filter(name => name.endsWith('.tblink'));
    await unlink(join(directory, copy!));
    expect(await store.find(named)).toBeNull();
  });
});
