import type { LinkObsSnapshot } from '@tb/core/link';
import type { ConnectionCheck } from '../stores/connection-check-store';

export type ConnectionStatus = { state: 'ready' | 'error' | 'checking' | 'idle' | 'skipped'; value: string; detail: string };

/** Live transport state wins over results of an earlier connection/inventory check. */
export function obsConnectionStatus(obs: LinkObsSnapshot): ConnectionStatus {
  if (obs.status === 'connected') return { state: 'ready', value: '已连接', detail: 'OBS 控制连接已建立；预览与场景清单单独检查' };
  if (obs.status === 'connecting' || obs.status === 'reconnecting') return { state: 'checking', value: '连接中', detail: '正在连接 OBS' };
  return { state: obs.error ? 'error' : 'idle', value: '未连接', detail: obs.error ?? 'OBS 控制连接尚未建立' };
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
  if (open) return { state: 'ready', value: '已连接', detail: `${portName}；接口已打开，尚不代表控台正在执行灯光` };
  if (check?.state === 'checking') return { state: 'checking', value: '连接中', detail: check.detail };
  if (!available) return { state: 'error', value: '未连接', detail: `${portName}；当前未检测到唯一可用接口` };
  if (check?.state === 'error' || !native && systemError) return { state: 'error', value: '未连接', detail: check?.state === 'error' ? check.detail : systemError! };
  return { state: native ? 'ready' : 'idle', value: '可用', detail: `${portName}；${native ? 'Windows 已识别，播放时打开并发送时间码' : '系统已识别，点击一键连接打开接口'}` };
}

export const lightingConnectionDestination = { category: 'audio', focus: 'lighting-mtc' } as const;
