import { expect, it, vi } from 'vitest';
import { createLicenseMachineCodeReader } from './license-machine';

it('并发与后续请求共用本次启动的机器标识读取，新实例重新读取', async () => {
  const read = vi.fn<() => Promise<string>>().mockResolvedValue('TB1-machine');
  const machine = createLicenseMachineCodeReader(read);
  expect(await Promise.all([machine(), machine(), machine()])).toEqual(['TB1-machine', 'TB1-machine', 'TB1-machine']);
  await machine(); expect(read).toHaveBeenCalledTimes(1);
  await createLicenseMachineCodeReader(read)(); expect(read).toHaveBeenCalledTimes(2);
});

it('机器标识读取失败明确返回，后续调用不自动重试也不伪造标识', async () => {
  const read = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('注册表不可读'));
  const machine = createLicenseMachineCodeReader(read);
  await expect(machine()).rejects.toThrow('注册表不可读');
  await expect(machine()).rejects.toThrow('注册表不可读');
  expect(read).toHaveBeenCalledTimes(1);
});
