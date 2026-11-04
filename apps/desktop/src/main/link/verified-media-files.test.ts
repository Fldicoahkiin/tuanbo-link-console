import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { VerifiedMediaFiles } from './verified-media-files';

describe('素材校验缓存', () => {
  it('生成缓存时计算的摘要可直接复用，文件改变后仍重新核验', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-generated-digest-'));
    const path = join(directory, 'cache.mkv');
    const hash = vi.fn<(_path: string) => Promise<string>>().mockResolvedValue('generated');
    const cache = new VerifiedMediaFiles(hash);
    try {
      await writeFile(path, 'generated');
      const digest = await cache.digest(path);
      expect(await cache.verify(path, digest)).toBe(true);
      expect(hash).toHaveBeenCalledTimes(1);
      await writeFile(path, 'changed-cache'); hash.mockResolvedValue('changed');
      expect(await cache.verify(path, digest)).toBe(false);
      expect(hash).toHaveBeenCalledTimes(2);
    } finally { await unlink(path); await rmdir(directory); }
  });
  // Creates and checks 2000 files on purpose. On the Windows runner's scanned disk, beside the other test
  // files running in parallel, it took more than 60 s on 2026-11-01; it states three minutes of its own.
  it('2000 个素材切页检查不会因 256 条缓存循环淘汰而重复读取全部内容', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-integrity-scale-'));
    const paths = Array.from({ length: 2000 }, (_, index) => join(directory, `${index}.mp4`));
    const hash = vi.fn<(_path: string) => Promise<string>>().mockResolvedValue('original');
    const cache = new VerifiedMediaFiles(hash);
    const started = performance.now();
    const phases: Record<string, number> = {};
    try {
      for (let index = 0; index < paths.length; index += 32) await Promise.all(paths.slice(index, index + 32).map(path => writeFile(path, 'original')));
      phases.createdMs = performance.now() - started;
      // 与正式素材检查相同的四路有界并发，保持全部 2000 个文件、三轮和摘要次数断言。
      for (let round = 0; round < 3; round++) {
        for (let index = 0; index < paths.length; index += 4) {
          const results = await Promise.all(paths.slice(index, index + 4).map(path => cache.verify(path, 'original')));
          expect(results.every(Boolean)).toBe(true);
        }
        phases[`round${round}Ms`] = performance.now() - started;
      }
      expect(hash).toHaveBeenCalledTimes(2000);
      const tiny = new VerifiedMediaFiles(hash, 1, 4096);
      await tiny.verify(paths[0]!, 'original'); await tiny.verify(paths[1]!, 'original'); await tiny.verify(paths[0]!, 'original');
      expect(hash).toHaveBeenCalledTimes(2003);
      const noBudget = new VerifiedMediaFiles(hash, 8192, 1);
      await noBudget.verify(paths[0]!, 'original'); await noBudget.verify(paths[0]!, 'original');
      expect(hash).toHaveBeenCalledTimes(2005);
    } finally {
      for (let index = 0; index < paths.length; index += 32) await Promise.all(paths.slice(index, index + 32).map(path => unlink(path)));
      await rmdir(directory);
      phases.finishedMs = performance.now() - started;
      console.info('素材校验负载阶段耗时', JSON.stringify(phases));
    }
  }, 180_000);
  // Real files on disk; Windows CI disks with scanning need more than the default 5 s.
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
  }, 20000);
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
