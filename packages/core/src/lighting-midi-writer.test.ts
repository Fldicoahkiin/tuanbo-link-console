import { expect, it } from 'vitest';
import { parseMidi, writeMidi, type MidiEvent } from 'midi-file';
import { writeLightingMidi } from './lighting-midi-writer';

it('十万控制事件跨分块保存增量时间和数据，只有一个轨道结束事件', () => {
  const events: MidiEvent[] = Array.from({ length: 100000 }, (_, index) => ({ deltaTime: 240, type: 'controller', channel: index % 16, controllerType: 7, value: index % 128, running: true }));
  events.push({ deltaTime: 0, type: 'endOfTrack' });
  const midi = parseMidi(writeLightingMidi([events], 960));
  expect(midi.header).toMatchObject({ format: 1, numTracks: 1, ticksPerBeat: 960 });
  expect(midi.tracks[0]).toHaveLength(100001);
  for (const index of [0, 255, 256, 257, 511, 512, 99999]) expect(midi.tracks[0]![index]).toMatchObject({ deltaTime: 240, type: 'controller', channel: index % 16, value: index % 128 });
  expect(midi.tracks[0]!.filter((event) => event.type === 'endOfTrack')).toHaveLength(1);
});
it('普通文件编码与原编码器一致，非法大间隔在编码前拒绝', () => {
  const tracks: MidiEvent[][] = [[{ deltaTime: 0, type: 'trackName', text: 'MIDI' }, { deltaTime: 960, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 }, { deltaTime: 1920, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 64 }, { deltaTime: 0, type: 'endOfTrack' }]];
  expect(writeLightingMidi(tracks, 960)).toEqual(Uint8Array.from(writeMidi({ header: { format: 1, numTracks: 1, ticksPerBeat: 960 }, tracks }, { running: false })));
  for (const deltaTime of [-1, 0.5, 0x10000000, 0x80000000, Infinity]) expect(() => writeLightingMidi([[{ type: 'endOfTrack', deltaTime }]], 960)).toThrow('事件间隔');
});
