import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinkProjectService } from './link-project-service';
import { MediaPreviewService } from './media-preview-service';

const cleanupDirectories: string[] = [];
const cleanupFiles: string[] = [];

afterEach(async () => {
  for (const file of cleanupFiles.splice(0)) await unlink(file);
  for (const directory of cleanupDirectories.splice(0).reverse()) await rmdir(directory);
});

describe('MediaPreviewService', () => {
  it('定位缓存与预览共用两个视频任务名额，单条失败释放名额且不自动重试', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tblink-video-workers-'));
    const media = join(root, 'assets', 'reference-media');
    await mkdir(media, { recursive: true });
    cleanupDirectories.push(root, join(root, 'assets'), media, join(root, 'cache'),
      join(root, 'cache', 'obs-seek-jpeg2000'), join(root, 'cache', 'media-proxies'));
    let active = 0; let peak = 0;
    const calls: string[][] = [];
    const service = new MediaPreviewService(new LinkProjectService(), async (_exe, args) => {
      active++; peak = Math.max(peak, active); calls.push(args);
      try {
        await new Promise(resolve => setTimeout(resolve, 10));
        await writeFile(args.at(-1)!, 'generated');
        if (args[args.indexOf('-i') + 1]!.endsWith('0.mp4')) throw new Error('source decoder failed');
      } finally { active--; }
    }, () => 'ffmpeg.exe');
    const requests: Promise<string>[] = [];
    for (let index = 0; index < 8; index++) {
      const source = join(media, `${index}.mp4`), content = `video-${index}`;
      await writeFile(source, content); cleanupFiles.push(source);
      const digest = createHash('sha256').update(content).digest('hex');
      const relative = `assets/reference-media/${index}.mp4`;
      requests.push(index % 2 === 0 ? service.ensureObsSeekVideo(join(root, 'show.tblink'), relative, digest)
        : service.ensureVideoPreview(join(root, 'show.tblink'), relative, digest));
    }
    const results = await Promise.allSettled(requests);
    for (const result of results) if (result.status === 'fulfilled') {
      cleanupFiles.push(result.value);
      if (result.value.endsWith('.mkv')) cleanupFiles.push(`${result.value}.sha256`);
    }
    expect(peak).toBe(2); expect(active).toBe(0); expect(calls).toHaveLength(8);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(7);
    for (const args of calls) {
      const input = args.indexOf('-i');
      expect(args.slice(0, input)).toEqual(expect.arrayContaining(['-threads', '2', '-filter_threads', '1']));
      expect(args.slice(input + 2)).toEqual(expect.arrayContaining(['-threads', '2']));
    }
  });
  it('素材列表只生成单帧图片，重复请求合并且最多两个解码任务在途', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tblink-thumbnails-'));
    const media = join(root, 'assets', 'reference-media');
    await mkdir(media, { recursive: true });
    cleanupDirectories.push(root, join(root, 'assets'), media, join(root, 'cache'), join(root, 'cache', 'media-thumbnails'));
    let active = 0; let peak = 0;
    const calls: string[][] = [];
    const service = new MediaPreviewService(new LinkProjectService(), async (_exe, args) => {
      calls.push(args); active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      await writeFile(args.at(-1)!, 'one-frame'); active--;
    }, () => 'ffmpeg.exe');
    const requests: Promise<string>[] = [];
    for (let index = 0; index < 8; index++) {
      const source = join(media, `${index}.mp4`); const content = `source-${index}`;
      await writeFile(source, content); cleanupFiles.push(source);
      const digest = createHash('sha256').update(content).digest('hex');
      const request = () => service.ensureThumbnail(join(root, 'show.tblink'), `assets/reference-media/${index}.mp4`, digest);
      requests.push(request(), request());
    }
    const results = await Promise.all(requests); cleanupFiles.push(...new Set(results));
    expect(calls).toHaveLength(8); expect(peak).toBe(2);
    for (const args of calls) expect(args).toEqual(expect.arrayContaining(['-frames:v', '1', '-threads', '1', '-an']));
  });
  it('定位缓存只生成一次，复用校验缓存及原素材，不接受损坏文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tblink-obs-seek-'));
    const assets = join(root, 'assets'); const media = join(assets, 'reference-media');
    await mkdir(media, { recursive: true });
    cleanupDirectories.push(root, assets, media, join(root, 'cache'), join(root, 'cache', 'obs-seek-jpeg2000'));
    const source = join(media, 'source.mp4'); await writeFile(source, 'original'); cleanupFiles.push(source);
    const digest = createHash('sha256').update('original').digest('hex');
    const calls: string[][] = [];
    const service = new MediaPreviewService(new LinkProjectService(), async (_executable, args) => {
      calls.push(args); await writeFile(args.at(-1)!, 'encoded-cache');
    }, () => 'ffmpeg.exe');
    const request = () => service.ensureObsSeekVideo(join(root, 'show.tblink'), 'assets/reference-media/source.mp4', digest);
    const [first, second] = await Promise.all([request(), request()]);
    cleanupFiles.push(first, `${first}.sha256`);
    expect(second).toBe(first); expect(calls).toHaveLength(1);
    expect(first).toMatch(/\.source-pixels\.mkv$/);
    expect(calls[0]).toEqual(expect.arrayContaining(['-c:v', 'ffv1', '-threads', '2', '-avoid_negative_ts', 'disabled']));
    expect(calls[0]).not.toContain('-pix_fmt');
    await expect(request()).resolves.toBe(first); expect(calls).toHaveLength(1);
    await writeFile(first, 'corrupt-cache-longer');
    await expect(request()).rejects.toThrow('定位缓存已损坏');
    await writeFile(source, 'modified-original-longer');
    await expect(request()).rejects.toThrow('原素材完整性校验失败');
    expect(calls).toHaveLength(1);
  });
  it('同一摘要的并行素材不能绕过各自原文件校验', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tblink-obs-source-identity-'));
    const media = join(root, 'assets', 'reference-media');
    await mkdir(media, { recursive: true });
    cleanupDirectories.push(root, join(root, 'assets'), media, join(root, 'cache'), join(root, 'cache', 'obs-seek-jpeg2000'));
    const original = join(media, 'original.mp4'), changed = join(media, 'changed.mp4');
    await writeFile(original, 'original'); await writeFile(changed, 'corrupted'); cleanupFiles.push(original, changed);
    const digest = createHash('sha256').update('original').digest('hex');
    const service = new MediaPreviewService(new LinkProjectService(), async (_executable, args) => {
      await new Promise(resolve => setTimeout(resolve, 20)); await writeFile(args.at(-1)!, 'encoded-cache');
    }, () => 'ffmpeg.exe');
    const first = service.ensureObsSeekVideo(join(root, 'show.tblink'), 'assets/reference-media/original.mp4', digest);
    const second = service.ensureObsSeekVideo(join(root, 'show.tblink'), 'assets/reference-media/changed.mp4', digest);
    const results = await Promise.allSettled([first, second]);
    expect(results[0]?.status).toBe('fulfilled');
    if (results[0]?.status === 'fulfilled') cleanupFiles.push(results[0].value, `${results[0].value}.sha256`);
    const rejected = results[1]; expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      const reason: unknown = rejected.reason;
      expect(reason).toBeInstanceOf(Error);
      if (reason instanceof Error) expect(reason.message).toBe('原素材完整性校验失败，请重新导入');
    }
  });
  it('FFmpeg 失败后删除已生成的临时代理文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tblink-media-preview-'));
    const cache = join(root, 'cache');
    const proxies = join(cache, 'media-proxies');
    cleanupDirectories.push(root, cache, proxies);
    const service = new MediaPreviewService(
      new LinkProjectService(),
      async (_executable, arguments_) => {
        const temporaryPath = arguments_.at(-1);
        if (!temporaryPath) throw new Error('测试未收到代理输出路径');
        await writeFile(temporaryPath, 'partial-output', 'utf8');
        throw new Error('模拟转码失败');
      },
      () => 'fake-ffmpeg.exe'
    );

    await expect(service.ensureVideoPreview(
      join(root, 'show.tblink'),
      'assets/reference-media/source.mp4',
      'a'.repeat(64)
    )).rejects.toThrow('模拟转码失败');

    await mkdir(proxies, { recursive: true });
    await expect(readdir(proxies)).resolves.toEqual([]);
  });
});
