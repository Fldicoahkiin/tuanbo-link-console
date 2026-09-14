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
    expect(calls[0]).toEqual(expect.arrayContaining(['-c:v', 'jpeg2000', '-pred', '1', '-threads', '2', '-avoid_negative_ts', 'disabled']));
    await expect(request()).resolves.toBe(first); expect(calls).toHaveLength(1);
    await writeFile(first, 'corrupt-cache-longer');
    await expect(request()).rejects.toThrow('定位缓存已损坏');
    await writeFile(source, 'modified-original-longer');
    await expect(request()).rejects.toThrow('原素材完整性校验失败');
    expect(calls).toHaveLength(1);
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
