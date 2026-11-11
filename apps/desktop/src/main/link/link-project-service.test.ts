import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rmdir, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { createEmptyLinkProject, createLightingUserLibrary, serializeLinkProject, type LinkProject } from '@tb/schema';
import { editReferenceAudioCommand } from '@tb/core/link';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkProjectService } from './link-project-service';
import { WaveformService } from './waveform-service';
import { decodedWaveform, loudest } from './fixtures/decoded-waveform';

const cleanupFiles: string[] = [];
const cleanupDirectories: string[] = [];
const cleanupLinks: string[] = [];

afterEach(async () => {
  for (const filePath of cleanupFiles.splice(0).reverse()) await unlink(filePath).catch(ignoreMissing);
  // Windows removes a directory junction with rmdir; POSIX removes a symbolic link with unlink.
  for (const link of cleanupLinks.splice(0).reverse()) await (process.platform === 'win32' ? rmdir(link) : unlink(link)).catch(ignoreMissing);
  for (const directory of cleanupDirectories.splice(0).reverse()) await rmdir(directory).catch(ignoreMissing);
});

describe('LinkProjectService', () => {
  it('同一工程读取等待在途原子保存，不与 Windows 替换同时打开目标文件', async () => {
    const directory=await createTestDirectory();const path=join(directory,'queued-read.tblink');cleanupFiles.push(path);
    const original=createEmptyLinkProject('旧');await writeFile(path,JSON.stringify(original));
    let release:()=>void=()=>{throw new Error('测试写入尚未开始');};const gate=new Promise<void>(resolve=>{release=resolve;});
    const service=new LinkProjectService(undefined,async (target,content)=>{await gate;await writeFile(target,content);});
    const saving=service.save(path,{...original,name:'新'});let readFinished=false;
    const reading=service.open(path).then(value=>{readFinished=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,20));expect(readFinished).toBe(false);
    release();await saving;expect((await reading).name).toBe('新');
  });
  it('首次升级分类格式先保留原工程备份；后续保存不覆盖旧备份', async () => {
    const directory=await createTestDirectory(); const path=join(directory,'music.tblink');const backup=`${path}.before-lighting-library.bak`;cleanupFiles.push(path,backup,`${path}.before-ma2-workflow.bak`);
    const original=createEmptyLinkProject('旧工程');await writeFile(path,JSON.stringify(original));
    const next={...original,schemaVersion:2 as const,ma2MaterialLibrary:{version:2 as const,source:'local',userLibrary:createLightingUserLibrary()}};
    const service=new LinkProjectService();await service.save(path,next);
    expect(JSON.parse(await readFile(backup,'utf8'))).toEqual(original);
    await service.save(path,{...next,name:'新名字'});expect(JSON.parse(await readFile(backup,'utf8'))).toEqual(original);
  });
  it('打开时报告内容是否与文件不同：本程序保存的文件不算升级，缺少新字段的旧文件算升级且不写回', async () => {
    const directory=await createTestDirectory();const current=join(directory,'current.tblink');const legacy=join(directory,'legacy.tblink');cleanupFiles.push(current,legacy);
    const project=createEmptyLinkProject('当前格式');await writeFile(current,serializeLinkProject(project));
    const service=new LinkProjectService();
    expect(await service.openDocument(current)).toEqual({project,upgraded:false});
    const old:Record<string,unknown>={...project,name:'旧格式'};delete old['mediaFolders'];const oldText=JSON.stringify(old);await writeFile(legacy,oldText);
    const opened=await service.openDocument(legacy);
    expect(opened.upgraded).toBe(true);expect(opened.project.mediaFolders).toEqual([]);
    expect(await readFile(legacy,'utf8')).toBe(oldText);
  });
  it('升级后第一次保存先在原位置保留原文件 .bak；普通保存不留备份', async () => {
    const directory=await createTestDirectory();const path=join(directory,'upgrade.tblink');cleanupFiles.push(path);
    const original=JSON.stringify({...createEmptyLinkProject('原文件'),mediaFolders:undefined});await writeFile(path,original);
    const service=new LinkProjectService();
    await service.save(path,createEmptyLinkProject('保存一'));
    expect((await readdir(directory)).filter(name=>name.endsWith('.bak'))).toEqual([]);
    await writeFile(path,original);
    await service.save(path,createEmptyLinkProject('升级保存'),{ backupOriginal: true });
    const backups=(await readdir(directory)).filter(name=>name.startsWith('upgrade.tblink.')&&name.endsWith('.before-upgrade.bak'));cleanupFiles.push(...backups.map(name=>join(directory,name)));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(directory,backups[0]!),'utf8')).toBe(original);
    expect(JSON.parse(await readFile(path,'utf8'))).toMatchObject({name:'升级保存'});
  });
  it('副本写入不创建升级备份，也不改动同目录的工程文件', async () => {
    const directory=await createTestDirectory();const copy=join(directory,'copy.tblink');cleanupFiles.push(copy);
    const project={...createEmptyLinkProject('副本'),schemaVersion:2 as const,ma2MaterialLibrary:{version:2 as const,source:'local',userLibrary:createLightingUserLibrary()}};
    await writeFile(copy,JSON.stringify(createEmptyLinkProject('旧副本')));
    await new LinkProjectService().writeCopy(copy,project);
    expect(JSON.parse(await readFile(copy,'utf8'))).toMatchObject({name:'副本'});
    await expect(readFile(`${copy}.before-lighting-library.bak`,'utf8')).rejects.toThrow();
    await expect(new LinkProjectService().writeCopy(join(directory,'copy.json'),project)).rejects.toThrow('.tblink');
  });
  it('拒绝复用被篡改的同名素材，避免把损坏文件当作原画质素材', async () => {
    const directory = await createTestDirectory();
    cleanupDirectories.push(join(directory, 'assets'), join(directory, 'assets', 'reference-media'));
    const source = join(directory, 'original.mp4');
    cleanupFiles.push(source);
    await writeFile(source, Buffer.from('original-video-bytes'));
    const service = new LinkProjectService();
    const metadata = { name: '原视频', kind: 'video' as const, durationMs: 1000, width: 1920, height: 1080 };
    const asset = await service.importMediaAsset(join(directory, 'show.tblink'), source, metadata);
    const destination = join(directory, asset.relativePath);
    cleanupFiles.push(destination);
    await writeFile(destination, Buffer.from('replaced-preview'));
    await expect(service.inspectAssets(join(directory, 'show.tblink'), {
      ...createEmptyLinkProject('素材检查'), mediaAssets: [asset]
    })).rejects.toThrow('文件校验失败');
    await expect(service.importMediaAsset(join(directory, 'show.tblink'), source, metadata)).rejects.toThrow('和原文件不一致');
    expect(await readFile(source, 'utf8')).toBe('original-video-bytes');
  });
  it('并发保存按调用顺序写入，旧保存不能覆盖新内容', async () => {
    let releaseFirst = (): void => { throw new Error('保存尚未开始'); };
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const contents: string[] = [];
    const writer = vi.fn(async (_path: string, content: string | Uint8Array) => {
      if (contents.length === 0) await firstGate;
      contents.push(String(content));
    });
    const service = new LinkProjectService(undefined, writer);
    const project = createEmptyLinkProject('旧内容');
    const first = service.save(join(tmpdir(), 'queued.tblink'), project);
    const second = service.save(join(tmpdir(), 'queued.tblink'), { ...project, name: '最新内容' });
    await Promise.resolve();
    expect(writer).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(contents.map((content) => (JSON.parse(content) as { name: string }).name)).toEqual(['旧内容', '最新内容']);
  });

  it('保存失败向调用方报错，之后的保存仍能执行', async () => {
    const writer = vi.fn<typeof writeFile>().mockRejectedValueOnce(new Error('磁盘写入失败')).mockResolvedValue(undefined);
    const service = new LinkProjectService(undefined, writer);
    const project = createEmptyLinkProject('重试工程');
    const first = service.save(join(tmpdir(), 'retry.tblink'), project);
    const second = service.save(join(tmpdir(), 'retry.tblink'), project);
    await expect(first).rejects.toThrow('磁盘写入失败');
    await expect(second).resolves.toBeNull();
    expect(writer).toHaveBeenCalledTimes(2);
  });

  it('多块素材流式计算 SHA-256，导入内容和摘要保持一致', async () => {
    const directory = await createTestDirectory();
    cleanupDirectories.push(join(directory, 'assets'), join(directory, 'assets', 'reference-media'));
    const sourcePath = join(directory, 'long.mp4');
    cleanupFiles.push(sourcePath);
    const content = Buffer.alloc(3 * 1024 * 1024 + 17, 173);
    await writeFile(sourcePath, content);
    const asset = await new LinkProjectService().importMediaAsset(join(directory, 'show.tblink'), sourcePath, {
      name: '多块视频', kind: 'video', durationMs: 10_000, width: 1920, height: 1080
    });
    const destination = join(directory, asset.relativePath);
    cleanupFiles.push(destination);
    expect(asset.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(asset.byteLength).toBe(content.length);
    expect(createHash('sha256').update(await readFile(destination)).digest('hex')).toBe(asset.sha256);
  });

  it('原子保存并重新打开 .tblink 工程', async () => {
    const directory = await createTestDirectory();
    const projectPath = join(directory, 'show.tblink');
    cleanupFiles.push(projectPath);
    const project = createEmptyLinkProject('现场工程', new Date('2026-08-26T00:00:00.000Z'));
    const service = new LinkProjectService();

    await service.save(projectPath, project);
    await expect(service.open(projectPath)).resolves.toEqual(project);
    expect(await readFile(projectPath, 'utf8')).toContain('"schemaVersion": 1');

    const renamed = { ...project, name: '覆盖保存后的工程', updatedAt: '2026-08-26T01:00:00.000Z' };
    await service.save(projectPath, renamed);
    await expect(service.open(projectPath)).resolves.toEqual(renamed);
  });

  it('损坏 JSON 明确报错', async () => {
    const directory = await createTestDirectory();
    const projectPath = join(directory, 'broken.tblink');
    cleanupFiles.push(projectPath);
    await writeFile(projectPath, '{broken', 'utf8');
    await expect(new LinkProjectService().open(projectPath)).rejects.toThrow('格式不对');
  });

  it('参考音频按 SHA-256 导入工程并去重', async () => {
    const directory = await createTestDirectory();
    const assetsDirectory = join(directory, 'assets');
    const referenceDirectory = join(assetsDirectory, 'reference-audio');
    cleanupDirectories.push(assetsDirectory, referenceDirectory);
    const sourcePath = join(directory, 'source.wav');
    cleanupFiles.push(sourcePath);
    await writeFile(sourcePath, Buffer.from('audio'));
    const projectPath = join(directory, 'show.tblink');
    const service = new LinkProjectService();

    const first = await service.importReferenceAudio(projectPath, sourcePath, 1_234);
    const second = await service.importReferenceAudio(projectPath, sourcePath, 1_234);
    const destination = join(directory, ...first.relativePath.split('/'));
    cleanupFiles.push(destination);

    expect(first.sha256).toBe(second.sha256);
    expect(first.relativePath).toBe(second.relativePath);
    expect(first.assetId).not.toBe(second.assetId);
    await expect(readFile(destination, 'utf8')).resolves.toBe('audio');
  });

  it('视频素材导入独立媒体目录并保留真实元数据', async () => {
    const directory = await createTestDirectory();
    const assetsDirectory = join(directory, 'assets');
    const mediaDirectory = join(assetsDirectory, 'reference-media');
    cleanupDirectories.push(assetsDirectory, mediaDirectory);
    const sourcePath = join(directory, 'opening.mp4');
    cleanupFiles.push(sourcePath);
    await writeFile(sourcePath, Buffer.from('video-data'));
    const projectPath = join(directory, 'show.tblink');
    const service = new LinkProjectService();

    const asset = await service.importMediaAsset(projectPath, sourcePath, {
      name: '开场参考视频',
      kind: 'video',
      durationMs: 5_000,
      width: 1920,
      height: 1080
    });
    const destination = join(directory, ...asset.relativePath.split('/'));
    cleanupFiles.push(destination);

    expect(asset).toMatchObject({
      name: '开场参考视频',
      kind: 'video',
      byteLength: 10,
      durationMs: 5_000,
      width: 1920,
      height: 1080
    });
    expect(service.resolveMediaAsset(projectPath, asset.relativePath)).toBe(destination);
    await expect(readFile(destination, 'utf8')).resolves.toBe('video-data');

    const project = createEmptyLinkProject('素材工程');
    project.mediaAssets.push(asset);
    await expect(service.inspectAssets(projectPath, project)).resolves.toMatchObject({
      media: { [asset.id]: { fileAvailable: true } }
    });
    await unlink(destination);
    await expect(service.inspectAssets(projectPath, project)).resolves.toMatchObject({
      media: { [asset.id]: { fileAvailable: false } }
    });
  });

  it('只挪动 .tblink 后，从原工程文件夹按相同相对路径找回素材，核对内容后复制', async () => {
    const original = await createTestDirectory(); const moved = await createTestDirectory();
    for (const root of [original, moved]) cleanupDirectories.push(join(root, 'assets'), join(root, 'assets', 'reference-audio'), join(root, 'assets', 'reference-media'));
    const service = new LinkProjectService();
    const audioSource = join(original, 'song.wav'); const videoSource = join(original, 'opening.mp4');
    cleanupFiles.push(audioSource, videoSource);
    await writeFile(audioSource, Buffer.from('song-audio')); await writeFile(videoSource, Buffer.from('opening-video'));
    const originalProject = join(original, 'show.tblink'); const movedProject = join(moved, 'show.tblink');
    const audio = await service.importReferenceAudio(originalProject, audioSource, 1_000);
    const video = await service.importMediaAsset(originalProject, videoSource, { name: '开场', kind: 'video', durationMs: 1_000, width: 64, height: 64 });
    const replaced = { relativePath: 'assets/reference-media/replaced.mp4', sha256: sha256('expected') };
    const absent = { relativePath: 'assets/reference-media/absent.mp4', sha256: sha256('absent') };
    await writeFile(join(original, replaced.relativePath), 'other-bytes');
    const waveformPath = (root: string, suffix = '.json'): string => join(root, 'cache', 'waveforms', `${audio.sha256}${suffix}`);
    for (const root of [original, moved]) cleanupDirectories.push(join(root, 'cache'), join(root, 'cache', 'waveforms'));
    cleanupFiles.push(waveformPath(original), waveformPath(moved), waveformPath(original, '.source.json'), waveformPath(moved, '.source.json'));
    await service.saveWaveformCache(originalProject, audio.sha256, [0, 0.5, -0.5], true);
    for (const relativePath of [audio.relativePath, video.relativePath, replaced.relativePath]) cleanupFiles.push(join(original, relativePath));
    for (const relativePath of [audio.relativePath, video.relativePath]) cleanupFiles.push(join(moved, relativePath));
    const files = [audio, video, replaced, absent].map(({ relativePath, sha256 }) => ({ relativePath, sha256 }));

    expect(await service.findMissingAssetFiles(movedProject, files)).toEqual(files.map(file => file.relativePath));
    expect(await service.relinkAssetFiles(movedProject, original, files)).toEqual([
      { relativePath: audio.relativePath, status: 'restored' },
      { relativePath: video.relativePath, status: 'restored' },
      { relativePath: replaced.relativePath, status: 'mismatch' },
      { relativePath: absent.relativePath, status: 'not-found' }
    ]);
    await expect(readFile(join(moved, audio.relativePath), 'utf8')).resolves.toBe('song-audio');
    await expect(readFile(join(moved, video.relativePath), 'utf8')).resolves.toBe('opening-video');
    expect(await readdir(join(moved, 'assets', 'reference-media'))).toEqual([video.relativePath.split('/').at(-1)]);
    expect(await service.loadWaveformCache(movedProject, audio.sha256)).toEqual({ peaks: [0, 0.5, -0.5], sourceVerified: true });
    // The record of the checked source comes along, so the moved cache is not rebuilt.
    expect((await readdir(join(moved, 'cache', 'waveforms'))).sort()).toEqual([`${audio.sha256}.json`, `${audio.sha256}.source.json`]);
    expect(await service.findMissingAssetFiles(movedProject, files)).toEqual([replaced.relativePath, absent.relativePath]);
    expect((await service.relinkAssetFiles(movedProject, original, files.slice(0, 1)))[0]?.status).toBe('present');
  });

  it('波形缓存文件保持 0.5.8 能读的纯数组；核对记录另存一份，缓存改过或记录坏了都算没核对过', async () => {
    const directory = await createTestDirectory(); const project = join(directory, 'show.tblink'); const song = sha256('song');
    const path = join(directory, 'cache', 'waveforms', `${song}.json`); const record = join(directory, 'cache', 'waveforms', `${song}.source.json`);
    cleanupDirectories.push(join(directory, 'cache'), join(directory, 'cache', 'waveforms')); cleanupFiles.push(path, record);
    const service = new LinkProjectService();
    await service.saveWaveformCache(project, song, [0, 0.5], true);
    // Rollback: the user keeps the 0.5.8 installer, whose reader accepts only a bare array of peaks in <sha>.json
    // and shows 波形缓存结构无效 for anything else. This is that reader; a cache written now must pass it.
    const reader058 = (text: string): number[] => {
      const value: unknown = JSON.parse(text);
      if (!Array.isArray(value) || value.length === 0 || value.length > 500_000) throw new Error('波形缓存结构无效');
      return value.map((peak: unknown) => { if (typeof peak !== 'number' || !Number.isFinite(peak) || peak < -1 || peak > 1) throw new Error('波形缓存结构无效'); return peak; });
    };
    const written = await readFile(path, 'utf8');
    expect(written).toBe('[0,0.5]\n'); expect(reader058(written)).toEqual([0, 0.5]);
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({ sourceSha256: song, peaksSha256: sha256('[0,0.5]\n') });
    expect(await service.loadWaveformCache(project, song)).toEqual({ peaks: [0, 0.5], sourceVerified: true });
    // 0.5.8 after a rollback rewrote the cache: the record is stale.
    await writeFile(path, '[0.1,0.2]\n');
    expect(await service.loadWaveformCache(project, song)).toEqual({ peaks: [0.1, 0.2], sourceVerified: false });
    for (const damaged of ['not json', '{"sourceSha256":"short","peaksSha256":"x"}', JSON.stringify({ sourceSha256: song, peaksSha256: sha256('[0.1,0.2]\n'), extra: 1 }),
      JSON.stringify({ sourceSha256: sha256('other'), peaksSha256: sha256('[0.1,0.2]\n') }), 'x'.repeat(2000),
      // Matching but over 1 KB: such a file is not one this version wrote, and is not read whole.
      `${JSON.stringify({ sourceSha256: song, peaksSha256: sha256('[0.1,0.2]\n') })}${' '.repeat(1024)}`]) {
      await writeFile(record, damaged);
      await expect(service.loadWaveformCache(project, song)).resolves.toEqual({ peaks: [0.1, 0.2], sourceVerified: false });
    }
    await writeFile(record, JSON.stringify({ sourceSha256: song, peaksSha256: sha256('[0.1,0.2]\n') }));
    expect((await service.loadWaveformCache(project, song))?.sourceVerified).toBe(true);
    for (const content of ['{"peaks":[0]}', `{"sourceSha256":"${song}","peaks":[0]}`, '[2]', '[]']) {
      await writeFile(path, content);
      await expect(service.loadWaveformCache(project, song)).rejects.toThrow('波形缓存结构无效');
    }
  });

  it('核对记录过期的缓存经波形服务重建一次，之后带上新记录和多级波形', async () => {
    const directory = await createTestDirectory(); const project = join(directory, 'show.tblink'); const song = sha256('song');
    const path = join(directory, 'cache', 'waveforms', `${song}.json`); const record = join(directory, 'cache', 'waveforms', `${song}.source.json`);
    const levels = join(directory, 'cache', 'waveforms', `${song}.levels.bin`);
    cleanupDirectories.push(join(directory, 'cache'), join(directory, 'cache', 'waveforms')); cleanupFiles.push(path, record, levels);
    const service = new LinkProjectService(); const old = Array.from({ length: 4800 }, () => 0.1);
    await service.saveWaveformCache(project, song, Array.from({ length: 4800 }, () => 0.5), true);
    await writeFile(path, `${JSON.stringify(old)}\n`);
    const decode = vi.fn().mockResolvedValue(decodedWaveform(1000, 0.9)); const waveforms = new WaveformService(service, decode, () => Promise.resolve(true));
    const shown = await waveforms.ensure(project, 'song.wav', song, 1000, false);
    expect([shown.state, loudest(shown.waveform)]).toEqual(['unverified', expect.closeTo(0.1, 3)]);
    for (let round = 0; round < 2; round++) {
      const rebuilt = await waveforms.ensure(project, 'song.wav', song, 1000, true);
      expect([rebuilt.state, loudest(rebuilt.waveform)]).toEqual(['verified', expect.closeTo(0.9, 3)]);
    }
    expect(decode).toHaveBeenCalledTimes(1);
    expect((await service.loadWaveformCache(project, song))?.sourceVerified).toBe(true);
  });

  it('多级波形存在 0.5.8 不打开的新文件里，<sha>.json 照旧是 0.5.8 能读的纯数组（E10）', async () => {
    // 0.5.8 is the rollback installer. It opens only cache/waveforms/<sha>.json and refuses anything but a bare
    // array of peaks there (波形缓存结构无效). The levels, rhythm band and spectrum go to <sha>.levels.bin.
    const directory = await createTestDirectory(); const project = join(directory, 'show.tblink'); const song = sha256('levels song');
    const folder = join(directory, 'cache', 'waveforms');
    cleanupDirectories.push(join(directory, 'cache'), folder);
    cleanupFiles.push(join(folder, `${song}.json`), join(folder, `${song}.source.json`), join(folder, `${song}.levels.bin`));
    const service = new LinkProjectService();
    const waveforms = new WaveformService(service, vi.fn().mockResolvedValue(decodedWaveform(1000, 0.25)), () => Promise.resolve(true));
    const result = await waveforms.ensure(project, 'song.wav', song, 1000, true);
    expect(result.state).toBe('verified'); expect(result.waveform.levels.length).toBeGreaterThan(1); expect(result.waveform.spectrum).not.toBeNull();
    expect((await readdir(folder)).sort()).toEqual([`${song}.json`, `${song}.levels.bin`, `${song}.source.json`]);
    const reader058 = (text: string): number[] => {
      const value: unknown = JSON.parse(text);
      if (!Array.isArray(value) || value.length === 0 || value.length > 500_000) throw new Error('波形缓存结构无效');
      return value.map((peak: unknown) => { if (typeof peak !== 'number' || !Number.isFinite(peak) || peak < -1 || peak > 1) throw new Error('波形缓存结构无效'); return peak; });
    };
    // 0.5.8 checks the count against the song's length (one peak per 2 ms) before it trusts the cache.
    expect(reader058(await readFile(join(folder, `${song}.json`), 'utf8'))).toEqual(Array.from({ length: 4800 }, () => 0.25));
    // The new file is binary and not JSON, so no JSON reader can take it for a cache.
    expect((await readFile(join(folder, `${song}.levels.bin`))).subarray(0, 4).toString('latin1')).toBe('TBWL');
    // After 0.5.8 rewrote its cache (a rollback and back), the levels still serve without a decode.
    await writeFile(join(folder, `${song}.json`), `${JSON.stringify(Array.from({ length: 4800 }, () => 0.7))}\n`);
    const decode = vi.fn(); const again = await new WaveformService(service, decode, () => Promise.resolve(true)).ensure(project, 'song.wav', song, 1000, false);
    expect([again.state, loudest(again.waveform)]).toEqual(['verified', expect.closeTo(0.25, 3)]); expect(decode).not.toHaveBeenCalled();
  });


  it('找回素材时核对记录跟缓存对不上就不带过去，缓存照样复制', async () => {
    const service = new LinkProjectService(); const audio = await originalAudio();
    const waveforms = join(audio.folder, 'cache', 'waveforms'); const cache = join(waveforms, `${audio.file.sha256}.json`); const record = join(waveforms, `${audio.file.sha256}.source.json`);
    await mkdir(waveforms, { recursive: true });
    cleanupDirectories.push(join(audio.folder, 'cache'), waveforms); cleanupFiles.push(cache, record);
    await writeFile(cache, '[0.25]\n'); await writeFile(record, JSON.stringify({ sourceSha256: audio.file.sha256, peaksSha256: sha256('[0.5]\n') }));
    const moved = await createTestDirectory();
    cleanupDirectories.push(join(moved, 'assets'), join(moved, 'assets', 'reference-audio'), join(moved, 'cache'), join(moved, 'cache', 'waveforms'));
    cleanupFiles.push(join(moved, audio.file.relativePath), join(moved, 'cache', 'waveforms', `${audio.file.sha256}.json`));
    await service.relinkAssetFiles(join(moved, 'show.tblink'), audio.folder, [audio.file]);
    expect(await readdir(join(moved, 'cache', 'waveforms'))).toEqual([`${audio.file.sha256}.json`]);
    expect(await service.loadWaveformCache(join(moved, 'show.tblink'), audio.file.sha256)).toEqual({ peaks: [0.25], sourceVerified: false });
  });

  // A file symbolic link needs administrator rights or developer mode on Windows; the folder cases above use junctions.
  it.skipIf(process.platform === 'win32')('找回波形核对记录不读取所选文件夹里经符号链接指向别处的文件', async () => {
    const service = new LinkProjectService(); const audio = await originalAudio();
    const waveforms = join(audio.folder, 'cache', 'waveforms'); const cache = join(waveforms, `${audio.file.sha256}.json`); const record = join(waveforms, `${audio.file.sha256}.source.json`);
    const elsewhere = await createTestDirectory(); const target = join(elsewhere, 'record.json');
    await mkdir(waveforms, { recursive: true });
    cleanupDirectories.push(join(audio.folder, 'cache'), waveforms); cleanupFiles.push(cache, target); cleanupLinks.push(record);
    await writeFile(cache, '[0.25]\n'); await writeFile(target, JSON.stringify({ sourceSha256: audio.file.sha256, peaksSha256: sha256('[0.25]\n') }));
    await symlink(target, record);
    const moved = await createTestDirectory();
    cleanupDirectories.push(join(moved, 'assets'), join(moved, 'assets', 'reference-audio'));
    cleanupFiles.push(join(moved, audio.file.relativePath));
    await expect(service.relinkAssetFiles(join(moved, 'show.tblink'), audio.folder, [audio.file])).rejects.toThrow('符号链接');
    expect(await readdir(moved)).toEqual([]);
  });

  it('没有记号的旧波形缓存在开播前检查里照样算有，P1 跟随不被挡住', async () => {
    const directory = await createTestDirectory(); const projectPath = join(directory, 'show.tblink');
    const service = new LinkProjectService(); const audioSource = join(directory, 'song.wav'); cleanupFiles.push(audioSource);
    await writeFile(audioSource, Buffer.from('song-audio'));
    cleanupDirectories.push(join(directory, 'assets'), join(directory, 'assets', 'reference-audio'), join(directory, 'cache'), join(directory, 'cache', 'waveforms'));
    const audio = await service.importReferenceAudio(projectPath, audioSource, 1_000); cleanupFiles.push(join(directory, audio.relativePath));
    const waveform = join(directory, 'cache', 'waveforms', `${audio.sha256}.json`); cleanupFiles.push(waveform);
    await mkdir(join(directory, 'cache', 'waveforms'), { recursive: true }); await writeFile(waveform, '[0.1,0.2]\n');
    const project = createEmptyLinkProject('旧缓存');
    project.rundown.push({ id: 'song', title: '一首歌', enabled: true, notes: '', visualLayers: [], referenceAudio: audio, referenceMediaClips: [], cues: [] });
    // The preflight passes on `waveformAvailable` (warning without it when the console plays, blocking when following P1).
    expect((await service.inspectAssets(projectPath, project)).referenceAudio).toEqual({ song: { audioAvailable: true, waveformAvailable: true } });
  });

  it('找回素材不读写工程文件夹或所选文件夹以外的路径', async () => {
    const directory = await createTestDirectory();
    const service = new LinkProjectService(); const file = { relativePath: '../outside.wav', sha256: sha256('outside') };
    await expect(service.relinkAssetFiles(join(directory, 'show.tblink'), directory, [file])).rejects.toThrow('必须位于工程目录内');
    await expect(service.findMissingAssetFiles(join(directory, 'show.tblink'), [file])).rejects.toThrow('必须位于工程目录内');
    await expect(service.relinkAssetFiles(join(directory, 'show.tblink'), 'relative-folder', [{ relativePath: 'a.wav', sha256: sha256('a') }])).rejects.toThrow('完整路径');
  });

  it('找回素材不写入工程文件夹里经符号链接或目录联接指向别处的位置', async () => {
    const service = new LinkProjectService(); const audio = await originalAudio();
    const moved = await createTestDirectory(); const outside = await createTestDirectory();
    await linkFolder(outside, join(moved, 'assets'));
    cleanupDirectories.push(join(outside, 'reference-audio')); cleanupFiles.push(join(outside, 'reference-audio', parse(audio.file.relativePath).base));
    await expect(service.relinkAssetFiles(join(moved, 'show.tblink'), audio.folder, [audio.file])).rejects.toThrow('符号链接');
    expect(await readdir(outside)).toEqual([]);
  });

  it('找回素材不读取所选文件夹里经符号链接或目录联接指向别处的文件', async () => {
    const service = new LinkProjectService(); const audio = await originalAudio();
    const picked = await createTestDirectory(); const moved = await createTestDirectory();
    await linkFolder(join(audio.folder, 'assets'), join(picked, 'assets'));
    cleanupDirectories.push(join(moved, 'assets'), join(moved, 'assets', 'reference-audio')); cleanupFiles.push(join(moved, audio.file.relativePath));
    await expect(service.relinkAssetFiles(join(moved, 'show.tblink'), picked, [audio.file])).rejects.toThrow('符号链接');
    expect(await readdir(moved)).toEqual([]);
  });

  it('找回波形缓存不读取所选文件夹里经符号链接或目录联接指向别处的文件', async () => {
    const service = new LinkProjectService(); const audio = await originalAudio();
    const elsewhere = await createTestDirectory(); const moved = await createTestDirectory();
    const linkedWaveform = join(elsewhere, 'waveforms', `${audio.file.sha256}.json`);
    await mkdir(join(elsewhere, 'waveforms')); cleanupDirectories.push(join(elsewhere, 'waveforms')); cleanupFiles.push(linkedWaveform);
    await writeFile(linkedWaveform, '[0]\n');
    await linkFolder(elsewhere, join(audio.folder, 'cache'));
    cleanupDirectories.push(join(moved, 'assets'), join(moved, 'assets', 'reference-audio'), join(moved, 'cache'), join(moved, 'cache', 'waveforms'));
    cleanupFiles.push(join(moved, audio.file.relativePath), join(moved, 'cache', 'waveforms', `${audio.file.sha256}.json`));
    await expect(service.relinkAssetFiles(join(moved, 'show.tblink'), audio.folder, [audio.file])).rejects.toThrow('符号链接');
    expect(await readdir(moved)).toEqual([]);
  });

  it('找回波形缓存不写入工程文件夹里经符号链接或目录联接指向别处的位置', async () => {
    const service = new LinkProjectService(); const audio = await originalAudio();
    const waveform = join(audio.folder, 'cache', 'waveforms', `${audio.file.sha256}.json`);
    await mkdir(join(audio.folder, 'cache', 'waveforms'), { recursive: true });
    cleanupDirectories.push(join(audio.folder, 'cache'), join(audio.folder, 'cache', 'waveforms')); cleanupFiles.push(waveform);
    await writeFile(waveform, '[0]\n');
    const moved = await createTestDirectory(); const outside = await createTestDirectory();
    await linkFolder(outside, join(moved, 'cache'));
    cleanupDirectories.push(join(moved, 'assets'), join(moved, 'assets', 'reference-audio'), join(outside, 'waveforms'));
    cleanupFiles.push(join(moved, audio.file.relativePath), join(outside, 'waveforms', `${audio.file.sha256}.json`));
    await expect(service.relinkAssetFiles(join(moved, 'show.tblink'), audio.folder, [audio.file])).rejects.toThrow('符号链接');
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(moved)).toEqual(['cache']);
  });

  it('找回时拒绝格式无效或超过 16 MB 的波形缓存，工程文件夹不变', async () => {
    const service = new LinkProjectService(); const audio = await originalAudio();
    const waveform = join(audio.folder, 'cache', 'waveforms', `${audio.file.sha256}.json`);
    await mkdir(join(audio.folder, 'cache', 'waveforms'), { recursive: true });
    cleanupDirectories.push(join(audio.folder, 'cache'), join(audio.folder, 'cache', 'waveforms')); cleanupFiles.push(waveform);
    const moved = await createTestDirectory();
    cleanupDirectories.push(join(moved, 'assets'), join(moved, 'assets', 'reference-audio'), join(moved, 'cache'), join(moved, 'cache', 'waveforms'));
    cleanupFiles.push(join(moved, audio.file.relativePath), join(moved, 'cache', 'waveforms', `${audio.file.sha256}.json`));
    for (const content of ['{"peaks":[0]}', '[0, 2]', '[]', 'not json']) {
      await writeFile(waveform, content);
      await expect(service.relinkAssetFiles(join(moved, 'show.tblink'), audio.folder, [audio.file])).rejects.toThrow('波形缓存');
    }
    await writeFile(waveform, '[0]'); await truncate(waveform, 16 * 1024 * 1024 + 1);
    await expect(service.relinkAssetFiles(join(moved, 'show.tblink'), audio.folder, [audio.file])).rejects.toThrow('16 MB');
    expect(await readdir(moved)).toEqual([]);
  });

  it('保存波形缓存不写入工程文件夹里经符号链接或目录联接指向别处的位置，也不接受过长的波形', async () => {
    const service = new LinkProjectService(); const project = await createTestDirectory(); const outside = await createTestDirectory();
    await linkFolder(outside, join(project, 'cache'));
    cleanupDirectories.push(join(outside, 'waveforms')); cleanupFiles.push(join(outside, 'waveforms', `${sha256('a')}.json`));
    await expect(service.saveWaveformCache(join(project, 'show.tblink'), sha256('a'), [0, 0.5], true)).rejects.toThrow('符号链接');
    expect(await readdir(outside)).toEqual([]);
    await expect(service.saveWaveformCache(join(await createTestDirectory(), 'show.tblink'), sha256('a'), Array.from({ length: 500_001 }, () => 0), true)).rejects.toThrow('500000');
  });

  it('找回素材只接受 assets 素材子目录里的音视频和图片文件，有一个不符合就整批拒绝', async () => {
    const service = new LinkProjectService(); const audio = await originalAudio(); const moved = await createTestDirectory();
    cleanupDirectories.push(join(moved, 'assets'), join(moved, 'assets', 'reference-audio')); cleanupFiles.push(join(moved, audio.file.relativePath));
    for (const relativePath of ['song.wav', 'assets/song.wav', 'assets/cache/song.wav', 'assets/reference-audio/nested/song.wav',
      'assets/reference-audio/song.exe', 'assets/reference-audio/song.mp4', 'assets/reference-media/notes.txt', 'cache/waveforms/song.json', 'assets\\reference-audio\\song.wav']) {
      await expect(service.relinkAssetFiles(join(moved, 'show.tblink'), audio.folder, [audio.file, { relativePath, sha256: sha256('song') }])).rejects.toThrow('只能使用');
    }
    expect(await readdir(moved)).toEqual([]);
    expect(await service.relinkAssetFiles(join(moved, 'show.tblink'), audio.folder, [audio.file, { relativePath: 'assets/reference-media/clip.MOV', sha256: sha256('clip') }]))
      .toEqual([{ relativePath: audio.file.relativePath, status: 'restored' }, { relativePath: 'assets/reference-media/clip.MOV', status: 'not-found' }]);
  });

  it('检查缺失素材不能探测工程文件夹里素材子目录以外的文件', async () => {
    const directory = await createTestDirectory(); const secret = join(directory, 'secret.txt'); cleanupFiles.push(secret);
    await writeFile(secret, 'secret');
    const service = new LinkProjectService();
    for (const relativePath of ['secret.txt', 'assets/reference-audio/../../secret.txt', 'assets/reference-media/secret.txt']) {
      await expect(service.findMissingAssetFiles(join(directory, 'show.tblink'), [{ relativePath }])).rejects.toThrow('只能使用');
    }
  });

  it('检查缺失素材只接受 .tblink 工程路径', async () => {
    const directory = await createTestDirectory();
    await expect(new LinkProjectService().findMissingAssetFiles(join(directory, 'show.json'), [{ relativePath: 'assets/reference-audio/a.wav' }])).rejects.toThrow('.tblink');
  });

  it.runIf(process.platform === 'win32')('拒绝把跨盘绝对路径解析为工程内素材', async () => {
    const directory = await createTestDirectory();
    const projectPath = join(directory, 'show.tblink');
    const currentDrive = parse(directory).root.slice(0, 1).toLocaleUpperCase('en-US');
    const otherDrive = currentDrive === 'C' ? 'D' : 'C';

    expect(() => new LinkProjectService().resolveMediaAsset(projectPath, `${otherDrive}:\\outside.mp4`))
      .toThrow('媒体素材路径必须位于工程目录内');
  });
});

