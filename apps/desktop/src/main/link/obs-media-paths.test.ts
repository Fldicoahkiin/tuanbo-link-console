import { beforeEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { includesObsMediaPath, obsMediaCachePaths, verifyRelocatedObsMediaPath } from './obs-media-paths';

const files = vi.hoisted(() => ({ checksums: new Map<string, string>(), digests: new Map<string, string>() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn((path: string) => {
  const value = files.checksums.get(path);
  if (value === undefined) return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  return Promise.resolve(value);
}) }));
vi.mock('./link-project-service', () => ({ hashFile: vi.fn() }));
vi.mock('./verified-media-files', () => ({ VerifiedMediaFiles: class {
  verify(path: string, expected: string): Promise<boolean> { return Promise.resolve(files.digests.get(path) === expected); }
} }));
beforeEach(() => { files.checksums.clear(); files.digests.clear(); });

const digest = 'a'.repeat(64), cacheDigest = 'b'.repeat(64);
const source = join('D:/moved', 'assets', `${digest}.mp4`);
const caches = obsMediaCachePaths('D:/moved/show.tblink', digest);
const previous = join('C:/original', 'cache', 'obs-seek-jpeg2000', `${digest}.source-pixels.mkv`);

it('Windows 路径大小写和分隔符不造成错误的来源冲突；其他文件仍不匹配', () => {
  expect(includesObsMediaPath(['C:\\Show\\assets\\Video.mp4'], 'c:/show/assets/video.mp4')).toBe(true);
  expect(includesObsMediaPath(['C:/Show/assets/Video.mp4'], 'C:/Other/assets/Video.mp4')).toBe(false);
  expect(caches).toContain(join('D:/moved', 'cache', 'obs-seek-jpeg2000', `${digest}.seek-intra.mkv`));
  expect(caches).toContain(join('D:/moved', 'cache', 'obs-seek-jpeg2000', `${digest}.seek-ready.mkv`));
});

it('迁移工程：原素材核验一致、旧缓存与自身校验文件一致才允许重新绑定', async () => {
  files.checksums.set(`${previous}.sha256`, cacheDigest);
  files.digests.set(source, digest); files.digests.set(previous, cacheDigest);
  await expect(verifyRelocatedObsMediaPath(previous, source, digest, caches)).resolves.toBe(true);
  files.digests.set(previous, 'c'.repeat(64));
  await expect(verifyRelocatedObsMediaPath(previous, source, digest, caches)).resolves.toBe(false);
  files.digests.set(previous, cacheDigest); files.digests.set(source, 'c'.repeat(64));
  await expect(verifyRelocatedObsMediaPath(previous, source, digest, caches)).resolves.toBe(false);
  files.digests.set(source, digest); files.checksums.delete(`${previous}.sha256`);
  await expect(verifyRelocatedObsMediaPath(previous, source, digest, caches)).resolves.toBe(false);
});

it('工程复制后重新生成的缓存字节不同，仍可改绑到同一素材的旧缓存（2026-10-19 现场）', async () => {
  // 两次独立生成的 seek-intra.mkv 校验值不同；新副本的缓存可能已存在也可能尚未生成。
  const field = join('D:/团播联动台工程/工程资料/reference-audio', 'cache', 'obs-seek-jpeg2000', `${digest}.seek-intra.mkv`);
  const copy = obsMediaCachePaths('D:/团播联动台工作数据/claude-验证-20261019/11111-副本/11111 联动工程.tblink', digest);
  files.checksums.set(`${field}.sha256`, cacheDigest); files.checksums.set(`${copy[4]!}.sha256`, 'd'.repeat(64));
  files.digests.set(source, digest); files.digests.set(field, cacheDigest);
  await expect(verifyRelocatedObsMediaPath(field, source, digest, copy)).resolves.toBe(true);
});

it('拒绝另一素材、非缓存目录和未核验的同名原始文件', async () => {
  await expect(verifyRelocatedObsMediaPath('C:/other/video.mp4', source, digest, caches)).resolves.toBe(false);
  await expect(verifyRelocatedObsMediaPath(`C:/other/${digest}.source-pixels.mkv`, source, digest, caches)).resolves.toBe(false);
  const original = join('C:/original', 'assets', `${digest}.mp4`);
  files.digests.set(source, digest); files.digests.set(original, digest);
  await expect(verifyRelocatedObsMediaPath(original, source, digest, caches)).resolves.toBe(true);
  files.digests.set(source, 'c'.repeat(64));
  await expect(verifyRelocatedObsMediaPath(original, source, digest, caches)).resolves.toBe(false);
});
