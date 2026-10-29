import { expect, it } from 'vitest';
import { audioErrorMessage } from './audio-error';

it('声卡断流和设备丢失说成看得懂的话，并保留错误码', () => {
  expect(audioErrorMessage(-2004287464)).toMatch(/^声音断了一下.*-2004287464.*重新播放/);
  expect(audioErrorMessage(-2004287484)).toContain('声卡输出设备不见了');
  expect(audioErrorMessage(-2147024809)).toBe('Windows 音频错误 -2147024809');
});
