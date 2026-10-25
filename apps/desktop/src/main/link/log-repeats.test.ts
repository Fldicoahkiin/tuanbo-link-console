import { describe, expect, it } from 'vitest';
import { LogRepeats } from './log-repeats';

const fault = { level: 'error', category: 'device', device: 'MA2', message: '歌曲同步停止：连接已断开', result: 'failed' } as const;
const limits = { windowMs: 60_000, maxWindowMs: 600_000, keep: 3, maxKeys: 500 };

describe('LogRepeats', () => {
  it('同一窗口内前三条照常写入，之后只计数，窗口结束写一条合并记录', () => {
    const repeats = new LogRepeats(limits);
    const decisions = Array.from({ length: 10 }, (_, index) => repeats.admit({ ...fault, details: { attempt: index } }, index * 1000));
    expect(decisions).toEqual(['write', 'write', 'write', 'merge', 'merge', 'merge', 'merge', 'merge', 'merge', 'merge']);
    expect(repeats.settle(30_000)).toEqual([]);
    expect(repeats.nextDue()).toBe(60_000);
    const [summary] = repeats.settle(60_000);
    expect(summary?.message).toBe('歌曲同步停止：连接已断开（在 6 秒内又重复 7 次，已合并为本条）');
    expect(summary?.details).toEqual({ repeat: { merged: 7, firstAt: new Date(3000).toISOString(), lastAt: new Date(9000).toISOString(), continuing: false },
      lastDetails: { attempt: 9 } });
    expect(summary).toMatchObject({ level: 'error', category: 'device', device: 'MA2', result: 'failed' });
    expect(repeats.settle(61_000)).toEqual([]);
  });

  it('不同消息、设备、节目或结果互不合并；细节不同仍算同一条', () => {
    const repeats = new LogRepeats(limits);
    for (let index = 0; index < 3; index++) repeats.admit(fault, index);
    expect(repeats.admit({ ...fault, details: { other: true } }, 10)).toBe('merge');
    expect(repeats.admit({ ...fault, message: '另一条' }, 10)).toBe('write');
    expect(repeats.admit({ ...fault, device: 'obs' }, 10)).toBe('write');
    expect(repeats.admit({ ...fault, itemId: 'song-2' }, 10)).toBe('write');
    expect(repeats.admit({ ...fault, result: 'succeeded' }, 10)).toBe('write');
    expect(repeats.admit({ ...fault, level: 'warning' }, 10)).toBe('write');
  });

  it('一直重复的故障之后只写合并记录，窗口翻倍到十分钟为止', () => {
    const repeats = new LogRepeats(limits);
    const written: number[] = []; const summaries: number[] = [];
    for (let second = 0; second < 3600; second++) {
      const now = second * 1000;
      summaries.push(...repeats.settle(now).map(() => now));
      if (repeats.admit(fault, now) === 'write') written.push(now);
    }
    expect(written).toEqual([0, 1000, 2000]);
    // 60 s, then 120, 240, 480 and 600 s windows: the first summaries at 1, 3, 7 and 15 minutes, then every 10.
    expect(summaries.slice(0, 5)).toEqual([60_000, 180_000, 420_000, 900_000, 1_500_000]);
    expect(summaries.length).toBeLessThan(10);
  });

  it('停顿超过一个窗口后重新开始，再写前三条', () => {
    const repeats = new LogRepeats(limits);
    for (let index = 0; index < 5; index++) repeats.admit(fault, index * 1000);
    expect(repeats.settle(60_000)).toHaveLength(1);
    expect(repeats.admit(fault, 200_000)).toBe('write');
  });

  it('查询或退出前可立即写出尚未到期的合并记录，之后的重复另计', () => {
    const repeats = new LogRepeats(limits);
    for (let index = 0; index < 5; index++) repeats.admit(fault, index * 1000);
    expect(repeats.settle(5000, true).map(entry => entry.message)).toEqual(['歌曲同步停止：连接已断开（在 1 秒内又重复 2 次，已合并为本条）']);
    expect(repeats.admit(fault, 6000)).toBe('merge');
    expect(repeats.settle(60_000).map(entry => entry.message)).toEqual(['歌曲同步停止：连接已断开（又重复 1 次，已合并为本条）']);
  });

  it('表满时先清掉没有待写合并记录的旧条目，待写的不会丢', () => {
    const repeats = new LogRepeats({ ...limits, maxKeys: 3 });
    for (let index = 0; index < 4; index++) repeats.admit(fault, index);
    repeats.admit({ ...fault, message: 'b' }, 10);
    repeats.admit({ ...fault, message: 'c' }, 10);
    repeats.admit({ ...fault, message: 'd' }, 10);
    repeats.admit({ ...fault, message: 'e' }, 10);
    expect(repeats.settle(10, true).map(entry => entry.message)).toEqual(['歌曲同步停止：连接已断开（又重复 1 次，已合并为本条）']);
  });
});
