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
  throw obsEndpointNotListening(address, pid);
}

/** A running OBS without a listener is most often waiting on its safe-mode
 * prompt after a crash or system restart; WebSocket stays off until answered. */
export function obsEndpointNotListening(address: string, pid: number): Error {
  return new Error(`OBS 已运行（PID ${pid}），但 WebSocket 服务没有在 ${address} 监听。OBS 可能停在“安全模式”询问框（系统重启或异常退出后首次启动会出现），请在 OBS 窗口中选择正常模式；也请在 OBS“工具 → WebSocket 服务器设置”确认已启用服务。尚未发送密码。`);
}
