import { describe, expect, it, vi } from 'vitest';
import { WindowsMidiHealth, probeWindowsMidi, midiHealthMessage, type MidiHealth } from './windows-midi-health';

describe('MIDI 系统故障隔离', () => {
  it('系统枚举卡死与检测组件故障分别给出恢复建议', () => {
    expect(midiHealthMessage('timeout')).toContain('端口枚举未响应');
    expect(midiHealthMessage('failed')).toContain('检测组件运行失败');
    expect(midiHealthMessage('failed')).not.toContain('恢复系统 MIDI 服务');
  });
  it('并发权限请求共用一次检测，失败后不自动重试', async () => {
    let finish: (result: MidiHealth) => void = () => { throw new Error('检测尚未开始'); };
    const probe = vi.fn(() => new Promise<MidiHealth>((resolve) => { finish = resolve; }));
    const health = new WindowsMidiHealth(probe);
    const first = health.check();
    expect(health.check()).toBe(first);
    finish('timeout');
    await expect(first).resolves.toBe('timeout');
    await expect(health.check()).resolves.toBe('timeout');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('显式重新检测可从故障恢复，健康结果由后续权限请求复用', async () => {
    const probe = vi.fn<() => Promise<MidiHealth>>().mockResolvedValueOnce('failed').mockResolvedValueOnce('ready');
    const health = new WindowsMidiHealth(probe);
    await expect(health.check()).resolves.toBe('failed');
    await expect(health.check(true)).resolves.toBe('ready');
    await expect(health.check()).resolves.toBe('ready');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('检测组件不存在时返回失败，不放行 Chromium MIDI', async () => {
    await expect(probeWindowsMidi('C:/missing-tblink-midi-test/probe.exe')).resolves.toBe('failed');
  });
});
