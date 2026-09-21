import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const electronRequire = createRequire(require.resolve('electron/package.json'));
const extract = electronRequire('extract-zip') as (file: string, options: { dir: string }) => Promise<void>;

function archive(entries: { name: string; data: string; link?: boolean }[]): Buffer {
  const files: Buffer[] = []; const directory: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const data = Buffer.from(entry.data);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    files.push(local, name, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.link ? 0o120777 : 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    directory.push(central, name); offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(directory); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, central, end]);
}

it('Windows 发布 ZIP 的普通文件可解压，重复普通文件仍可覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tblink-zip-'));
  const zip = join(root, 'regular.zip'); const dir = join(root, 'out');
  await writeFile(zip, archive([{ name: 'resources/app.txt', data: 'first' }, { name: 'resources/app.txt', data: 'final' }]));
  await extract(zip, { dir });
  expect(await readFile(join(dir, 'resources/app.txt'), 'utf8')).toBe('final');
});

it.each([false, true])('拒绝越界符号链接及同名覆盖链（追加普通文件：%s）', async (duplicate) => {
  const root = await mkdtemp(join(tmpdir(), 'tblink-zip-'));
  const outside = join(root, 'outside.txt'); const zip = join(root, 'attack.zip'); const dir = join(root, 'out');
  await writeFile(outside, 'untouched');
  await writeFile(zip, archive([{ name: 'escape', data: '../outside.txt', link: true }, ...(duplicate ? [{ name: 'escape', data: 'overwritten' }] : [])]));
  await expect(extract(zip, { dir })).rejects.toThrow('ZIP extraction refuses symbolic links');
  expect(await readFile(outside, 'utf8')).toBe('untouched');
  expect(existsSync(join(dir, 'escape'))).toBe(false);
});

it('拒绝目标目录内预先存在的目录链接，不能在外部创建子目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tblink-zip-'));
  const outside = join(root, 'outside'); const dir = join(root, 'out'); const zip = join(root, 'parent.zip');
  await mkdir(outside); await mkdir(dir); await symlink(outside, join(dir, 'linked'), 'junction');
  await writeFile(zip, archive([{ name: 'linked/new/file.txt', data: 'outside write' }]));
  await expect(extract(zip, { dir })).rejects.toThrow('ZIP extraction refuses symbolic links');
  expect(existsSync(join(outside, 'new'))).toBe(false);
});
