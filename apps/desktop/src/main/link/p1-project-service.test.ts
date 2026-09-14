import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyLinkProject } from '@tb/schema';
import {
  removeRundownItemCommand,
  synchronizeP1ProjectCommand,
  updateRundownItemCommand
} from '@tb/core/link';
import { allocateP1TimecodeRanges, configureP1AutoFollowCommand } from '@tb/core/link';
import { afterEach, describe, expect, it } from 'vitest';
import { LinkProjectService } from './link-project-service';
import { P1ProjectService } from './p1-project-service';

const cleanupFiles: string[] = [];
const cleanupDirectories: string[] = [];
const timestamp = () => '2026-08-26T00:00:00.000Z';

afterEach(async () => {
  for (const filePath of cleanupFiles.splice(0).reverse()) await unlink(filePath).catch(ignoreMissing);
  for (const directory of cleanupDirectories.splice(0).sort((left, right) => right.length - left.length)) {
    await rmdir(directory).catch(ignoreMissing);
  }
});

describe('P1ProjectService', () => {
  it('自动联动工程写入独立起点且不覆盖原 P1 文件', async () => {
    const fixture = await createFixture();
    const service = new P1ProjectService(new LinkProjectService());
    const original = await readFile(fixture.p1Path);
    const imported = await service.importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, imported.items.map((item) => item.referenceAudio.relativePath));
    let project = synchronizeP1ProjectCommand(imported, sequenceIds('a', 'b'), timestamp).execute(createEmptyLinkProject('自动联动'));
    project = configureP1AutoFollowCommand(allocateP1TimecodeRanges(project)).execute(project);
    const output = await service.exportProject(fixture.p1Path, fixture.linkPath, project, imported.sourceSha256);
    cleanupFiles.push(output.outputPath);
    expect(output.itemBindings.map((item) => item.p1Media.midiStartTime)).toEqual(['60', '71']);
    const xml = await readFile(output.outputPath, 'utf8');
    expect(xml).toContain('MidiStartTime="60"'); expect(xml).toContain('MidiStartTime="71"');
    expect(await readFile(fixture.p1Path)).toEqual(original);
  });
  it('读取全部 P1 音频并把节目顺序和名称原子写回独立 .hia', async () => {
    const fixture = await createFixture();
    const projectService = new LinkProjectService();
    const service = new P1ProjectService(projectService);
    const imported = await service.importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, imported.items.map((item) => item.referenceAudio.relativePath));

    expect(imported.playlists).toEqual([{ id: 'p1-playlist-1', name: '演出歌单', sourceIndex: 0 }]);
    expect(imported.items.map((item) => item.title)).toEqual(['第一首.wav', '第二首.wav']);
    expect(imported.items.map((item) => item.referenceAudio.durationMs)).toEqual([1_000, 2_000]);

    let project = synchronizeP1ProjectCommand(imported, sequenceIds('item-a', 'item-b'), timestamp)
      .execute(createEmptyLinkProject('联动工程'));
    project = updateRundownItemCommand('item-a', {
      title: '第一首（联动台编排）',
      enabled: true,
      notes: '保留现场 Cue'
    }, timestamp).execute(project);
    project = removeRundownItemCommand('item-b', timestamp).execute(project);

    const preview = await service.previewExport(fixture.p1Path, fixture.linkPath, project);
    expect(preview).toMatchObject({ addedCount: 0, updatedCount: 1, removedCount: 1, ignoredCount: 0 });
    const exported = await service.exportProject(fixture.p1Path, fixture.linkPath, project, preview.sourceSha256);
    cleanupFiles.push(exported.outputPath);
    const output = await readFile(exported.outputPath, 'utf8');
    expect(output).toContain('audio_caption_="第一首（联动台编排）"');
    expect(output).not.toContain('第二首.wav');

    const reopened = await service.importProject(exported.outputPath, fixture.linkPath);
    expect(reopened.items.map((item) => item.title)).toEqual(['第一首（联动台编排）']);
    expect(exported.itemBindings).toHaveLength(1);
  });

  it('P1 源工程在导入后变化时拒绝写回', async () => {
    const fixture = await createFixture();
    const projectService = new LinkProjectService();
    const service = new P1ProjectService(projectService);
    const imported = await service.importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, imported.items.map((item) => item.referenceAudio.relativePath));
    const project = synchronizeP1ProjectCommand(imported, sequenceIds('item-a', 'item-b'), timestamp)
      .execute(createEmptyLinkProject('联动工程'));

    await writeFile(fixture.p1Path, `${await readFile(fixture.p1Path, 'utf8')}\n`, 'utf8');
    await expect(service.previewExport(fixture.p1Path, fixture.linkPath, project)).rejects.toThrow('上次导入后已变化');
  });

  it('缺失源音频时整次读取失败，不生成伪素材', async () => {
    const fixture = await createFixture();
    await unlink(fixture.audioPaths[1]);
    const cleanupIndex = cleanupFiles.indexOf(fixture.audioPaths[1]);
    if (cleanupIndex < 0) throw new Error('测试清理列表缺少第二首音频');
    cleanupFiles.splice(cleanupIndex, 1);
    await expect(new P1ProjectService(new LinkProjectService()).importProject(fixture.p1Path, fixture.linkPath))
      .rejects.toThrow();
  });

  it('P1 将带音轨 MP4 标记为视频节目时仍提取音轨并保留原始 P1 路径', async () => {
    const fixture = await createContainerFixture();
    const projectService = new LinkProjectService(async (_sourcePath, destinationPath) => {
      await writeFile(destinationPath, Buffer.from('decoded-pcm-audio'));
    });
    const service = new P1ProjectService(projectService);
    const imported = await service.importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, imported.items.map((item) => item.referenceAudio.relativePath));

    expect(imported.items).toHaveLength(1);
    expect(imported.items[0]?.referenceAudio.relativePath).toMatch(/^assets\/reference-audio\/[a-f0-9]{64}\.wav$/);
    expect(imported.items[0]?.p1Media.sourceFileName).toBe('track.mp4');

    const project = synchronizeP1ProjectCommand(imported, sequenceIds('item-mp4'), timestamp)
      .execute(createEmptyLinkProject('联动工程'));
    const preview = await service.previewExport(fixture.p1Path, fixture.linkPath, project);
    const exported = await service.exportProject(fixture.p1Path, fixture.linkPath, project, preview.sourceSha256);
    cleanupFiles.push(exported.outputPath);
    const output = await readFile(exported.outputPath, 'utf8');
    expect(output).toContain(fixture.mediaPath.replaceAll('\\', '/'));
  });

  it('MP4 没有可解码音轨时明确阻断整次 P1 导入', async () => {
    const fixture = await createContainerFixture();
    const projectService = new LinkProjectService(() => Promise.reject(
      new Error('Output file does not contain any stream')
    ));
    await expect(new P1ProjectService(projectService).importProject(fixture.p1Path, fixture.linkPath))
      .rejects.toThrow('素材没有可解码的音轨');
  });
});

