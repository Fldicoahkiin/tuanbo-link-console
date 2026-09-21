import { afterEach, expect, it, vi } from 'vitest';
import { waitForObsEndpoint } from './obs-startup';
afterEach(() => { vi.useRealTimers(); });
it('等待本次启动的进程监听后才允许连接', async () => {
  const locate = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(42);
  await waitForObsEndpoint('ws://127.0.0.1:4455', 42, 2000, locate);
  expect(locate).toHaveBeenCalledTimes(2);
});
it('拒绝错误的端口归属和远程地址', async () => {
  await expect(waitForObsEndpoint('ws://127.0.0.1:4455', 42, 2000, vi.fn().mockResolvedValue(43))).rejects.toThrow('另一个进程');
  await expect(waitForObsEndpoint('ws://192.168.1.2:4455', 42, 2000)).rejects.toThrow('本机');
});
it('没有启用服务时有界失败，保留进程', async () => {
  await expect(waitForObsEndpoint('ws://127.0.0.1:4455', 42, 1, vi.fn().mockResolvedValue(null))).rejects.toThrow('未在规定时间');
});
