import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { installBeautyPlugin } from './beauty-plugin-install';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
afterEach(() => { vi.mocked(rename).mockReset(); });
async function fixture(): Promise<{ root: string; programData: string; target: string; dll: Buffer }> {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rename).mockImplementation(actual.rename);
  const base = resolve('artifacts/beauty-install-tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'case-'));
  const root = join(directory, 'resources'), programData = join(directory, 'program-data');
  const dll = Buffer.alloc(512); dll.writeUInt16LE(0x5a4d, 0); dll.writeUInt32LE(64, 60);
  dll.writeUInt32LE(0x4550, 64); dll.writeUInt16LE(0x8664, 68); dll.writeUInt16LE(240, 84); dll.writeUInt16LE(0x20b, 88);
  await mkdir(join(root, 'runtime/tblink-beauty-worker'), { recursive: true });
  await mkdir(join(root, 'plugin'), { recursive: true });
  for (const file of ['runtime/tblink-beauty-worker/tblink-beauty-worker.exe', 'face_landmarker.task', 'pose_landmarker_lite.task']) await writeFile(join(root, file), 'fixture');
  await writeFile(join(root, 'plugin/tblink-beauty.dll'), dll);
  await writeFile(join(root, 'plugin/beauty.effect'), 'new effect');
  return { root, programData, target: join(programData, 'obs-studio/plugins/tblink-beauty'), dll };
}

it('完整安装与重复安装，备份在 OBS 插件发现目录之外', async () => {
  const { root, programData, target, dll } = await fixture();
  expect(await installBeautyPlugin(root, programData)).toContain('已安装');
  expect(await readFile(join(target, 'bin/64bit/tblink-beauty.dll'))).toEqual(dll);
  expect(await readFile(join(target, 'data/beauty.effect'), 'utf8')).toBe('new effect');
  vi.mocked(rename).mockClear();
  expect(await installBeautyPlugin(root, programData)).toBe('美颜组件已就绪');
  expect(rename).not.toHaveBeenCalled();
  await writeFile(join(target, 'custom.txt'), 'preserve');
  await writeFile(join(root, 'plugin/beauty.effect'), 'updated effect');
  await installBeautyPlugin(root, programData);
  expect(await readFile(join(target, 'custom.txt'), 'utf8')).toBe('preserve');
  expect(await readdir(join(programData, 'obs-studio/plugins'))).toEqual(['tblink-beauty']);
});

it('新目录切换失败恢复整个旧版本，不留下新着色器与旧 DLL 混装', async () => {
  const { root, programData, target, dll } = await fixture();
  await installBeautyPlugin(root, programData);
  await writeFile(join(root, 'plugin/beauty.effect'), 'updated effect');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rename).mockImplementation(async (source, destination) => {
    if (String(source).endsWith('staged')) throw new Error('injected switch failure');
    await actual.rename(source, destination);
  });
  await expect(installBeautyPlugin(root, programData)).rejects.toThrow('原组件已保留');
  expect(await readFile(join(target, 'data/beauty.effect'), 'utf8')).toBe('new effect');
  expect(await readFile(join(target, 'bin/64bit/tblink-beauty.dll'))).toEqual(dll);
});

it('占用阻止旧目录移动时保留旧文件，安装资源损坏也不修改目标', async () => {
  const { root, programData, target } = await fixture();
  await installBeautyPlugin(root, programData);
  await writeFile(join(root, 'plugin/beauty.effect'), 'updated effect');
  vi.mocked(rename).mockRejectedValue(new Error('access denied'));
  await expect(installBeautyPlugin(root, programData)).rejects.toThrow('原组件未修改');
  expect(await readFile(join(target, 'data/beauty.effect'), 'utf8')).toBe('new effect');
  await writeFile(join(root, 'plugin/tblink-beauty.dll'), 'invalid dll');
  vi.mocked(rename).mockClear();
  await expect(installBeautyPlugin(root, programData)).rejects.toThrow('PE 文件范围无效');
  expect(rename).not.toHaveBeenCalled();
});