async function createFixture(): Promise<{
  directory: string;
  p1Path: string;
  linkPath: string;
  audioPaths: [string, string];
}> {
  const directory = join(tmpdir(), `tblink-p1-${crypto.randomUUID()}`);
  await mkdir(directory);
  cleanupDirectories.push(directory);
  const audioDirectory = join(directory, 'audio');
  await mkdir(audioDirectory);
  cleanupDirectories.push(audioDirectory);
  const first = join(audioDirectory, 'first.wav');
  const second = join(audioDirectory, 'second.wav');
  await writeFile(first, Buffer.from('first-audio'));
  await writeFile(second, Buffer.from('second-audio'));
  cleanupFiles.push(first, second);
  const p1Path = join(directory, 'show.hia');
  const linkPath = join(directory, 'show.tblink');
  await writeFile(p1Path, p1Xml(first, second), 'utf8');
  cleanupFiles.push(p1Path);
  return { directory, p1Path, linkPath, audioPaths: [first, second] };
}

function p1Xml(first: string, second: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<playerRoot>
  <PlayerOptions Voice="100" AudioVoice="100" AudioMode="0"/>
  <audioPlayList CurrentList="0"><audioPlayElement caption="演出歌单" type="0"/></audioPlayList>
  <videoPlayList CurrentList="0">
    <videoPlayElement caption="演出歌单" type="0">
      ${mediaXml(first, '第一首.wav', 1, 0)}
      ${mediaXml(second, '第二首.wav', 2, 2)}
    </videoPlayElement>
  </videoPlayList>
</playerRoot>
`;
}

async function createContainerFixture(): Promise<{
  directory: string;
  p1Path: string;
  linkPath: string;
  mediaPath: string;
}> {
  const directory = join(tmpdir(), `tblink-p1-mp4-${crypto.randomUUID()}`);
  await mkdir(directory);
  cleanupDirectories.push(directory);
  cleanupDirectories.push(join(directory, 'assets', 'reference-audio'), join(directory, 'assets'));
  const mediaPath = join(directory, 'track.mp4');
  await writeFile(mediaPath, Buffer.from('mp4-container'));
  cleanupFiles.push(mediaPath);
  const p1Path = join(directory, 'show.hia');
  const linkPath = join(directory, 'show.tblink');
  await writeFile(p1Path, `<?xml version="1.0" encoding="UTF-8"?>
<playerRoot>
  <videoPlayList CurrentList="0">
    <videoPlayElement caption="MP4 音频歌单" type="0">
      ${mediaXml(mediaPath, 'MP4 音频', 3, 2, 1)}
    </videoPlayElement>
  </videoPlayList>
</playerRoot>
`, 'utf8');
  cleanupFiles.push(p1Path);
  return { directory, p1Path, linkPath, mediaPath };
}

function mediaXml(path: string, title: string, durationSeconds: number, playEndAction: number, mediaType = 4): string {
  return `<media mediaType="${mediaType}" resourceFilePath="${path.replaceAll('\\', '/')}" playEndAction="${playEndAction}" cut_start="0" cut_end="${durationSeconds}" volume="100" mute="0" shortcut="" MidiStartTime="0" audio_caption_="${title}"/>`;
}

function trackImportedAssets(directory: string, relativePaths: string[]): void {
  for (const relativePath of new Set(relativePaths)) cleanupFiles.push(join(directory, ...relativePath.split('/')));
  const referenceDirectory = join(directory, 'assets', 'reference-audio');
  const assetsDirectory = join(directory, 'assets');
  if (!cleanupDirectories.includes(referenceDirectory)) cleanupDirectories.push(referenceDirectory);
  if (!cleanupDirectories.includes(assetsDirectory)) cleanupDirectories.push(assetsDirectory);
}

function sequenceIds(...ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index];
    if (!id) throw new Error('测试 ID 已耗尽');
    index += 1;
    return id;
  };
}

function ignoreMissing(error: unknown): void {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
  throw error;
}
