import { expect, it } from 'vitest';
import { audioErrorMessage } from './audio-error';

it('声卡设备丢失说成看得懂的话，并保留错误码；断流不再是停歌的错误（2026-11-10 第 2 题）', () => {
  expect(audioErrorMessage(-2004287464)).toBe('Windows 音频错误 -2004287464');
  expect(audioErrorMessage(-2004287484)).toContain('声卡输出设备不见了');
  expect(audioErrorMessage(-2147024809)).toBe('Windows 音频错误 -2147024809');
});
