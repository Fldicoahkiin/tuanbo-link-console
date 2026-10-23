import { describe, expect, it } from 'vitest';
import { WindowLogRate } from './window-log-rate';

describe('WindowLogRate', () => {
  it('窗口日志允许 200 条突发，之后按每秒 20 条恢复；超出时明确拒绝', () => {
    let now = 0;
    const rate = new WindowLogRate(() => now);
    for (let index = 0; index < 200; index++) rate.take();
    expect(() => rate.take()).toThrow('窗口日志写入过于频繁');
    now += 1000;
    for (let index = 0; index < 20; index++) rate.take();
    expect(() => rate.take()).toThrow('窗口日志写入过于频繁');
    now += 60_000;
    for (let index = 0; index < 200; index++) rate.take();
    expect(() => rate.take()).toThrow('窗口日志写入过于频繁');
  });
});
