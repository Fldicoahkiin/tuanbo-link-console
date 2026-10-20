import { expect, it, vi } from 'vitest';
import type { Ma2ExecutorInput } from '@tb/schema';
import { Ma2ExecutorInputService } from './ma2-executor-input';

const request = (): Ma2ExecutorInput => ({
  network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' },
  expectedSource: { show: 'TEST', generation: '1', version: '3.7.0.5' }, page: 1000, slot: 101,
  expectedItem: { slot: 101, width: 1, name: 'Flash', sequence: 9000, kind: 'sequence', button: 12302, buttons: [12302, 0, 0, 0], reference: ['25', '1', '9000'] },
  button: 0, pressed: true, sessionId: '11111111-1111-4111-8111-111111111111', deadlineAt: Date.now() + 3000
});
it('sends the exact native assigned function and releases on the stop queue', async () => {
  const connection = { command: vi.fn().mockResolvedValueOnce('SENT').mockResolvedValueOnce('HELD').mockResolvedValueOnce('RELEASED') };
  const service = new Ma2ExecutorInputService(); const input = request();
  await service.input(connection, input, () => undefined);
  await service.input(connection, input, () => undefined);
  await service.release();
  expect(connection.command.mock.calls[0]![0]).toContain(',1000,101,0,true,12302,9000,');
  expect(connection.command.mock.calls[1]![0]).toContain(input.sessionId.replaceAll('-', ''));
  expect(connection.command.mock.calls[2]![0]).toContain(',1000,101,0,false,12302,9000,');
  expect(connection.command.mock.calls[2]![3]).toBe('stop');
});
it('never substitutes Go for an unread or unsupported function, or dispatches an expired press', async () => {
  const connection = { command: vi.fn() }; const service = new Ma2ExecutorInputService(); const input = request();
  await expect(service.input(connection, { ...input, expectedItem: { ...input.expectedItem, buttons: [99999] } }, () => undefined)).rejects.toThrow('没有已读取');
  await expect(service.input(connection, { ...input, deadlineAt: Date.now() - 1 }, () => undefined)).rejects.toThrow('已过期');
  expect(connection.command).not.toHaveBeenCalled();
});
it('checks the active connection again when a press leaves the command queue', async () => {
  const service = new Ma2ExecutorInputService(); const input = request();
  const current = vi.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('changed'); });
  const connection = { command: vi.fn((_line: string, _match: (text: string) => string | null, guard?: () => void) => { guard?.(); return Promise.resolve('SENT'); }) };
  await expect(service.input(connection, input, current)).rejects.toThrow('changed');
});
it('retains an uncertain press for release instead of resending the operation', async () => {
  const service = new Ma2ExecutorInputService(); const input = request();
  const connection = { command: vi.fn().mockRejectedValueOnce(new Error('lost receipt')).mockResolvedValueOnce('RELEASED') };
  await expect(service.input(connection, input, () => undefined)).rejects.toThrow('lost receipt');
  await service.release();
  expect(connection.command).toHaveBeenCalledTimes(2);
  expect(connection.command.mock.calls[1]![0]).toContain(',false,');
});
it('松开先出队时取消尚未发送的按下，不能在已松开后补亮', async () => {
  const service = new Ma2ExecutorInputService(); const input = request();
  let sendPress: (() => void) | undefined;
  const connection = { command: vi.fn((line: string, _match: (text: string) => string | null, guard?: () => void) => {
    if (line.includes(',false,')) return Promise.resolve('RELEASED');
    return new Promise<string>((resolve, reject) => {
      sendPress = () => { try { guard?.(); resolve('SENT'); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); } };
    });
  }) };
  const pending = service.input(connection, input, () => undefined);
  const rejected = expect(pending).rejects.toThrow('已松开');
  await service.release();
  sendPress?.();
  await rejected;
});
it('断线释放未确认只保留到控台租约的最晚截止，不永久卡住后续编辑', async () => {
  vi.useFakeTimers();
  try {
    const service = new Ma2ExecutorInputService(); const input = request();
    const connection = { command: vi.fn().mockResolvedValueOnce('SENT').mockRejectedValue(new Error('disconnected')) };
    await service.input(connection, input, () => undefined);
    await expect(service.release()).rejects.toThrow('租约');
    vi.setSystemTime(input.deadlineAt + 2001);
    await service.release();
    await service.release();
    expect(connection.command).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
