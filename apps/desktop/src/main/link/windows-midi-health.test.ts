import { describe, expect, it, vi } from 'vitest';
import { WindowsMidiHealth, probeWindowsMidi, midiHealthMessage, type MidiHealth } from './windows-midi-health';

describe('MIDI 系统故障隔离', () => {
  it('系统枚举卡死与检测组件故障分别给出恢复建议', () => {
    expect(midiHealthMessage('timeout')).toContain('读取 MIDI 端口没有响应');
    expect(midiHealthMessage('stopping')).toContain('Windows MIDI 服务正在停止');
    expect(midiHealthMessage('failed')).toContain('检测组件运行失败');
    expect(midiHealthMessage('failed')).not.toContain('恢复系统 MIDI 服务');
  });

  it('服务停止中不反复探测；恢复后仅由明确重新检测放行', async () => {
    const probe = vi.fn<() => Promise<MidiHealth>>().mockResolvedValueOnce('stopping').mockResolvedValueOnce('ready');
    const health = new WindowsMidiHealth(probe);
    await expect(health.check()).resolves.toBe('stopping');
    await expect(health.check()).resolves.toBe('stopping');
    expect(probe).toHaveBeenCalledTimes(1);
    await expect(health.check(true)).resolves.toBe('ready');
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

  it('恢复后再次访问 MIDI 重新核对系统，不能永远沿用启动时的健康状态', async () => {
    const probe = vi.fn<() => Promise<MidiHealth>>().mockResolvedValueOnce('failed').mockResolvedValueOnce('ready').mockResolvedValueOnce('stopping');
    const health = new WindowsMidiHealth(probe);
    await expect(health.check()).resolves.toBe('failed');
    await expect(health.check(true)).resolves.toBe('ready');
    await expect(health.check()).resolves.toBe('stopping');
    await expect(health.check()).resolves.toBe('stopping');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('检测组件不存在时返回失败，不放行 Chromium MIDI', async () => {
    await expect(probeWindowsMidi('C:/missing-tblink-midi-test/probe.exe')).resolves.toBe('failed');
  });
});
