import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { obsPluginFingerprint } from './obs-plugin-fingerprint';

export class ObsPluginInstallError extends Error {
  constructor(readonly code: 'blocked' | 'permission', cause: unknown) {
    super(code === 'blocked' ? 'OBS 组件文件正在使用，原插件已保留。请点击“检查并修复组件”完成升级。' : '安装 OBS 组件需要 Windows 授权，请点击“检查并修复组件”。', { cause });
  }
}

/** OBS's documented system-wide plugin directory; only our own DLL is touched. */
export async function installObsLiveBridge(source: string, elevate?: (source: string, sha256: string) => Promise<void>): Promise<'installed' | 'unchanged'> {
  if (process.platform !== 'win32' || !process.env.ProgramData) throw new Error('OBS 原生实时预览目前仅支持 Windows');
  const root = join(process.env.ProgramData, 'obs-studio', 'plugins', 'tblink-realtime-preview');
  const directory = join(root, 'bin', '64bit');
  const target = join(directory, 'tblink-realtime-preview.dll');
  const binary = await readFile(source);
  const fingerprint = obsPluginFingerprint(binary);
  let installed: Buffer | null = null;
  try { installed = await readFile(target); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      if (elevate && error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')) {
        await elevate(source, createHash('sha256').update(binary).digest('hex'));
        if (obsPluginFingerprint(await readFile(target)) !== fingerprint) throw new Error('Windows 授权后 OBS 组件校验失败');
        return 'installed';
      }
      throw error;
    }
  }
  if (installed) {
    let installedFingerprint: string | null = null;
    try { installedFingerprint = obsPluginFingerprint(installed); }
    catch (error) { console.warn('OBS 内置组件已损坏，将用随软件携带的组件修复：', error); }
    if (installedFingerprint === fingerprint) return 'unchanged';
  }
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  let staged = false;
  try {
    await mkdir(directory, { recursive: true });
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(temporary, binary, { flag: 'wx' });
    staged = true;
    await rename(temporary, target);
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'EBUSY') throw new ObsPluginInstallError('blocked', error);
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        if (!elevate) throw new ObsPluginInstallError('permission', error);
        await elevate(source, createHash('sha256').update(binary).digest('hex'));
        if (obsPluginFingerprint(await readFile(target)) !== fingerprint) throw new Error('Windows 授权后 OBS 组件校验失败，请重新安装联动台');
        return 'installed';
      }
    }
    throw new Error(`无法安装 OBS 实时预览插件：${String(error)}`, { cause: error });
  } finally {
    if (staged) {
      try { await unlink(temporary); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
  }
  return 'installed';
}
