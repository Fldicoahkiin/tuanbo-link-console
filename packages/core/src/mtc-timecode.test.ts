import { describe, expect, it } from 'vitest';
import type { MtcFrameRate, SmpteTimecode } from '@tb/schema';
import {
  MtcQuarterFrameDecoder,
  formatMtcOffset,
  parseMtcOffset,
  frameNumberToTimecode,
  millisecondsToFrameNumber,
  timecodeToFrameNumber,
  timecodeToMilliseconds
} from './mtc-timecode';
import { encodeMediaTimecode } from './mtc-output';

describe('MTC timecode', () => {
  it.each(['24', '25', '29.97df', '30'] as const)('偏移保存到毫秒后输出同一帧：%s', (rate) => {
    for (const input of ['00:00:00:01', '01:02:03:17', '00:10:00:00']) {
      const ms = parseMtcOffset(input, rate);
      expect(Number.isInteger(ms)).toBe(true);
      expect(formatMtcOffset(ms, rate)).toBe(input);
      const parts = input.split(':').map(Number);
      const bytes = encodeMediaTimecode(ms, rate).fullFrame;
      expect([bytes[5]! & 31, ...bytes.slice(6, 9)]).toEqual(parts);
    }
  });
  it('拒绝格式、帧范围及 DF 跳过的帧号', () => {
    for (const input of ['', '1:00:00:00', '24:00:00:00', '00:60:00:00', '00:00:60:00', '00:00:00:30']) expect(() => parseMtcOffset(input, '30')).toThrow();
    expect(() => parseMtcOffset('00:00:00:24', '24')).toThrow();
    expect(() => parseMtcOffset('00:00:00:25', '25')).toThrow();
    expect(() => parseMtcOffset('00:01:00:00', '29.97df')).toThrow();
    expect(formatMtcOffset(parseMtcOffset('00:01:00:02', '29.97df'), '29.97df')).toBe('00:01:00:02');
  });
  it.each([
    ['24', 23],
    ['25', 24],
    ['30', 29]
  ] as const)('round-trips %s fps', (rate, frames) => {
    const value = { hours: 1, minutes: 2, seconds: 3, frames };
    expect(frameNumberToTimecode(timecodeToFrameNumber(value, rate), rate)).toEqual(value);
  });

  it('round-trips 29.97 drop-frame after a ten-minute boundary', () => {
    const value = { hours: 1, minutes: 10, seconds: 0, frames: 0 };
    expect(frameNumberToTimecode(timecodeToFrameNumber(value, '29.97df'), '29.97df')).toEqual(value);
  });

  it('round-trips 29.97 drop-frame at a non-tenth minute boundary', () => {
    const value = { hours: 0, minutes: 1, seconds: 0, frames: 2 };
    expect(frameNumberToTimecode(timecodeToFrameNumber(value, '29.97df'), '29.97df')).toEqual(value);
  });

  it('使用 30000/1001 精确换算 29.97 drop-frame 的音频播放头', () => {
    const tenMinutesMs = 10 * 60 * 1_000;
    const frame = millisecondsToFrameNumber(tenMinutesMs, '29.97df');
    expect(frame).toBe(17_982);
    expect(frameNumberToTimecode(frame, '29.97df')).toEqual({ hours: 0, minutes: 10, seconds: 0, frames: 0 });
    expect(Math.abs(
      timecodeToMilliseconds({ hours: 0, minutes: 10, seconds: 0, frames: 0 }, '29.97df') - tenMinutesMs
    )).toBeLessThan(1);
  });

  it('decodes a forward quarter-frame cycle and compensates two frames', () => {
    const decoder = new MtcQuarterFrameDecoder();
    const pieces = [8, 0, 7, 0, 6, 0, 5, 6];
    let sample = null;
    for (const [type, value] of pieces.entries()) sample = decoder.push((type << 4) | value, type * 8);
    expect(sample).toMatchObject({
      frameRate: '30',
      timecode: { hours: 5, minutes: 6, seconds: 7, frames: 10 },
      direction: 'forward'
    });
  });

  it('rejects invalid MIDI data bytes', () => {
    expect(() => new MtcQuarterFrameDecoder().push(128, 0)).toThrow(/无效/);
  });

  it.each(['24', '25', '29.97df', '30'] as const)('decodes complete quarter-frame cycles at %s', (rate) => {
    const raw: SmpteTimecode = { hours: 1, minutes: 10, seconds: 2, frames: 3 };
    const decoder = new MtcQuarterFrameDecoder();
    let decoded = null;
    for (const [index, byte] of quarterFrameBytes(raw, rate).entries()) decoded = decoder.push(byte, index * 8);
    expect(decoded).toMatchObject({
      frameRate: rate,
      timecode: frameNumberToTimecode(timecodeToFrameNumber(raw, rate) + 2, rate),
      direction: 'forward'
    });
  });

  it('decodes reverse quarter-frame order and compensates backwards', () => {
    const raw: SmpteTimecode = { hours: 0, minutes: 0, seconds: 1, frames: 10 };
    const decoder = new MtcQuarterFrameDecoder();
    let decoded = null;
    for (const [index, byte] of [...quarterFrameBytes(raw, '30')].reverse().entries()) decoded = decoder.push(byte, index * 8);
    expect(decoded).toMatchObject({
      frameRate: '30',
      timecode: { hours: 0, minutes: 0, seconds: 1, frames: 8 },
      direction: 'reverse'
    });
  });

  it('rejects out-of-range and invalid drop-frame timecodes decoded from MTC', () => {
    expect(() => decodeCycle({ hours: 0, minutes: 63, seconds: 0, frames: 0 }, '30')).toThrow('无效时间码');
    expect(() => decodeCycle({ hours: 0, minutes: 1, seconds: 0, frames: 0 }, '29.97df')).toThrow('无效时间码');
  });
});

function decodeCycle(timecode: SmpteTimecode, frameRate: MtcFrameRate): void {
  const decoder = new MtcQuarterFrameDecoder();
  for (const [index, byte] of quarterFrameBytes(timecode, frameRate).entries()) decoder.push(byte, index * 8);
}

function quarterFrameBytes(timecode: SmpteTimecode, frameRate: MtcFrameRate): number[] {
  const rateCode = (['24', '25', '29.97df', '30'] as const).indexOf(frameRate);
  const pieces = [
    timecode.frames & 0x0f,
    (timecode.frames >> 4) & 0x01,
    timecode.seconds & 0x0f,
    (timecode.seconds >> 4) & 0x03,
    timecode.minutes & 0x0f,
    (timecode.minutes >> 4) & 0x03,
    timecode.hours & 0x0f,
    ((timecode.hours >> 4) & 0x01) | (rateCode << 1)
  ];
  return pieces.map((value, type) => (type << 4) | value);
}
