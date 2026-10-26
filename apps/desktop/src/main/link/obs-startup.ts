import { findLocalObsPid } from './obs-editor-preview';

/** Wait for the owned process to listen before the single WebSocket connect attempt. */
export async function waitForObsEndpoint(address: string, pid: number, timeoutMs: number, locate = findLocalObsPid): Promise<void> {
  const url = new URL(address);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('OBS 组件只能用于本机的 OBS');
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const listeningPid = await locate(address);
    if (listeningPid === pid) return;
    if (listeningPid !== null) throw new Error('OBS 的端口被另一个程序占用了，请在「设备连接」里检查端口');
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw obsEndpointNotListening(address, pid);
}

/** A running OBS without a listener is most often waiting on its safe-mode
 * prompt after a crash or system restart; WebSocket stays off until answered. */
export function obsEndpointNotListening(address: string, pid: number): Error {
  return new Error(`OBS 已在运行（PID ${pid}），但 WebSocket 服务没有在 ${address} 上开启。OBS 可能停在“安全模式”询问框（电脑重启或 OBS 异常退出后第一次打开会出现），请在 OBS 窗口里选正常模式；也请在 OBS 的“工具 → WebSocket 服务器设置”里确认已开启服务。密码还没发送。`);
}
