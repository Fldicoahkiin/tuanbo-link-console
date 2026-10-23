import { mkdir, readFile, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectAccess } from './project-access';

const cleanupFiles: string[] = [];
const cleanupLinks: string[] = [];
const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const path of cleanupFiles.splice(0).reverse()) await unlink(path).catch(ignoreMissing);
  for (const link of cleanupLinks.splice(0).reverse()) await (process.platform === 'win32' ? rmdir(link) : unlink(link)).catch(ignoreMissing);
  for (const directory of cleanupDirectories.splice(0).reverse()) await rmdir(directory).catch(ignoreMissing);
});

describe('ProjectAccess', () => {
  it('窗口只能显示主进程批准过的工程，工程内请求只能指向当前显示的工程', async () => {
    const access = new ProjectAccess(await recordPath());
    const opened = join(await folder(), 'show.tblink'); const elsewhere = join(await folder(), 'other.tblink');
    await expect(access.show(opened)).rejects.toThrow('未经本软件');
    expect(() => access.requireShown(opened)).toThrow('当前打开的工程');
    access.approve(opened); access.approve(elsewhere);
    await access.show(opened);
    access.requireShown(opened);
    expect(() => access.requireShown(elsewhere)).toThrow('当前打开的工程');
    await access.show(null);
    expect(() => access.requireShown(opened)).toThrow('当前打开的工程');
    const never = join(await folder(), 'never.tblink');
    expect(() => access.requireApproved(never)).toThrow('未经本软件');
    access.requireApproved(elsewhere);
  });

  it('主进程记录上次显示的工程；读回时批准它，记录损坏明确报错', async () => {
    const record = await recordPath();
    const opened = join(await folder(), 'show.tblink');
    const first = new ProjectAccess(record);
    expect(await first.lastProject()).toBeNull();
    first.approve(opened); await first.show(opened);
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({ version: 1, projectPath: opened });
    const next = new ProjectAccess(record);
    expect(() => next.requireApproved(opened)).toThrow('未经本软件');
    expect(await next.lastProject()).toBe(opened);
    next.requireApproved(opened);
    await writeFile(record, 'not json');
    await expect(new ProjectAccess(record).lastProject()).rejects.toThrow('上次工程记录损坏');
    await writeFile(record, JSON.stringify({ version: 1, projectPath: '' }));
    await expect(new ProjectAccess(record).lastProject()).rejects.toThrow('上次工程记录损坏');
  });

  it('工程内素材路径统一校验：当前工程、素材子目录与扩展名、工程目录内、真实路径不越界；一个不符合就整批拒绝', async () => {
    const project = await folder(); const outside = await folder(); const projectPath = join(project, 'show.tblink');
    const access = new ProjectAccess(await recordPath());
    access.approve(projectPath); await access.show(projectPath);
    expect(await access.assetFiles(projectPath, ['assets/reference-audio/a.wav', 'assets/reference-media/b.png']))
      .toEqual([join(project, 'assets', 'reference-audio', 'a.wav'), join(project, 'assets', 'reference-media', 'b.png')]);
    for (const relativePath of ['song.wav', '../song.wav', 'assets/reference-audio/../../song.wav', 'assets/reference-audio/notes.txt', 'assets/cache/a.wav']) {
      await expect(access.assetFiles(projectPath, ['assets/reference-audio/a.wav', relativePath])).rejects.toThrow('只能使用');
    }
    await expect(access.assetFiles(join(outside, 'show.tblink'), ['assets/reference-audio/a.wav'])).rejects.toThrow('当前打开的工程');
    await symlink(outside, join(project, 'assets'), 'junction'); cleanupLinks.push(join(project, 'assets'));
    await expect(access.assetFiles(projectPath, ['assets/reference-audio/a.wav'])).rejects.toThrow('符号链接');
  });
});

/** Where a test's last-project record goes; removed after the test. */
async function recordPath(): Promise<string> {
  const path = join(await folder(), 'last-project.json');
  cleanupFiles.push(path);
  return path;
}

async function folder(): Promise<string> {
  const directory = join(tmpdir(), `tblink-access-${crypto.randomUUID()}`);
  await mkdir(directory); cleanupDirectories.push(directory);
  return directory;
}

function ignoreMissing(error: unknown): void {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
  throw error;
}
