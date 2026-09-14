import { describe, expect, it } from 'vitest';
import { encodeMediaTimecode } from './mtc-output';
import { MtcQuarterFrameDecoder } from './mtc-timecode';

describe('正式音频时间码编码', () => {
  it.each(['24', '25', '30'] as const)('%s fps 编解码逐字段一致', (rate) => {
    const decoder = new MtcQuarterFrameDecoder();
    const encoded = encodeMediaTimecode(3_723_000, rate);
    let sample = null;
    for (const [index, message] of encoded.quarterFrames.entries()) sample = decoder.push(message[1]!, index * 8);
    // Forward quarter-frame receivers compensate the two-frame transmission cycle.
    expect(sample).toMatchObject({ timecode: { hours: 1, minutes: 2, seconds: 3, frames: 2 }, frameRate: rate });
    expect(encoded.fullFrame.slice(0, 5)).toEqual([240, 127, 127, 1, 1]);
    expect(encoded.fullFrame.at(-1)).toBe(247);
  });
  it.each([-1, NaN, Infinity, 86_400_000])('拒绝无效音频位置 %s', (position) => {
    expect(() => encodeMediaTimecode(position, '30')).toThrow();
  });
});
