import type { LinkProject, MtcFrameRate } from '@tb/schema';
import { frameNumberToTimecode, playbackFramesPerSecond } from './mtc-timecode';

export function allocateMediaTimecodeRanges(project: LinkProject): Array<{ itemId: string; startSeconds: number; durationMs: number }> {
  let startSeconds = 60;
  return project.rundown.flatMap((item) => {
    if (!item.referenceAudio) return [];
    const range = { itemId: item.id, startSeconds, durationMs: item.referenceAudio.durationMs };
    startSeconds += Math.ceil(range.durationMs / 1000) + 10;
    if (startSeconds >= 86_400) throw new Error('内部主控节目单与间隔总时长必须小于 24 小时，请拆分工程');
    return [range];
  });
}

export function mediaTimecodeAt(positionMs: number, rate: MtcFrameRate) {
  if (!Number.isFinite(positionMs) || positionMs < 0) throw new Error('音频位置无效');
  if (positionMs >= 86_400_000) throw new Error('MIDI 时间码超出 24 小时');
  const tc = frameNumberToTimecode(Math.floor(positionMs / 1000 * playbackFramesPerSecond(rate)), rate);
  if (tc.hours >= 24) throw new Error('MIDI 时间码超出 24 小时');
  return tc;
}

export function encodeMediaTimecode(positionMs: number, rate: MtcFrameRate): { fullFrame: number[]; quarterFrames: number[][] } {
  const tc = mediaTimecodeAt(positionMs, rate);
  const code = rate === '24' ? 0 : rate === '25' ? 1 : rate === '29.97df' ? 2 : 3;
  const values = [tc.frames & 15, tc.frames >> 4, tc.seconds & 15, tc.seconds >> 4,
    tc.minutes & 15, tc.minutes >> 4, tc.hours & 15, (tc.hours >> 4) | (code << 1)];
  return {
    fullFrame: [0xf0, 0x7f, 0x7f, 1, 1, tc.hours | (code << 5), tc.minutes, tc.seconds, tc.frames, 0xf7],
    quarterFrames: values.map((value, index) => [0xf1, (index << 4) | value])
  };
}
