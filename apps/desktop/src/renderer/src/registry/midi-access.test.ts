import { afterEach, expect, it, vi } from 'vitest';
import { requestMidiAccess } from './midi-access';

afterEach(() => vi.unstubAllGlobals());

it('系统检测拒绝 MIDI 时给出可操作的中文提示', async () => {
  const error = new Error('Permission denied');
  error.name = 'NotAllowedError';
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.reject(error) });
  await expect(requestMidiAccess({ sysex: true })).rejects.toThrow('MIDI 设备检测没有通过');
});

it('保留其他 MIDI 错误供原有诊断处理', async () => {
  const error = new Error('驱动连接中断');
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.reject(error) });
  await expect(requestMidiAccess({ sysex: false })).rejects.toBe(error);
});
