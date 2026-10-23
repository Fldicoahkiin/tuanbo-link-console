import { mkdir, readFile, realpath, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyLinkProject } from '@tb/schema';
import {
  removeRundownItemCommand,
  synchronizeP1ProjectCommand,
  updateRundownItemCommand
} from '@tb/core/link';
import { allocateP1TimecodeRanges, configureP1AutoFollowCommand, nativeProgramSnapshot } from '@tb/core/link';
import { afterEach, describe, expect, it } from 'vitest';
import { hashFile, LinkProjectService } from './link-project-service';
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
  it('跨电脑复制 .hia 与歌曲文件夹后自动找回全部音频且保留原始时间码', async () => {
    const fixture = await createFixture();
    const oldPath = 'Z:/旧电脑/演出歌曲';
    const source = await readFile(fixture.p1Path, 'utf8');
    await writeFile(fixture.p1Path, source
      .replaceAll(fixture.audioPaths[0].replaceAll('\\', '/'), `${oldPath}/first.wav`)
      .replaceAll(fixture.audioPaths[1].replaceAll('\\', '/'), `${oldPath}/second.wav`)
      .replace('MidiStartTime="0"', 'MidiStartTime="60"')
      .replace('MidiStartTime="0"', 'MidiStartTime="120"'));
    const progress: Array<{ completed: number; total: number; song: string }> = [];
    const imported = await new P1ProjectService(new LinkProjectService()).importProject(fixture.p1Path, fixture.linkPath, {
      onProgress: update => progress.push({ completed: update.completed, total: update.total, song: update.song })
    });
    trackImportedAssets(fixture.directory, imported.items.map(item => item.referenceAudio.relativePath));
    expect(imported.items).toHaveLength(2);
    expect(imported.skippedItems).toEqual([]);
    expect(imported.items.map(item => item.p1Media.midiStartTime)).toEqual(['60', '120']);
    const synchronized = synchronizeP1ProjectCommand(imported, sequenceIds('first', 'second'), timestamp).execute(createEmptyLinkProject('原始 MTC 验收'));
    expect(synchronized.rundown.map(item => nativeProgramSnapshot(synchronized, item.id, 1, 250, 48000).snapshot.offsetMs)).toEqual([60000, 120000]);
    expect(imported.items.map(item => item.p1Media.sourceFileName)).toEqual(['first.wav', 'second.wav']);
    expect(progress).toEqual([
      { completed: 0, total: 2, song: '' },
      { completed: 1, total: 2, song: '第一首.wav' },
      { completed: 2, total: 2, song: '第二首.wav' }
    ]);
  });

  it('跨电脑歌曲文件同名且无法唯一定位时保留待修复项，不猜测音频', async () => {
    const fixture = await createFixture();
    const duplicateDirectory = join(fixture.directory, '另一份歌曲');
    await mkdir(duplicateDirectory);
    cleanupDirectories.push(duplicateDirectory);
    const duplicate = join(duplicateDirectory, 'first.wav');
    await writeFile(duplicate, Buffer.from('different-audio'));
    cleanupFiles.push(duplicate);
    const source = await readFile(fixture.p1Path, 'utf8');
    await writeFile(fixture.p1Path, source.replaceAll(fixture.audioPaths[0].replaceAll('\\', '/'), 'Z:/旧电脑/first.wav'));
    const imported = await new P1ProjectService(new LinkProjectService()).importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, imported.items.map(item => item.referenceAudio.relativePath));
    expect(imported.items.map(item => item.title)).toEqual(['第二首.wav']);
    expect(imported.skippedItems).toHaveLength(1);
    expect(imported.skippedItems?.[0]?.reason).toContain('多个同名文件');
  });

  it('.hia 里指向网络共享或设备路径的歌曲不直接访问；工程文件夹里没有同名文件就跳过', async () => {
    const fixture = await createFixture();
    const source = await readFile(fixture.p1Path, 'utf8');
    await writeFile(fixture.p1Path, source.replaceAll(fixture.audioPaths[0].replaceAll('\\', '/'), '//attacker/share/remote.wav'));
    const imported = await new P1ProjectService(new LinkProjectService()).importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, imported.items.map(item => item.referenceAudio.relativePath));
    expect(imported.items.map(item => item.title)).toEqual(['第二首.wav']);
    const reason = imported.skippedItems?.[0]?.reason ?? '';
    expect(reason).toContain('在网络路径上（//attacker/share/remote.wav）');
    expect(reason).toContain('.hia 所在文件夹里也没有同名文件');
    expect(reason).toContain('请把歌曲复制到本机');
    expect(reason).toContain('映射为盘符');
  });

  it('映射盘符上的歌照常导入：真实路径解析成它背后的网络共享也放行', async () => {
    const fixture = await createFixture();
    // Windows resolves a file on a mapped drive (Z:\...) to the share behind it (\\nas\share\...).
    const mapped = (path: string) => path === fixture.audioPaths[0] ? Promise.resolve('\\\\nas\\share\\first.wav') : realpath(path);
    const imported = await new P1ProjectService(new LinkProjectService(), mapped).importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, imported.items.map(item => item.referenceAudio.relativePath));
    expect(imported.skippedItems).toEqual([]);
    expect(imported.items.map(item => item.title)).toEqual(['第一首.wav', '第二首.wav']);
  });

  it('.hia 里的歌曲经链接指向非音视频文件时跳过，不读取链接目标', async (context) => {
    const fixture = await createFixture();
    const secret = join(fixture.directory, 'secret.txt'), link = join(fixture.directory, 'linked.wav');
    await writeFile(secret, 'not a song'); cleanupFiles.push(secret);
    try { await symlink(secret, link); }
    catch (error) { if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') context.skip(); throw error; }
    cleanupFiles.push(link);
    const source = await readFile(fixture.p1Path, 'utf8');
    await writeFile(fixture.p1Path, source.replaceAll(fixture.audioPaths[0].replaceAll('\\', '/'), link.replaceAll('\\', '/')));
    const imported = await new P1ProjectService(new LinkProjectService()).importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, imported.items.map(item => item.referenceAudio.relativePath));
    expect(imported.items.map(item => item.title)).toEqual(['第二首.wav']);
    expect(imported.skippedItems?.[0]?.reason).toContain('不是可导入的音视频文件');
  });

  it('.hia 文件夹里的链接指向网络共享时不跟随，先读链接目标再拒绝', async (context) => {
    const fixture = await createFixture();
    const link = join(fixture.directory, 'shared');
    try { await symlink('//attacker/share', link, 'dir'); }
    catch (error) { if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') context.skip(); throw error; }
    cleanupFiles.push(link);
    const source = await readFile(fixture.p1Path, 'utf8');
    await writeFile(fixture.p1Path, source.replaceAll(fixture.audioPaths[0].replaceAll('\\', '/'), `${link.replaceAll('\\', '/')}/remote.wav`));
    const imported = await new P1ProjectService(new LinkProjectService()).importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, imported.items.map(item => item.referenceAudio.relativePath));
    expect(imported.items.map(item => item.title)).toEqual(['第二首.wav']);
    expect(imported.skippedItems?.[0]?.reason).toContain('网络共享或设备路径');
  });

  it('链接后的位置不存在时按拒绝处理，不当作普通缺失文件', async (context) => {
    const fixture = await createFixture();
    const link = join(fixture.directory, 'moved');
    try { await symlink(join(fixture.directory, 'never-created'), link, 'dir'); }
    catch (error) { if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') context.skip(); throw error; }
    cleanupFiles.push(link);
    const source = await readFile(fixture.p1Path, 'utf8');
    await writeFile(fixture.p1Path, source.replaceAll(fixture.audioPaths[0].replaceAll('\\', '/'), `${link.replaceAll('\\', '/')}/remote.wav`));
    const imported = await new P1ProjectService(new LinkProjectService()).importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, imported.items.map(item => item.referenceAudio.relativePath));
    expect(imported.skippedItems?.[0]?.reason).toContain('链接指向不存在的位置');
  });

  it('歌曲导入取消后停止处理，工程文件保持原状', async () => {
    const fixture = await createFixture();
    const original = JSON.stringify(createEmptyLinkProject('未开始导入'));
    await writeFile(fixture.linkPath, original);
    cleanupFiles.push(fixture.linkPath);
    const controller = new AbortController();
    await expect(new P1ProjectService(new LinkProjectService()).importProject(fixture.p1Path, fixture.linkPath, {
      signal: controller.signal,
      onProgress: progress => { if (progress.completed === 0) controller.abort(); }
    })).rejects.toThrow();
    expect(await readFile(fixture.linkPath, 'utf8')).toBe(original);
  });

  it('坏裁剪跳过，好歌曲仍导入并保留时间码；保存重开再导出保留坏条目', async () => {
    const fixture = await createFixture();
    const source = await readFile(fixture.p1Path, 'utf8');
    await writeFile(fixture.p1Path, source.replace('cut_start="0"', 'cut_start="2"').replaceAll('MidiStartTime="0"', 'MidiStartTime="120"').replace(fixture.audioPaths[1].replaceAll('\\', '/'), fixture.audioPaths[0].replaceAll('\\', '/')));
    const service = new P1ProjectService(new LinkProjectService());
    const imported = await service.importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, imported.items.map(item => item.referenceAudio.relativePath));
    expect(imported.items.map(item => item.title)).toEqual(['第二首.wav']);
    expect(imported.skippedItems).toHaveLength(1);
    expect(imported.skippedItems?.[0]?.reason).toContain('可解码的音轨');
    const project = synchronizeP1ProjectCommand(imported, sequenceIds('good', 'unavailable'), timestamp).execute(createEmptyLinkProject('部分导入'));
    expect(project.rundown.find(item => item.referenceAudio)?.playback?.mtcOffsetMs).toBe(120000);
    expect(project.rundown).toHaveLength(2);
    expect(project.rundown[0]).toMatchObject({ title: '第一首.wav', enabled: false });
    expect((await service.previewExport(fixture.p1Path, fixture.linkPath, project)).removedCount).toBe(0);
    const projects = new LinkProjectService();
    await projects.save(fixture.linkPath, project); cleanupFiles.push(fixture.linkPath);
    const reopened = await projects.open(fixture.linkPath);
    expect(reopened.p1Sync?.skippedItems).toEqual(imported.skippedItems);
    const exported = await service.exportProject(fixture.p1Path, fixture.linkPath, reopened, imported.sourceSha256);
    cleanupFiles.push(exported.outputPath);
    const xml = await readFile(exported.outputPath, 'utf8');
    expect(xml).toContain('cut_start="2"'); expect(xml).toContain('第一首.wav'); expect(xml).toContain('第二首.wav');
    const reread = await service.importProject(exported.outputPath, fixture.linkPath);
    expect(reread.items[0]?.p1Media.sourceKey).toBe(exported.itemBindings[0]?.p1Media.sourceKey);
    expect(reread.skippedItems?.[0]?.sourceKey).toBe(exported.skippedItems?.[0]?.sourceKey);
  });
  it('实际裁剪音频并在导出和再次导入时保留起点、时长及时间码', async () => {
    const fixture = await createFixture();
    const rate = 48000;
    const wave = Buffer.alloc(44 + rate * 2 * 3);
    wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
    wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(rate, 24); wave.writeUInt32LE(rate * 2, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
    wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
    for (let frame = 0; frame < rate * 3; frame++) wave.writeInt16LE(frame < rate ? 0 : 10000, 44 + frame * 2);
    await writeFile(fixture.audioPaths[0], wave);
    const source = (await readFile(fixture.p1Path, 'utf8')).replace('cut_start="0" cut_end="1"', 'cut_start="1.25" cut_end="2.5"').replace('MidiStartTime="0"', 'MidiStartTime="120"');
    await writeFile(fixture.p1Path, source);
    const service = new P1ProjectService(new LinkProjectService());
    const imported = await service.importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, imported.items.map(item => item.referenceAudio.relativePath));
    const audio = imported.items[0]!.referenceAudio;
    expect(audio.durationMs).toBe(1250);
    const rendered = await readFile(join(fixture.directory, audio.relativePath));
    const data = rendered.indexOf(Buffer.from('data')) + 8;
    expect(rendered.length - data).toBe(rate * 4 * 1.25);
    expect(rendered.readInt16LE(data + 4800)).toBeGreaterThan(6000);
    const project = synchronizeP1ProjectCommand(imported, sequenceIds('a', 'b'), timestamp).execute(createEmptyLinkProject('裁剪验证'));
    expect(project.rundown[0]!.playback?.mtcOffsetMs).toBe(120000);
    const exported = await service.exportProject(fixture.p1Path, fixture.linkPath, project, imported.sourceSha256);
    cleanupFiles.push(exported.outputPath);
    const output = await readFile(exported.outputPath, 'utf8');
    expect(output).toContain('cut_start="1.25"'); expect(output).toContain('cut_end="2.5"');
    expect(output).toContain('MidiStartTime="120"');
    expect(await readFile(fixture.p1Path, 'utf8')).toBe(source);
    const reopened = await service.importProject(exported.outputPath, fixture.linkPath);
    expect(reopened.items[0]!.referenceAudio.sha256).toBe(audio.sha256);
    expect(reopened.items[0]!.referenceAudio.durationMs).toBe(1250);
    await writeFile(fixture.p1Path, source.replace('cut_end="2.5"', 'cut_end="4"'));
    const partial = await service.importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, partial.items.map(item => item.referenceAudio.relativePath));
    expect(partial.items).toHaveLength(2);
    expect(partial.items[0]?.referenceAudio.durationMs).toBe(3000);
    expect(partial.items[0]?.importNotes).toContain('完整原音频');
  });
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

  it('缺失源音频只跳过该条目，不生成伪素材', async () => {
    const fixture = await createFixture();
    await unlink(fixture.audioPaths[1]);
    const cleanupIndex = cleanupFiles.indexOf(fixture.audioPaths[1]);
    if (cleanupIndex < 0) throw new Error('测试清理列表缺少第二首音频');
    cleanupFiles.splice(cleanupIndex, 1);
    const imported = await new P1ProjectService(new LinkProjectService()).importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, imported.items.map(item => item.referenceAudio.relativePath));
    expect(imported.items).toHaveLength(1); expect(imported.skippedItems).toHaveLength(1);
  });

  it('零时长从原音频恢复，缺失歌曲保留原顺序，补文件后原位恢复不重复', async () => {
    const fixture = await createFixture();
    const wav = Buffer.alloc(44 + 2 * 192000);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    await writeFile(fixture.audioPaths[0], wav); await unlink(fixture.audioPaths[1]);
    await writeFile(fixture.p1Path, (await readFile(fixture.p1Path, 'utf8')).replace('cut_end="1"', 'cut_end="0"').replaceAll('MidiStartTime="0"', 'MidiStartTime="120"'));
    const service = new P1ProjectService(new LinkProjectService());
    const imported = await service.importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, imported.items.map(item => item.referenceAudio.relativePath));
    let project = synchronizeP1ProjectCommand(imported, sequenceIds('first', 'second')).execute(createEmptyLinkProject('全部保留'));
    expect(project.rundown.map(item => item.id)).toEqual(['first', 'second']);
    expect(project.rundown[0]?.referenceAudio?.durationMs).toBe(2000);
    expect(project.rundown[0]?.notes).toContain('完整原音频');
    expect(project.rundown[0]?.playback?.mtcOffsetMs).toBe(120000);
    expect(project.rundown[1]?.enabled).toBe(false);
    project = synchronizeP1ProjectCommand(imported).execute(project);
    expect(project.rundown.map(item => item.id)).toEqual(['first', 'second']);
    const exported = await service.exportProject(fixture.p1Path, fixture.linkPath, project, imported.sourceSha256);
    cleanupFiles.push(exported.outputPath);
    expect(await readFile(exported.outputPath, 'utf8')).toContain('cut_end="2"');
    expect(await readFile(exported.outputPath, 'utf8')).toContain('第二首.wav');
    await writeFile(fixture.audioPaths[1], wav);
    const recovered = await service.importProject(fixture.p1Path, fixture.linkPath);
    trackImportedAssets(fixture.directory, recovered.items.map(item => item.referenceAudio.relativePath));
    project = synchronizeP1ProjectCommand(recovered).execute(project);
    expect(project.rundown.map(item => item.id)).toEqual(['first', 'second']);
    expect(project.rundown.every(item => item.enabled && item.referenceAudio)).toBe(true);
    expect(project.rundown[1]?.p1UnavailableSourceKey).toBeUndefined();
  });

  it('P1 将带音轨 MP4 标记为视频节目时仍提取音轨并保留原始 P1 路径', async () => {
    const fixture = await createContainerFixture();
    const projectService = new LinkProjectService(async (_sourcePath, destinationPath) => {
      const wav = Buffer.alloc(44 + 3 * 192000);
      wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
      wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
      wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
      await writeFile(destinationPath, wav);
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
    await writeFile(fixture.p1Path, (await readFile(fixture.p1Path, 'utf8')).replace('cut_end="3"', 'cut_end="45"'));
    const recovered = await service.importProject(fixture.p1Path, fixture.linkPath);
    expect(recovered.items[0]?.referenceAudio.durationMs).toBe(3000);
    expect(recovered.items[0]?.importNotes).toContain('完整原音频');
    cleanupFiles.push(join(fixture.directory, 'cache', 'reference-audio', `${await hashFile(fixture.mediaPath)}.json`));
    cleanupDirectories.push(join(fixture.directory, 'cache', 'reference-audio'), join(fixture.directory, 'cache'));
  });

  it('MP4 没有可解码音轨时仍保留待修复节目', async () => {
    const fixture = await createContainerFixture();
    const projectService = new LinkProjectService(() => Promise.reject(
      new Error('Output file does not contain any stream')
    ));
    const imported = await new P1ProjectService(projectService).importProject(fixture.p1Path, fixture.linkPath);
    expect(imported.items).toHaveLength(0); expect(imported.skippedItems).toHaveLength(1);
    const project = synchronizeP1ProjectCommand(imported, sequenceIds('pending')).execute(createEmptyLinkProject('保留歌曲'));
    expect(project.rundown).toHaveLength(1);
    expect(project.rundown[0]).toMatchObject({ id: 'pending', title: 'MP4 音频', enabled: false });
    expect(project.rundown[0]?.referenceAudio).toBeUndefined();
    expect(project.rundown[0]?.notes).toContain('没有可解码的音轨');
    expect(synchronizeP1ProjectCommand(imported).execute(project).rundown).toHaveLength(1);
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
