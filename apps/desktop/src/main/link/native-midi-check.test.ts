import { expect, it, vi } from 'vitest';
import { NativeMidiCheckService } from './native-midi-check';

it('按完整名称打开并释放目标，不发送 MIDI 消息', async () => {
  const open = vi.fn(() => Promise.resolve()), close = vi.fn(() => Promise.resolve());
  const service = new NativeMidiCheckService('test', () => false, () => ({ open, close }));
  await service.check({ version: 1, portName: 'USB MIDI Interface' });
  expect(open).toHaveBeenCalledExactlyOnceWith('USB MIDI Interface');
  expect(close).toHaveBeenCalledOnce();
});
it('端口打开失败保留设备名和底层原因，并完成释放', async () => {
  const close = vi.fn(() => Promise.resolve());
  const service = new NativeMidiCheckService('test', () => false, () => ({ open: () => Promise.reject(new Error('Windows 错误 4')), close }));
  await expect(service.check({ version: 1, portName: 'USB MIDI Interface' })).rejects.toThrow('USB MIDI Interface 检查失败：Windows 错误 4');
  expect(close).toHaveBeenCalledOnce();
});
it('播放中不检查，同一时间只允许一个检查，清理失败不能报成功', async () => {
  let active = true;
  const create = vi.fn(() => ({ open: () => Promise.resolve(), close: () => Promise.reject(new Error('端口未释放')) }));
  const service = new NativeMidiCheckService('test', () => active, create);
  await expect(service.check({ version: 1, portName: 'USB' })).rejects.toThrow('播放中');
  expect(create).not.toHaveBeenCalled(); active = false;
  const first = service.check({ version: 1, portName: 'USB' });
  await expect(service.check({ version: 1, portName: 'USB' })).rejects.toThrow('正在检查');
  await expect(first).rejects.toThrow('接口清理失败');
});
