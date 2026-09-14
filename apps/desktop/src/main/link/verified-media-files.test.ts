import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { VerifiedMediaFiles } from './verified-media-files';

describe('素材校验缓存', () => {
  it('十份未变化素材连续检查十轮只读取十次内容，变化后重新校验', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-integrity-'));
    const paths = Array.from({ length: 10 }, (_, index) => join(directory, `${index}.mp4`));
    const hash = vi.fn<(_path: string) => Promise<string>>().mockResolvedValue('original');
    const cache = new VerifiedMediaFiles(hash);
    try {
      await Promise.all(paths.map((path) => writeFile(path, 'original')));
      for (let round = 0; round < 10; round += 1) {
        for (const path of paths) expect(await cache.verify(path, 'original')).toBe(true);
      }
      expect(hash).toHaveBeenCalledTimes(10);
      hash.mockResolvedValue('changed');
      await writeFile(paths[0]!, 'changed-content');
      expect(await cache.verify(paths[0]!, 'original')).toBe(false);
      expect(hash).toHaveBeenCalledTimes(11);
      expect(await cache.verify(paths[1]!, 'another-expected-digest')).toBe(false);
    } finally {
      await Promise.all(paths.map((path) => unlink(path)));
      await rmdir(directory);
    }
  });
  it('校验期间被改写的文件不能缓存为成功', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-changing-'));
    const path = join(directory, 'video.mp4');
    try {
      await writeFile(path, 'original');
      const cache = new VerifiedMediaFiles(async () => { await writeFile(path, 'replacement-content'); return 'original'; });
      await expect(cache.verify(path, 'original')).rejects.toThrow('校验期间发生变化');
    } finally { await unlink(path); await rmdir(directory); }
  });
});
