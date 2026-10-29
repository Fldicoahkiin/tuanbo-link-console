import { describe, expect, it } from 'vitest';
import { decodeToleranceFrames, playableEndMs, rangeRejectedMessage } from './native-playback-range';

describe('播放范围按实际音频对齐', () => {
  it('结尾没超过音频时原样播放', () => {
    expect(playableEndMs({ startMs: 0, endMs: 27000, availableMs: 27466.7, frameRate: 30 })).toBe(27000);
  });

  it('P1 小数结尾比缓存音频多出不到 1 帧时，播到音频结尾为止（0.5.4 第二次播放报 -2147024809）', () => {
    // 27466.7 ms at 44.1 kHz is frame 1211281.47; the cache holds 1211280 frames.
    const availableMs = 1211280 * 1000 / 44100;
    const endMs = playableEndMs({ startMs: 0, endMs: 27466.7, availableMs, frameRate: 30 });
    expect(endMs).toBe(availableMs);
    // The engine rounds to frames and accepts an end that is not past the cached PCM.
    expect(Math.round(endMs * 44100 / 1000)).toBe(1211280);
  });

  it('边解码边播时按解码允许的最短长度算，结尾前不会读空', () => {
    const rate = 44100, expectedFrames = Math.ceil(24666.699999999997 * rate / 1000);
    const availableMs = (expectedFrames - decodeToleranceFrames(rate)) * 1000 / rate;
    const endMs = playableEndMs({ startMs: 1000, endMs: 24666.699999999997, availableMs, frameRate: 25 });
    expect(endMs).toBeCloseTo(availableMs, 9);
    expect(24666.699999999997 - endMs).toBeLessThan(2);
  });

  it('差了不止 1 帧就报出两个时间，不悄悄截短', () => {
    expect(() => playableEndMs({ startMs: 0, endMs: 30000, availableMs: 29900, frameRate: 30 }))
      .toThrow('这首歌要播到 30.000 秒，但解码出的音频只有 29.900 秒');
  });

  it('起点已经在音频之后时报错', () => {
    expect(() => playableEndMs({ startMs: 10000, endMs: 10010, availableMs: 10000, frameRate: 30 })).toThrow('解码出的音频只有 10.000 秒');
  });

  it('解码允许短约 1 毫秒', () => {
    expect(decodeToleranceFrames(44100)).toBe(44);
    expect(decodeToleranceFrames(48000)).toBe(48);
  });

  it('引擎拒绝时把范围写清楚', () => {
    expect(rangeRejectedMessage({ startMs: 0, endMs: 27466.7, availableMs: 27466.67, streaming: false, code: -2147024809 }))
      .toBe('播放引擎没有接受这段播放范围：从 0.000 秒播到 27.467 秒，音频有 27.467 秒（用已解码的缓存，错误码 -2147024809）。请重新播放；还是不行请导出诊断包发给售后');
  });
});
