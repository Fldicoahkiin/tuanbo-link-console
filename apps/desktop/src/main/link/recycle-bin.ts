import { randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, parse, win32 } from 'node:path';

/**
 * Moving to the Recycle Bin through `trash` (shell.trashItem). Outside a desktop session (SSH, a service)
 * Windows deletes the item for good and still reports success (checked on the dev PC on 2026-10-24), so on
 * Windows the first move on each drive is preceded by `recycles`: unless the bin takes items in this session,
 * every move refuses and leaves the item in place; the caller logs it and tries again at the next start.
 * Where the bin itself refuses an item (a network path), that error comes through unchanged.
 */
export function recycleBin(trash: (path: string) => Promise<void>,
  options: { platform?: NodeJS.Platform; recycles?: (directory: string) => Promise<boolean> } = {}): (path: string) => Promise<void> {
  const platform = options.platform ?? process.platform;
  const recycles = options.recycles ?? (directory => recyclesHere(directory, trash));
  const checked = new Map<string, Promise<boolean>>();
  return async path => {
    if (platform === 'win32') {
      const drive = win32.parse(path).root.toLowerCase();
      let check = checked.get(drive);
      if (!check) { check = recycles(win32.dirname(path)); checked.set(drive, check); }
      if (!(await check)) throw new Error(`回收站在当前会话不可用，未删除：${path}（不在 Windows 桌面会话里时，系统会直接永久删除）`);
    }
    await trash(path);
  };
}

/** Moves an empty throwaway file from `directory` to the bin and looks for its record there. If the bin
 * does not take it, Windows deleted it for good, which costs only that empty file. */
async function recyclesHere(directory: string, trash: (path: string) => Promise<void>): Promise<boolean> {
  const name = `.tblink-recycle-check-${randomUUID()}.tmp`;
  await writeFile(join(directory, name), '', { flag: 'wx' });
  await trash(join(directory, name));
  const bin = join(parse(directory).root, '$Recycle.Bin');
  for (const user of await readdir(bin)) {
    let records: string[];
    try { records = (await readdir(join(bin, user))).filter(record => record.startsWith('$I') && record.endsWith('.tmp')); }
    catch (error) {
      // Other users' bins are not readable.
      if (error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTDIR')) continue;
      throw error;
    }
    for (const record of records) if ((await readFile(join(bin, user, record))).toString('utf16le').includes(name)) return true;
  }
  return false;
}
