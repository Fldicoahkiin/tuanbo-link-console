import { describe, expect, it, vi } from 'vitest';
import { MediaMetadataProbe, parseDurationMs, parseVideoDimensions } from './media-metadata-probe';

const VIDEO_OUTPUT = `
  Duration: 00:01:02.345, start: 0.000000, bitrate: 8000 kb/s
  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps
`;

describe('MediaMetadataProbe', () => {
  it('从 FFmpeg 输出读取精确时长与画面尺寸', async () => {
    const execute = vi.fn(() => Promise.resolve(VIDEO_OUTPUT));
    const probe = new MediaMetadataProbe(execute, () => 'ffmpeg.exe');

    await expect(probe.inspect('C:\\media\\clip.mkv', 'video')).resolves.toEqual({
      durationMs: 62_345,
      width: 1_920,
      height: 1_080
    });
    expect(execute).toHaveBeenCalledWith('ffmpeg.exe', expect.arrayContaining(['-i', 'C:\\media\\clip.mkv', '-t', '0']));
  });

  it('缺少媒体类型所需字段时明确拒绝', async () => {
    const audioProbe = new MediaMetadataProbe(() => Promise.resolve('Duration: N/A\nStream #0:0: Audio: pcm_s16le'), () => 'ffmpeg');
    const imageProbe = new MediaMetadataProbe(() => Promise.resolve('Duration: N/A\nStream #0:0: Video: png'), () => 'ffmpeg');
    await expect(audioProbe.inspect('broken.wav', 'audio')).rejects.toThrow('媒体时长');
    await expect(imageProbe.inspect('broken.png', 'image')).rejects.toThrow('画面尺寸');
  });

  it('解析器忽略十六进制编解码标签并支持长时素材', () => {
    expect(parseDurationMs('Duration: 101:02:03.004')).toBe(363_723_004);
    expect(parseVideoDimensions('Stream #0:0: Video: h264 (avc1 / 0x31637661), yuv420p, 1080x1920, 30 fps')).toEqual({ width: 1080, height: 1920 });
  });
});
