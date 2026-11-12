import { describe, expect, it, vi } from 'vitest';
import { PreparationSteps, SLOW_PREPARATION_STEP_MS, aheadAudioLog, audioErrorLog } from './preparation-log';
import type { LinkLogInput } from './run-logger';

describe('PreparationSteps', () => {
  it('各步骤合成一份记录；明显偏慢的步骤当场单独报出', () => {
    const slow: [string, number][] = [];
    const steps = new PreparationSteps((step, ms) => slow.push([step, ms]));
    steps.add('设备检查', 12.4);
    steps.add('解码预填充', SLOW_PREPARATION_STEP_MS + 1);
    expect(slow).toEqual([['解码预填充', SLOW_PREPARATION_STEP_MS + 1]]);
    expect(steps.take()).toEqual([{ step: '设备检查', ms: 12 }, { step: '解码预填充', ms: SLOW_PREPARATION_STEP_MS + 1 }]);
    expect(steps.take()).toEqual([]);
  });
});

describe('audioErrorLog', () => {
  function setup() {
    const record = vi.fn<(entry: LinkLogInput) => Promise<unknown>>(() => Promise.resolve());
    const steps = new PreparationSteps(() => undefined);
    return { record, steps, log: audioErrorLog(steps, record) };
  }

  it('准备中途记下一首的事：单独一条，不带走这首走过的步骤，这首准备好的那条照样拿到全部步骤', () => {
    const { record, steps, log } = setup();
    steps.add('设备检查与旧播放清理', 12.4);
    log.preloadError('下一首提前准备的音频解码失败，播到这首时照常准备。原因：音频解码 30 秒没有进展，已停止解码');
    expect(record).toHaveBeenCalledExactlyOnceWith({ level: 'error', category: 'device', device: '音频',
      message: '下一首提前准备的音频解码失败，播到这首时照常准备。原因：音频解码 30 秒没有进展，已停止解码', result: 'failed' });
    steps.add('音源校验与解码预填充', 40);
    // What this song's 音频已准备好 entry takes.
    expect(steps.take()).toEqual([{ step: '设备检查与旧播放清理', ms: 12 }, { step: '音源校验与解码预填充', ms: 40 }]);
  });

  it('这首准备失败：这条带上它走过的步骤；下一次准备从头记，没有步骤的错误不带步骤', () => {
    const { record, steps, log } = setup();
    steps.add('设备检查与旧播放清理', 12.4);
    steps.add('音源校验与解码预填充', 40);
    log.error('选择的音频输出设备已断开，不会自动换到其他设备');
    expect(record).toHaveBeenLastCalledWith({ level: 'error', category: 'device', device: '音频',
      message: '选择的音频输出设备已断开，不会自动换到其他设备', result: 'failed',
      details: { steps: [{ step: '设备检查与旧播放清理', ms: 12 }, { step: '音源校验与解码预填充', ms: 40 }] } });
    expect(steps.take()).toEqual([]);
    log.error('音频引擎还没准备好');
    expect(record).toHaveBeenLastCalledWith({ level: 'error', category: 'device', device: '音频', message: '音频引擎还没准备好', result: 'failed' });
  });

  it('日志写不进去：两种都打印到控制台，不抛给播放器', async () => {
    const { record, steps, log } = setup();
    record.mockRejectedValue(new Error('磁盘已满'));
    const console = vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    try {
      steps.add('设备检查与旧播放清理', 12);
      expect(() => log.error('音频引擎还没准备好')).not.toThrow();
      expect(() => log.preloadError('下一首提前准备的音频解码失败，播到这首时照常准备。原因：音频解码 30 秒没有进展，已停止解码')).not.toThrow();
      await vi.waitFor(() => expect(console).toHaveBeenCalledTimes(2));
      expect(console.mock.calls).toEqual([['正式音频日志写入失败', expect.any(Error)], ['正式音频日志写入失败', expect.any(Error)]]);
    } finally { console.mockRestore(); }
  });
});

describe('aheadAudioLog', () => {
  it('每份提前准备各记各的：准备好时为它的歌写一条「下一首的音频已提前准备好」；放下的那份什么都不写，步骤也不带给别的', async () => {
    const record = vi.fn<(entry: LinkLogInput) => Promise<unknown>>(() => Promise.resolve()), slow = vi.fn();
    const ahead = aheadAudioLog(slow, record);
    const dropped = ahead('b'), next = ahead('c');
    dropped.add('音源校验', 5);
    next.add('音源校验', 4.4); next.add('解码预填充', SLOW_PREPARATION_STEP_MS);
    expect(slow).toHaveBeenCalledExactlyOnceWith('解码预填充', SLOW_PREPARATION_STEP_MS);
    next.done(3020.6);
    expect(record).toHaveBeenCalledExactlyOnceWith({ level: 'info', category: 'system', device: '音频', itemId: 'c', message: '下一首的音频已提前准备好',
      details: { totalMs: 3021, steps: [{ step: '音源校验', ms: 4 }, { step: '解码预填充', ms: SLOW_PREPARATION_STEP_MS }] } });
    const console = vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    try {
      record.mockRejectedValueOnce(new Error('磁盘已满'));
      dropped.done(10);
      await vi.waitFor(() => expect(console).toHaveBeenCalledExactlyOnceWith('下一首音频准备日志写入失败', expect.any(Error)));
      expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: 'b', details: { totalMs: 10, steps: [{ step: '音源校验', ms: 5 }] } }));
    } finally { console.mockRestore(); }
  });
});
