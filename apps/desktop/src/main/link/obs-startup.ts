import { findLocalObsPid } from './obs-editor-preview';

/** Wait for the owned process to listen before the single WebSocket connect attempt. */
export async function waitForObsEndpoint(address: string, pid: number, timeoutMs: number, locate = findLocalObsPid): Promise<void> {
  const url = new URL(address);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('OBS 内置组件需要本机 OBS 地址');
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const listeningPid = await locate(address);
    if (listeningPid === pid) return;
    if (listeningPid !== null) throw new Error('OBS 端口由另一个进程占用，请在设备连接中核对端口');
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('OBS 已启动，但 WebSocket 服务未在规定时间内就绪。请在 OBS 中启用 WebSocket，再点击检查并修复组件。');
}
