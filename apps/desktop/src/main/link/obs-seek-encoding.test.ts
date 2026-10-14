import { describe, expect, it } from 'vitest';
import { obsSeekEncoding } from './obs-seek-encoding';

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
  it.each(['', 'unknown format', 'yuv420p\n'])('拒绝不完整的格式报告 %j', format => {
    expect(() => obsSeekEncoding(format)).toThrow('像素格式');
  });
});
