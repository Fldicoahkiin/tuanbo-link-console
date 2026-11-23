import { describe, expect, it } from 'vitest';
import { MA2_EDIT_ORDER_UNKNOWN, ma2ConflictWinner, ma2LatestChoiceText, ma2LatestSide } from './ma2-latest-edit';

// 2026-11-11 用户：“矛盾的时候采用最新的”。联动台的改动按改的时间算，控台的改动按联动台第一次看到它的时间算。
describe('两边都改了同一个点，用最新的', () => {
  it('手动核对只用能证明先后的时间，两次观察之间双方都改过则保留选择', () => {
    const observed = { localEditedAt: 200, consoleSeenAt: 300 };
    expect(() => ma2ConflictWinner(observed, { lastConfirmedAt: 100 })).toThrow(MA2_EDIT_ORDER_UNKNOWN);
    expect(ma2ConflictWinner(observed, { lastConfirmedAt: 250 })).toBe('remote');
    expect(ma2ConflictWinner({ localEditedAt: 350, consoleSeenAt: 300 }, {})).toBe('local');
    expect(ma2ConflictWinner(observed, { choice: 'local' })).toBe('local');
    expect(ma2ConflictWinner(observed, { choice: 'remote' })).toBe('remote');
    expect(() => ma2ConflictWinner({ localEditedAt: undefined, consoleSeenAt: 300 }, {})).toThrow(MA2_EDIT_ORDER_UNKNOWN);
    expect(ma2LatestChoiceText('Timecode 3', 1, 'local', true)).toContain('按你的选择');
  });
  it('联动台改得更晚：用联动台的', () => {
    expect(ma2LatestSide({ localEditedAt: 2000, consoleSeenAt: 1000 })).toBe('local');
  });
  it('控台上的改动更晚才看到：用控台的', () => {
    expect(ma2LatestSide({ localEditedAt: 1000, consoleSeenAt: 2000 })).toBe('remote');
  });
  it('联动台改动的时间不知道（重启后从文件里打开的没同步的改动）：算更早，用控台的', () => {
    expect(ma2LatestSide({ localEditedAt: undefined, consoleSeenAt: 0 })).toBe('remote');
  });
  it('看到控台改动的同一刻联动台也改了：控台是在看到之前改的，用联动台的', () => {
    expect(ma2LatestSide({ localEditedAt: 1500, consoleSeenAt: 1500 })).toBe('local');
  });
  it('状态和运行日志写明用了哪一边', () => {
    expect(ma2LatestChoiceText('Timecode 63', 2, 'remote')).toBe('Timecode 63 有 2 处两边都改过，按最新的用了控台上的');
    expect(ma2LatestChoiceText('Timecode 63', 1, 'local')).toBe('Timecode 63 有 1 处两边都改过，按最新的用了联动台上的');
  });
});
