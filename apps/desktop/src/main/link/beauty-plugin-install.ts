import { createHash, randomUUID } from 'node:crypto';
import { access, cp, lstat, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { obsPluginFingerprint } from './obs-plugin-fingerprint';

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`美颜安装路径不是普通目录：${path}`);
    return true;
  } catch (error) { if (missing(error)) return false; throw error; }
}

async function checkpoint(transaction: string, name: 'pending' | 'settled'): Promise<void> {
  const handle = await open(join(transaction, name), 'wx');
  try { await handle.writeFile('tblink-beauty-installation-1\n'); await handle.sync(); }
  finally { await handle.close(); }
}

async function hasCheckpoint(transaction: string, name: 'pending' | 'settled'): Promise<boolean> {
  try {
    const path = join(transaction, name);
    if (!(await lstat(path)).isFile()) throw new Error(`美颜安装记录无效：${path}`);
    if (await readFile(path, 'utf8') !== 'tblink-beauty-installation-1\n') throw new Error(`美颜安装记录损坏：${path}`);
    return true;
  } catch (error) { if (missing(error)) return false; throw error; }
}

/** Reconcile only journaled transactions; never replace an existing installation during recovery. */
async function recoverInstallation(parent: string, target: string): Promise<boolean> {
  const history = join(parent, 'tblink-beauty-installations');
  if (!await directoryExists(history)) return false;
  const pending: string[] = [];
  for (const entry of await readdir(history, { withFileTypes: true })) {
    if (!/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    const transaction = join(history, entry.name);
    await directoryExists(transaction);
    if (await hasCheckpoint(transaction, 'pending') && !await hasCheckpoint(transaction, 'settled')) pending.push(transaction);
  }
  if (!pending.length) return false;
  if (pending.length !== 1) throw new Error(`有多个没完成的美颜安装记录，请保留 ${history} 文件夹并查看日志`);
  const transaction = pending[0];
  if (!transaction) throw new Error('美颜安装恢复记录缺失');
  if (!await directoryExists(target)) {
    const backup = join(transaction, 'previous');
    if (await directoryExists(backup)) {
      try { await rename(backup, target); }
      catch (error) { throw new Error(`无法恢复上次的美颜安装，原来的组件保留在 ${backup}`, { cause: error }); }
    }
  }
  await checkpoint(transaction, 'settled');
  return true;
}

/** Stage the complete owned plugin outside OBS's discovery directory before replacing it. */
export async function installBeautyPlugin(root: string, programData: string): Promise<string> {
  const parent = join(programData, 'obs-studio');
  const target = join(parent, 'plugins/tblink-beauty');
  if (await recoverInstallation(parent, target)) return '已处理上次中断的安装，现有组件保留。请重新点“安装”来更新美颜';
  for (const file of ['runtime/tblink-beauty-worker/tblink-beauty-worker.exe', 'face_landmarker.task', 'pose_landmarker_lite.task']) {
    try { await access(join(root, file)); }
    catch (error) { throw new Error(`美颜安装文件缺失或读不了：${file}`, { cause: error }); }
  }
  const files = await Promise.all([['plugin/beauty.effect', 'data/beauty.effect'], ['plugin/tblink-beauty.dll', 'bin/64bit/tblink-beauty.dll']].map(async ([source, target]) => {
    if (!source || !target) throw new Error('美颜组件清单无效');
    return { target, bytes: await readFile(join(root, source)) };
  }));
  const binary = files.find(file => file.target.endsWith('.dll'));
  if (!binary) throw new Error('美颜组件缺少 DLL');
  obsPluginFingerprint(binary.bytes);
  const exists = await directoryExists(target);
  let unchanged = exists;
  for (const file of files) {
    try { if (digest(await readFile(join(target, file.target))) !== digest(file.bytes)) unchanged = false; }
    catch (error) { if (missing(error)) unchanged = false; else throw error; }
  }
  if (unchanged) return '美颜组件已就绪';
  const transaction = join(parent, 'tblink-beauty-installations', randomUUID());
  const staged = join(transaction, 'staged'), backup = join(transaction, 'previous');
  await mkdir(staged, { recursive: true });
  if (exists) await cp(target, staged, { recursive: true, filter: async source => {
    if ((await lstat(source)).isSymbolicLink()) throw new Error('美颜组件包含链接路径，已拒绝覆盖');
    return true;
  } });
  for (const file of files) {
    const path = join(staged, file.target);
    await mkdir(join(staged, file.target.startsWith('data/') ? 'data' : 'bin/64bit'), { recursive: true });
    await writeFile(path, file.bytes);
    if (digest(await readFile(path)) !== digest(file.bytes)) throw new Error('美颜组件校验失败，原来的组件没有改动');
  }
  await mkdir(join(parent, 'plugins'), { recursive: true });
  await checkpoint(transaction, 'pending');
  if (exists) {
    try { await rename(target, backup); }
    catch (error) { await checkpoint(transaction, 'settled'); throw new Error('美颜组件无法更新，原来的组件没有改动。请正常退出 OBS 后再安装', { cause: error }); }
  }
  try { await rename(staged, target); }
  catch (error) {
    if (exists) {
      try { await rename(backup, target); }
      catch (restoreError) { throw new AggregateError([error, restoreError], `美颜安装失败，恢复也没成功。原来的组件保留在 ${backup}，请保留这个文件夹并查看日志`); }
    }
    await checkpoint(transaction, 'settled');
    throw new Error('美颜安装失败，原来的组件已保留。请正常退出 OBS 后重新安装', { cause: error });
  }
  await checkpoint(transaction, 'settled');
  return '美颜组件已安装。请重启一次 OBS 来加载组件，再点“启动美颜”';
}
