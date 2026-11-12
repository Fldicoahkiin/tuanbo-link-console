import type { LinkObsSnapshot } from '@tb/core/link';
import type { Ma2NetworkStatus } from '@tb/schema';
import type { ConnectionCheck } from '../stores/connection-check-store';

/** `warning`: connected, but one step after it failed; the detail names the step. */
export type ConnectionStatus = { state: 'ready' | 'warning' | 'error' | 'checking' | 'idle' | 'skipped'; value: string; detail: string };

/** The overview reports the live connection; detailed bridge checks remain separate. */
export function ma2EditingConnectionStatus(input: {
  method: 'network' | 'local' | 'midi';
  network: Pick<Ma2NetworkStatus, 'state' | 'error'> | null;
  networkError: string | null;
  local: { status: 'disconnected' | 'connecting' | 'ready' | 'error'; error: string | null };
  bridge: ConnectionCheck | undefined;
}): ConnectionStatus {
  if (input.method === 'midi') return { state: 'skipped', value: '未启用', detail: '仅 MIDI 时不读写控台工程' };
  if (input.method === 'local') {
    if (input.local.status === 'ready') return { state: 'ready', value: '已连接', detail: '本机控台读写通信正常' };
    if (input.local.status === 'connecting') return { state: 'checking', value: '连接中', detail: '正在连接本机控台' };
    return { state: input.local.status === 'error' ? 'error' : 'idle', value: '未连接', detail: input.local.error ?? '还没连接本机控台' };
  }
  if (input.networkError) return { state: 'error', value: '连接异常', detail: input.networkError };
  // The word and the colour say the same thing: a network login with a failed read/write check is not "connected".
  if (input.network?.state === 'connected') return input.bridge?.state === 'error'
    ? { state: 'warning', value: '读写异常', detail: `控台网络已登录，但读写控台这一步没通过。原因：${input.bridge.detail}` }
    : { state: 'ready', value: '已连接', detail: input.bridge?.state === 'ready' ? `控台网络已连接；${input.bridge.detail}` : '控台网络已连接；每次读写时还会再检查通信和内容' };
  if (input.network?.state === 'connecting' || input.network?.state === 'authenticating') return { state: 'checking', value: '连接中', detail: '正在连接并登录控台' };
  return { state: input.network?.error ? 'error' : 'idle', value: '未连接', detail: input.network?.error ?? '还没连接控台' };
}

/** Live transport state wins over results of an earlier connection/inventory check. */
export function obsConnectionStatus(obs: LinkObsSnapshot): ConnectionStatus {
  if (obs.status === 'connected') return { state: 'ready', value: '已连接', detail: 'OBS 已连接；预览和场景清单另外检查' };
  // OBS reconnecting by itself after it dropped (R7): waiting, not red, until the limit.
  const auto = obs.autoReconnect;
  if (auto?.state === 'gave-up') return { state: 'error', value: '自动重连没成功', detail: auto.text };
  if (auto) return { state: 'checking', value: `自动重连（第 ${auto.attempt} 次）`,
    detail: `OBS 断开了，正在自动重连（第 ${auto.attempt} 次，最多 ${auto.max} 次）。连上后画面按当前位置接上；要马上重试，点连接` };
  if (obs.status === 'connecting' || obs.status === 'reconnecting') return { state: 'checking', value: '连接中', detail: '正在连接 OBS' };
  return { state: obs.error ? 'error' : 'idle', value: '未连接', detail: obs.error ?? 'OBS 还没连接' };
}

export function midiConnectionStatus(input: {
  required: boolean; portName: string | undefined; available: boolean; open: boolean;
  native: boolean; check: ConnectionCheck | undefined; systemError: string | undefined;
  inventoryPending?: boolean;
}): ConnectionStatus {
  const { required, portName, available, open, native, check, systemError } = input;
  if (!required) return { state: 'skipped', value: '未启用', detail: '未启用此接口' };
  if (!portName) return { state: 'idle', value: '未配置', detail: '请在音频与 MIDI 中选择接口' };
  if (input.inventoryPending) return { state: 'checking', value: '检测中', detail: `正在读取 Windows 接口：${portName}` };
  // An open port says nothing about the console: "已连接" here read as "the lights will run" (2026-10-28, picture 3).
  if (open) return { state: 'ready', value: '接口已打开', detail: `${portName}；接口已打开。控台有没有收到、在不在跑灯，要看控台的时间码窗口` };
  if (check?.state === 'checking') return { state: 'checking', value: '连接中', detail: check.detail };
  if (check?.state === 'waiting' || check?.state === 'blocked') return { state: 'idle', value: check.state === 'waiting' ? '等待中' : '未执行', detail: check.detail };
  if (!available) return { state: 'error', value: '未连接', detail: `${portName}；找不到这个接口，或有重名接口` };
  if (check?.state === 'error' || !native && systemError) return { state: 'error', value: '未连接', detail: check?.state === 'error' ? check.detail : systemError! };
  return { state: native ? 'ready' : 'idle', value: '可用', detail: `${portName}；${native ? 'Windows 已识别，播放时打开接口发送 MIDI' : '系统已识别，点“一键连接”打开接口'}` };
}

export const lightingConnectionDestination = { category: 'audio', focus: 'lighting-mtc' } as const;