it('资源缺失时提前失败，不创建 OBS 插件目录', async () => {
  const { root, programData } = await fixture();
  await expect(installBeautyPlugin(join(root, 'missing'), programData)).rejects.toThrow('安装资源缺失');
  expect(rename).not.toHaveBeenCalled();
  await expect(readdir(programData)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('恢复也被阻止时明确报告备份位置，旧版本仍可找回', async () => {
  const { root, programData, target } = await fixture();
  await installBeautyPlugin(root, programData);
  await writeFile(join(root, 'plugin/beauty.effect'), 'updated effect');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let backup = '';
  vi.mocked(rename).mockImplementation(async (source, destination) => {
    if (String(source) === target) { backup = String(destination); await actual.rename(source, destination); }
    else throw new Error('injected switch and restore failure');
  });
  await expect(installBeautyPlugin(root, programData)).rejects.toThrow('安装及恢复失败');
  expect(backup).toContain('previous');
  expect(await readFile(join(backup, 'data/beauty.effect'), 'utf8')).toBe('new effect');
  vi.mocked(rename).mockImplementation(actual.rename);
  expect(await installBeautyPlugin(root, programData)).toContain('上次中断');
  expect(await readFile(join(target, 'data/beauty.effect'), 'utf8')).toBe('new effect');
  expect(await installBeautyPlugin(root, programData)).toContain('已安装');
  expect(await readFile(join(target, 'data/beauty.effect'), 'utf8')).toBe('updated effect');
});

async function interrupted(programData: string, suffix = '1'): Promise<string> {
  const transaction = join(programData, 'obs-studio/tblink-beauty-installations', `00000000-0000-0000-0000-00000000000${suffix}`);
  await mkdir(join(transaction, 'staged'), { recursive: true });
  await writeFile(join(transaction, 'pending'), 'tblink-beauty-installation-1\n');
  return transaction;
}

it('目录移动后进程中断，下次只恢复旧版，明确要求再次安装', async () => {
  const { root, programData, target } = await fixture();
  await installBeautyPlugin(root, programData);
  const transaction = await interrupted(programData);
  await rename(target, join(transaction, 'previous'));
  await writeFile(join(root, 'plugin/beauty.effect'), 'updated effect');
  expect(await installBeautyPlugin(root, programData)).toContain('上次中断');
  expect(await readFile(join(target, 'data/beauty.effect'), 'utf8')).toBe('new effect');
  expect(await readFile(join(transaction, 'settled'), 'utf8')).toBe('tblink-beauty-installation-1\n');
  expect(await installBeautyPlugin(root, programData)).toContain('已安装');
});

it('切换完成但记录未落盘时保留当前新版，不回退备份', async () => {
  const { root, programData, target } = await fixture();
  await installBeautyPlugin(root, programData);
  const transaction = await interrupted(programData);
  await rename(target, join(transaction, 'previous'));
  await mkdir(join(target, 'data'), { recursive: true });
  await writeFile(join(target, 'data/beauty.effect'), 'already switched');
  expect(await installBeautyPlugin(root, programData)).toContain('上次中断');
  expect(await readFile(join(target, 'data/beauty.effect'), 'utf8')).toBe('already switched');
  expect(await readFile(join(transaction, 'previous/data/beauty.effect'), 'utf8')).toBe('new effect');
});

it('首次安装中断不发布未完成的暂存目录，多个记录不猜测恢复', async () => {
  const { root, programData, target } = await fixture();
  await interrupted(programData);
  expect(await installBeautyPlugin(root, programData)).toContain('上次中断');
  await expect(readdir(target)).rejects.toMatchObject({ code: 'ENOENT' });
  await interrupted(programData, '2');
  await interrupted(programData, '3');
  await expect(installBeautyPlugin(root, programData)).rejects.toThrow('多个未完成');
  await expect(readdir(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
