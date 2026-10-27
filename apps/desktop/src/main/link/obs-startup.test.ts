import { afterEach, expect, it, vi } from 'vitest';
import { toUserErrorMessage } from '@tb/core/link';
import { obsEndpointNotListening, waitForObsEndpoint } from './obs-startup';
afterEach(() => { vi.useRealTimers(); });
it('等待本次启动的进程监听后才允许连接', async () => {
  const locate = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(42);
  await waitForObsEndpoint('ws://127.0.0.1:4455', 42, 2000, locate);
  expect(locate).toHaveBeenCalledTimes(2);
});
it('拒绝错误的端口归属和远程地址', async () => {
  await expect(waitForObsEndpoint('ws://127.0.0.1:4455', 42, 2000, vi.fn().mockResolvedValue(43))).rejects.toThrow('被另一个程序占用');
  await expect(waitForObsEndpoint('ws://192.168.1.2:4455', 42, 2000)).rejects.toThrow('本机');
});
it('没有启用服务或停在安全模式询问框时有界失败，保留进程并说明处理方法', async () => {
  await expect(waitForObsEndpoint('ws://127.0.0.1:4455', 42, 1, vi.fn().mockResolvedValue(null)))
    .rejects.toThrow('OBS 已在运行（PID 42），但 WebSocket 服务没有在 ws://127.0.0.1:4455 上开启。OBS 可能停在“安全模式”询问框');
});
it('安全模式提示经界面翻译后保持原文，不被换成通用连接失败', () => {
  const message = obsEndpointNotListening('ws://127.0.0.1:4455', 13224).message;
  expect(toUserErrorMessage(new Error(message))).toBe(message);
});
