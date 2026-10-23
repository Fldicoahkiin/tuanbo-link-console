import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ma2DataDirectory, detectMa2DataDirectory } from './ma2-data-directory';

async function onpcData(root: string, name: string): Promise<string> {
  const directory = join(root, name);
  for (const part of ['temp', 'plugins', 'importexport']) await mkdir(join(directory, part), { recursive: true });
  return directory;
}

describe('Ma2DataDirectory', () => {
  it('只接受主进程记录的目录（含同一目录的其他写法），记录跨重启保留', async () => {
    const base = await mkdtemp(join(tmpdir(), 'tblink-ma2-data-'));
    const chosen = await onpcData(base, 'gma2_V_3.3.4'), other = await onpcData(base, 'gma2_V_3.7');
    const record = join(base, 'record.json');
    const store = new Ma2DataDirectory(record);
    expect(await store.current()).toBeNull();
    await expect(store.require(chosen)).rejects.toThrow('一键识别');
    await store.choose(chosen);
    await store.require(join(chosen, '.'));
    await expect(store.require(other)).rejects.toThrow('一键识别');
    const reopened = new Ma2DataDirectory(record);
    expect(await reopened.current()).toBe(chosen);
    await reopened.require(chosen);
  });
});

describe('detectMa2DataDirectory', () => {
  it('按正在运行的 onPC 版本找到唯一的数据目录；对不上或多个可选时要求手动选择', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tblink-grandma-'));
    const v334 = await onpcData(root, 'gma2_V_3.3.4'); const v37 = await onpcData(root, 'gma2_V_3.7');
    await mkdir(join(root, 'gma2_V_3.9'));
    expect(await detectMa2DataDirectory(root, '3.3.4.3')).toBe(v334);
    expect(await detectMa2DataDirectory(root, '3.7.0.5')).toBe(v37);
    await expect(detectMa2DataDirectory(root, '3.9.0.1')).rejects.toThrow('选择');
    await expect(detectMa2DataDirectory(root, null)).rejects.toThrow('选择');
    const single = await mkdtemp(join(tmpdir(), 'tblink-grandma-single-'));
    const only = await onpcData(single, 'gma2_V_3.3.4');
    expect(await detectMa2DataDirectory(single, null)).toBe(only);
    await expect(detectMa2DataDirectory(join(single, 'missing'), '3.3.4.3')).rejects.toThrow('选择');
  });
});
