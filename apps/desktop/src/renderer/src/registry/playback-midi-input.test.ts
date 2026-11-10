import { expect, it, vi } from 'vitest';
vi.mock('./midi-access', () => ({ requestMidiAccess: vi.fn() }));
import { toUserErrorMessage } from '@tb/core/link';
import { requestMidiAccess, type MidiAccess } from './midi-access';
import { PlaybackMidiInput } from './playback-midi-input';

const access: MidiAccess = { inputs: new Map(), outputs: new Map(), failure: null, onStateChange: () => () => undefined };

it('播放控制输入找不到时，接口名放在「」里，提示照原样显示（2026-11-10）', async () => {
  vi.mocked(requestMidiAccess).mockResolvedValue(access);
  const fail = vi.fn();
  const input = new PlaybackMidiInput(vi.fn(), fail);
  const text = await input.connect('USB MIDI INTERFACE').then(() => '', (error: unknown) => error instanceof Error ? error.message : String(error));
  expect(text).toBe('播放控制的 MIDI 输入「USB MIDI INTERFACE」找不到，或有多个同名端口');
  expect(toUserErrorMessage(new Error(text))).toBe(text);
  expect(fail).not.toHaveBeenCalled();
});
