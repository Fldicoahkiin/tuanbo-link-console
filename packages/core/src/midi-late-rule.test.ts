import { describe, expect, it } from 'vitest';
import { MIDI_LATE_LIMIT_MS, midiLateVerdict, midiMessageKind } from './midi-late-rule';
import { midiMessageNeedsLicense } from './midi-program';

const msc = (command: number) => [0xf0, 0x7f, 1, 0x02, 0x01, command, 0x31, 0xf7];

describe('动作 MIDI 按字节分类', () => {
  it('PC、CC 是状态；Note On、MSC Go 和其他 MSC、SysEx 是按一下；Note Off、MSC Stop 是收尾', () => {
    expect([[0xc3, 9], [0xb0, 7, 64]].map(midiMessageKind)).toEqual(['state', 'state']);
    expect([[0x90, 60, 100], [0x90, 60, 0], msc(0x01), msc(0x03), msc(0x05), [0xf0, 0x43, 0x10, 0xf7], [0xe0, 0, 64], []].map(midiMessageKind))
      .toEqual(Array(8).fill('press'));
    expect([[0x80, 60, 0], [0x8f, 1, 2], msc(0x02)].map(midiMessageKind)).toEqual(['release', 'release', 'release']);
  });

  it('收尾类就是免授权的停止类，两条规则说的是同一组消息', () => {
    for (const bytes of [[0xc3, 9], [0xb0, 7, 64], [0x90, 60, 100], [0x90, 60, 0], msc(0x01), msc(0x02), [0x80, 60, 0], [0xf0, 0x43, 0xf7]]) {
      expect(midiMessageNeedsLicense(bytes)).toBe(midiMessageKind(bytes) !== 'release');
    }
  });
});

describe('晚了怎么办', () => {
  it('按一下：晚不到 100 ms 照发，截止在应发时刻后 100 ms；晚 100 ms 以上跳过', () => {
    expect(midiLateVerdict([0x90, 60, 100], 1000, 1099)).toEqual({ send: true, kind: 'press', lateMs: 99, deadlineAtMs: 1100, markLate: false });
    expect(midiLateVerdict([0x90, 60, 100], 1000, 1000 + MIDI_LATE_LIMIT_MS)).toEqual({ send: false, kind: 'press', lateMs: 100 });
    expect(midiLateVerdict(msc(0x01), 1000, 1150).send).toBe(false);
  });

  it('状态：晚多少都发，晚 100 ms 以上标红；截止时间从交出时起 1 秒', () => {
    expect(midiLateVerdict([0xc0, 1], 1000, 1050)).toEqual({ send: true, kind: 'state', lateMs: 50, deadlineAtMs: 2050, markLate: false });
    expect(midiLateVerdict([0xb0, 7, 1], 1000, 3000)).toEqual({ send: true, kind: 'state', lateMs: 2000, deadlineAtMs: 4000, markLate: true });
  });

  it('收尾：总是发，不标红；截止时间至少在交出后 100 ms', () => {
    expect(midiLateVerdict([0x80, 60, 0], 1000, 5000)).toEqual({ send: true, kind: 'release', lateMs: 4000, deadlineAtMs: 5100, markLate: false });
    expect(midiLateVerdict(msc(0x02), 1000, 900)).toEqual({ send: true, kind: 'release', lateMs: 0, deadlineAtMs: 1100, markLate: false });
  });
});
