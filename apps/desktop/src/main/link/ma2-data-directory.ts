import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomically } from './atomic-file';

const recordSchema = z.object({ version: z.literal(1), directory: z.string().min(1).max(4096) }).strict();

/**
 * The local onPC data directory the plugin exchange writes into. Only the main
 * process sets it, from the operator's folder dialog or the detection of the
 * running onPC; the window may only name this directory.
 */
export class Ma2DataDirectory {
  private recorded: string | null | undefined;

  constructor(private readonly file: string) {}

  async current(): Promise<string | null> {
    if (this.recorded !== undefined) return this.recorded;
    let content: string;
    try {
      content = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return this.recorded = null;
      throw error;
    }
    try {
      this.recorded = recordSchema.parse(JSON.parse(content)).directory;
    } catch (error) {
      throw new Error(`MA2 数据目录记录损坏：${this.file}`, { cause: error });
    }
    return this.recorded;
  }

  async choose(directory: string): Promise<string> {
    await writeFileAtomically(this.file, `${JSON.stringify({ version: 1, directory })}\n`);
    this.recorded = directory;
    return directory;
  }

  /** Any spelling of the recorded directory, compared by real path. */
  async require(directory: string): Promise<void> {
    const chosen = await this.current();
    const refusal = new Error(`本机 onPC 数据目录必须通过“选择”或“一键识别”设置，已拒绝：${directory}`);
    if (chosen === null) throw refusal;
    const [recorded, named] = await Promise.all([realpath(chosen), realpath(directory)]);
    if (pathKey(recorded) !== pathKey(named)) throw refusal;
  }
}

/** The data directory under `root` (ProgramData\MA Lighting Technologies\grandma) of the running
 * onPC version, or the only one there when the version is unknown; it must hold the plugin folders. */
export async function detectMa2DataDirectory(root: string, version: string | null): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^gma2_V_\d+\.\d+(\.\d+)?$/i.test(entry.name)).map(entry => entry.name);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error(`没有找到 MA2 onPC 数据目录（${root}），请点“选择”手动指定`, { cause: error });
    throw error;
  }
  const running = version ? /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version) : null;
  const matching = running ? names.filter(name => {
    const [major, minor, patch] = name.slice('gma2_V_'.length).split('.').map(Number);
    return major === Number(running[1]) && minor === Number(running[2]) && (patch ?? 0) === Number(running[3] ?? 0);
  }) : names;
  const usable: string[] = [];
  for (const name of matching) if (await holdsPluginFolders(join(root, name))) usable.push(join(root, name));
  if (usable.length !== 1) {
    throw new Error(running
      ? `没有找到与正在运行的 onPC ${running.slice(1).filter(Boolean).join('.')} 对应的数据目录，请点“选择”手动指定`
      : '无法确定使用哪个 MA2 onPC 数据目录，请先运行 onPC 或点“选择”手动指定');
  }
  return usable[0]!;
}

async function holdsPluginFolders(directory: string): Promise<boolean> {
  for (const part of ['temp', 'plugins', 'importexport']) {
    try { if (!(await stat(join(directory, part))).isDirectory()) return false; }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
  }
  return true;
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}
