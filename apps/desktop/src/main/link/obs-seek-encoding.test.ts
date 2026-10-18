import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { obsSeekEncoding } from './obs-seek-encoding';
import { LinkProjectService } from './link-project-service';
import { MediaPreviewService } from './media-preview-service';

describe('无损定位缓存编码选择', () => {
  it('软件解码预算不再生成需要大量 CPU 的 HEVC，保留同样原始像素', () => {
    expect(obsSeekEncoding('yuv420p', 'software')).toEqual(['-c:v', 'utvideo', '-pix_fmt', '+', '-vf', 'tpad=stop_mode=clone:stop=32', '-fps_mode', 'passthrough', '-threads', '2']);
  });
  it('常见 4:2:0 使用可硬解的全帧内无损 HEVC，编码不依赖显卡', () => {
    expect(obsSeekEncoding('yuv420p')).toEqual(['-c:v', 'libx265', '-preset', 'ultrafast',
      '-x265-params', 'lossless=1:keyint=1:bframes=0:pools=2:frame-threads=1',
      '-pix_fmt', '+', '-vf', 'tpad=stop_mode=clone:stop=32', '-fps_mode', 'passthrough', '-threads', '2']);
  });
  it.each(['yuv422p', 'yuv444p', 'gbrp', 'gbrap'])('为 %s 选择无损帧内编码和片尾解码余量，不降像素格式', format => {
    expect(obsSeekEncoding(format)).toEqual(['-c:v', 'utvideo', '-pix_fmt', '+', '-vf', 'tpad=stop_mode=clone:stop=32', '-fps_mode', 'passthrough', '-threads', '2']);
  });
  it.each(['yuv420p10le', 'yuv444p16le', 'bgra', 'yuva444p10le'])('为 %s 保留原位深与透明度编码', format => {
    expect(obsSeekEncoding(format)).toEqual(['-c:v', 'ffv1', '-level', '3', '-g', '1', '-pix_fmt', '+', '-vf', 'tpad=stop_mode=clone:stop=32', '-fps_mode', 'passthrough', '-threads', '2']);
  });
  it.each(['argb', 'rgba', 'abgr'])('%s 透明素材重排为 bgra 后用 FFV1 编码', format => {
    for (const decode of ['hardware', 'software'] as const) {
      expect(obsSeekEncoding(format, decode)).toEqual(['-c:v', 'ffv1', '-level', '3', '-g', '1', '-pix_fmt', 'bgra', '-vf', 'tpad=stop_mode=clone:stop=32', '-fps_mode', 'passthrough', '-threads', '2']);
    }
  });
  it.each(['rgb24', 'bgr24', '0rgb', 'rgb0', '0bgr'])('%s 不透明素材重排为平面 gbrp 后用 Ut Video 编码', format => {
    for (const decode of ['hardware', 'software'] as const) {
      expect(obsSeekEncoding(format, decode)).toEqual(['-c:v', 'utvideo', '-pix_fmt', 'gbrp', '-vf', 'tpad=stop_mode=clone:stop=32', '-fps_mode', 'passthrough', '-threads', '2']);
    }
  });
  it.each([['argb', 'ffv1 .*bgra'], ['rgb24', 'utvideo .*gbrp']])('真实 FFmpeg：QuickTime Animation 的 %s 素材生成定位缓存，原帧像素逐帧一致', async (format, codec) => {
    // 2026-10-16 现场：扑克牌特效.mov（qtrle/argb）让 FFV1 拒绝编码，整条 OBS 画面链路未启动。
    if (!ffmpegPath) throw new Error('测试缺少 FFmpeg');
    const root = await mkdtemp(join(tmpdir(), 'tblink-argb-seek-'));
    try {
      const media = join(root, 'assets', 'reference-media'); await mkdir(media, { recursive: true });
      const source = join(media, 'overlay.mov');
      await promisify(execFile)(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=30:d=0.4',
        '-vf', `format=${format}${format === 'argb' ? ',colorchannelmixer=aa=0.5' : ''}`, '-c:v', 'qtrle', '-pix_fmt', format, source]);
      const sha256 = createHash('sha256').update(await readFile(source)).digest('hex');
      const service = new MediaPreviewService(new LinkProjectService());
      const frames = async (file: string): Promise<string[]> => (await promisify(execFile)(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-i', file,
        '-map', '0:v:0', '-pix_fmt', 'argb', '-f', 'framemd5', '-'], { maxBuffer: 16 * 1024 * 1024 })).stdout.split('\n')
        .filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1)!.trim());
      const original = await frames(source);
      expect(original).toHaveLength(12);
      for (const decode of ['hardware', 'software'] as const) {
        const cache = await service.ensureObsSeekVideo(join(root, 'show.tblink'), 'assets/reference-media/overlay.mov', sha256, decode);
        const probe = (await promisify(execFile)(ffmpegPath, ['-hide_banner', '-i', cache]).catch((error: { stderr: string }) => error)).stderr;
        expect(probe).toMatch(new RegExp(`Video: ${codec}`));
        // tpad appends clone frames after the original duration; the original frames must match exactly.
        expect((await frames(cache)).slice(0, original.length)).toEqual(original);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
  it.each(['', 'unknown format', 'yuv420p\n'])('拒绝不完整的格式报告 %j', format => {
    expect(() => obsSeekEncoding(format)).toThrow('像素格式');
  });
});