describe('存成 0.5.8 打不开的格式之前（0.5.9 E9）', () => {
  /** A file 0.5.8 opens, and content that needs schema 3. */
  async function olderFile(name: string): Promise<{ directory: string; path: string; original: string; backup: (suffix?: string) => string }> {
    const directory = await createTestDirectory(), path = join(directory, `${name}.tblink`);
    const original = serializeLinkProject({ ...createEmptyLinkProject('旧版本的工程'), schemaVersion: 2 });
    await writeFile(path, original); cleanupFiles.push(path);
    const backup = (suffix = ''): string => { const file = join(directory, `${name}（旧版本可打开的备份${suffix}）.tblink`); cleanupFiles.push(file); return file; };
    return { directory, path, original, backup };
  }
  const newer = (): LinkProject => ({ ...createEmptyLinkProject('新格式'), schemaVersion: 3 });

  it('没确认就不保存，原文件不动，也不留备份', async () => {
    const { directory, path, original } = await olderFile('演出');
    const service = new LinkProjectService();
    expect(await service.olderFormatFile(path, 3)).toEqual({ backupName: '演出（旧版本可打开的备份）.tblink' });
    await expect(service.save(path, newer())).rejects.toThrow('保存后 0.5.8 和更早的版本打不开这个工程，要先确认');
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readdir(directory)).toEqual(['演出.tblink']);
  });

  it('确认后先把原文件另存一份旧版本能打开的备份，再保存；只留这一份，不再另留 .bak', async () => {
    const { directory, path, original, backup } = await olderFile('演出');
    const service = new LinkProjectService();
    const kept = await service.save(path, newer(), { replaceOlderFormat: true, backupOriginal: true });
    expect(kept).toBe(backup());
    expect(await readFile(backup(), 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ schemaVersion: 3, name: '新格式' });
    expect((await readdir(directory)).sort()).toEqual(['演出.tblink', '演出（旧版本可打开的备份）.tblink'].sort());
    // Now the file is newer itself: no more question, no more backup.
    expect(await service.olderFormatFile(path, 3)).toBeNull();
    await expect(service.save(path, { ...newer(), name: '再存一次' })).resolves.toBeNull();
  });

  it('已有同名备份不覆盖，加序号', async () => {
    const { path, original, backup } = await olderFile('演出');
    await writeFile(backup(), '上一份备份');
    const service = new LinkProjectService();
    expect(await service.olderFormatFile(path, 3)).toEqual({ backupName: '演出（旧版本可打开的备份 2）.tblink' });
    expect(await service.save(path, newer(), { replaceOlderFormat: true })).toBe(backup(' 2'));
    expect(await readFile(backup(), 'utf8')).toBe('上一份备份');
    expect(await readFile(backup(' 2'), 'utf8')).toBe(original);
  });

  it('备份写不出来就报错并写明原因，原文件不覆盖', async () => {
    const { directory, path, original } = await olderFile('演出');
    const writer = vi.fn<typeof writeFile>();
    const copy = vi.fn(() => Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })));
    const service = new LinkProjectService(undefined, writer, copy);
    await expect(service.save(path, newer(), { replaceOlderFormat: true })).rejects.toThrow(/这次没有保存，原来的工程文件没有动.*原因：EACCES: permission denied/);
    expect(writer).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readdir(directory)).toEqual(['演出.tblink']);
  });

  it('不用问也不用备份：另存为、新建的工程没有旧文件；内容 0.5.8 能打开；旧文件本来就是新格式', async () => {
    const directory = await createTestDirectory(), fresh = join(directory, '新建.tblink'); cleanupFiles.push(fresh);
    const service = new LinkProjectService();
    expect(await service.olderFormatFile(fresh, 3)).toBeNull();
    await expect(service.save(fresh, newer())).resolves.toBeNull();
    const old = await olderFile('旧版');
    expect(await service.olderFormatFile(old.path, 2)).toBeNull();
    await expect(service.save(old.path, { ...createEmptyLinkProject('还是旧格式'), schemaVersion: 2 })).resolves.toBeNull();
    expect(await readdir(directory)).toEqual(['新建.tblink']);
    expect(await readdir(old.directory)).toEqual(['旧版.tblink']);
  });

  it('歌在音乐后面留了空白也走同一条路：改音频的命令升到 3 版，存之前要确认并留备份（0.5.9 E13）', async () => {
    const { path, original, backup } = await olderFile('空白');
    const mix = { assetId: 'mix', relativePath: 'assets/reference-audio/mix.wav', sha256: 'c'.repeat(64), durationMs: 6000 };
    const source = { assetId: 'source', relativePath: 'assets/reference-audio/source.wav', sha256: 'b'.repeat(64), durationMs: 4000 };
    const old = { ...createEmptyLinkProject('空白'), schemaVersion: 2 as const };
    old.rundown.push({ id: 'song', title: '歌', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], referenceAudio: { ...source } });
    const padded = editReferenceAudioCommand('song', { ...mix, timeline: { source: mix, segments: [{ id: 'mix', startMs: 0, sourceOffsetMs: 0, durationMs: 6000 }],
      tracks: [{ id: 'track', title: '歌曲音频', source, segments: [{ id: 'music', startMs: 0, sourceOffsetMs: 0, durationMs: 4000 }] }], durationMs: 6000 } }, '加空白').execute(old);
    expect(padded.schemaVersion).toBe(3);
    const service = new LinkProjectService();
    expect(await service.olderFormatFile(path, padded.schemaVersion)).toEqual({ backupName: '空白（旧版本可打开的备份）.tblink' });
    await expect(service.save(path, padded)).rejects.toThrow('要先确认');
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await service.save(path, padded, { replaceOlderFormat: true })).toBe(backup());
    expect(await readFile(backup(), 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ schemaVersion: 3 });
  });
});

async function createTestDirectory(): Promise<string> {
  const directory = join(tmpdir(), `tblink-${crypto.randomUUID()}`);
  await mkdir(directory);
  cleanupDirectories.push(directory);
  return directory;
}

/** An original project folder holding one song file, as the software imported it. */
async function originalAudio(): Promise<{ folder: string; file: { relativePath: string; sha256: string } }> {
  const folder = await createTestDirectory(); const digest = sha256('song-audio');
  const file = { relativePath: `assets/reference-audio/${digest}.wav`, sha256: digest };
  await mkdir(join(folder, 'assets', 'reference-audio'), { recursive: true });
  cleanupDirectories.push(join(folder, 'assets'), join(folder, 'assets', 'reference-audio')); cleanupFiles.push(join(folder, file.relativePath));
  await writeFile(join(folder, file.relativePath), 'song-audio');
  return { folder, file };
}

/** A directory junction on Windows (no administrator rights needed), a symbolic link elsewhere. */
async function linkFolder(target: string, path: string): Promise<void> {
  await symlink(target, path, 'junction');
  cleanupLinks.push(path);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function ignoreMissing(error: unknown): void {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
  throw error;
}
