import { expect, it, vi } from 'vitest';
import { ma2PlaybackCommand, playMa2Cue } from './ma2-pool-playback';

it('停止缺失目标仍发送精确 Off 并等待关联回执，不被存在性检查阻止', async () => {
  const guard = vi.fn();
  const command = vi.fn((line: string, match: (response: string) => string | null, beforeSend?: () => void) => {
    beforeSend?.();
    expect(line).toContain("gma.cmd('Off Sequence 19')");
    expect(line).not.toContain('getobj.handle');
    const marker = /TBLINK_PLAY_[a-f0-9]{32}/.exec(line)?.[0];
    return Promise.resolve(match(`${marker}:SENT\r\n`)!);
  });
  await playMa2Cue({ command }, { target: 'sequence', sequence: 19, action: 'off' }, guard, 'stop');
  expect(guard).toHaveBeenCalledOnce();
  await expect(playMa2Cue({ command: () => Promise.reject(new Error('连接中断')) },
    { target: 'sequence', sequence: 19, action: 'off' }, guard, 'stop')).rejects.toThrow('连接中断');
  await expect(playMa2Cue({ command: () => Promise.resolve('UNKNOWN') },
    { target: 'sequence', sequence: 19, action: 'off' }, guard, 'stop')).rejects.toThrow('没有确认');
});

it('序列池直接调用序列和小数 Cue，不制造执行器地址', () => {
  expect(ma2PlaybackCommand({ target: 'sequence', sequence: 36, action: 'go' })).toEqual({ command: 'Go Sequence 36', object: 'Sequence 36' });
  expect(ma2PlaybackCommand({ target: 'sequence', sequence: 36, action: 'off' })).toEqual({ command: 'Off Sequence 36', object: 'Sequence 36' });
  expect(() => ma2PlaybackCommand({ target: 'sequence', sequence: 36, action: 'goto' })).toThrow();
  expect(ma2PlaybackCommand({ target: 'sequence', sequence: 168, cue: '1.250', action: 'goto' })).toEqual({ command: 'Goto Cue 1.250 Sequence 168', object: 'Sequence 168 Cue 1.250' });
  expect(ma2PlaybackCommand({ target: 'executor', executor: '2.101', cue: '8', action: 'goto' }).command).toBe('Goto Cue 8 Executor 2.101');
  expect(() => ma2PlaybackCommand({ target: 'sequence', sequence: 168, cue: "1');Off All", action: 'goto' })).toThrow();
});

it('发送前验证会话，只接受关联回执，对象不存在明确失败', async () => {
  const beforeSend = vi.fn();
  const command = vi.fn((line: string, match: (response: string) => string | null, guard?: () => void) => {
    guard?.();
    expect(line).toContain("gma.show.getobj.handle('Sequence 168 Cue 1.250')");
    const marker = /TBLINK_PLAY_[a-f0-9]{32}/.exec(line)?.[0];
    expect(match(line)).toBeNull();
    return Promise.resolve(match(`${marker}:SENT\r\n`)!);
  });
  const action = { target: 'sequence' as const, sequence: 168, cue: '1.250', action: 'goto' as const };
  await playMa2Cue({ command }, action, beforeSend);
  expect(beforeSend).toHaveBeenCalledOnce();
  await expect(playMa2Cue({ command }, action, () => { throw new Error('已取消'); })).rejects.toThrow('已取消');
  await expect(playMa2Cue({ command: () => Promise.resolve('MISSING') }, action, beforeSend)).rejects.toThrow('控台上已经没有');
});
