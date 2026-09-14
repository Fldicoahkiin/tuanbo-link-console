import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** OBS's documented system-wide plugin directory; only our own DLL is touched. */
export async function installObsLiveBridge(source: string): Promise<void> {
  if (process.platform !== 'win32' || !process.env.ProgramData) throw new Error('OBS 原生实时预览目前仅支持 Windows');
  const root = join(process.env.ProgramData, 'obs-studio', 'plugins', 'tblink-realtime-preview');
  const directory = join(root, 'bin', '64bit');
  const target = join(directory, 'tblink-realtime-preview.dll');
  const binary = await readFile(source);
  const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
  try { if (hash(await readFile(target)) === hash(binary)) return; }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  await mkdir(directory, { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  try { await writeFile(target, binary); }
  catch (error) { throw new Error(`无法安装 OBS 实时预览插件，请先退出 OBS 后再连接：${String(error)}`); }
}
