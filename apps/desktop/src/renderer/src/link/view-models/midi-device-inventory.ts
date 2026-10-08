import type { NativePlaybackDevices } from '@tb/schema';
import type { LinkMidiAdapter, MidiPortSnapshot } from '../../registry/link-midi-adapter';
import { useIntegrationStore } from '../stores/integration-store';
import { useConnectionCheckStore } from '../stores/connection-check-store';
import { linkDesktopViewModel as desktop } from './link-desktop-view-model';

let pendingNative: Promise<NativePlaybackDevices> | null = null;

/** Enumeration only: never opens an output or sends a MIDI message. */
export function readNativeDevices(): Promise<NativePlaybackDevices> {
  if (pendingNative) return pendingNative;
  const task = desktop.getNativePlaybackDevices().then(devices => {
    useIntegrationStore.getState().setNativeDevices(devices, null);
    return devices;
  }, (error: unknown) => {
    useIntegrationStore.getState().setNativeDevices(null, message(error));
    throw error;
  }).finally(() => { if (pendingNative === task) pendingNative = null; });
  pendingNative = task;
  return task;
}

export async function readAndStoreMidiPorts(monitor: LinkMidiAdapter): Promise<MidiPortSnapshot[]> {
  const [web, native] = await Promise.allSettled([
    desktop.recheckMidi().then(() => monitor.refreshPorts()),
    readNativeDevices()
  ]);
  const ports = web.status === 'fulfilled' ? web.value : [];
  useIntegrationStore.getState().setMidiPorts(ports);
  const webError = web.status === 'rejected' ? message(web.reason) : null;
  if (!useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('midi', webError ? 'error' : 'ready', webError ?? '系统 MIDI 检测通过');
  await desktop.recordLog({ level: webError || native.status === 'rejected' ? 'warning' : 'info', category: 'device', device: 'midi',
    message: 'MIDI 端口重新检测完成（仅枚举，未发送时间码）', details: {
      browserPorts: ports, browserError: webError,
      windowsOutputs: native.status === 'fulfilled' ? native.value.midiOutputs : [],
      windowsError: native.status === 'rejected' ? message(native.reason) : null
    } }).catch(console.error);
  if (web.status === 'rejected') throw web.reason;
  return ports;
}

export function midiOutputInventory(engine: 'browser' | 'native', ports: readonly MidiPortSnapshot[], native: NativePlaybackDevices | null, selected: string): {
  available: string[]; windowsOnly: string[]; options: { name: string; available: boolean; reason: string }[];
} {
  const browser = ports.filter(port => port.direction === 'output' && port.state === 'connected').map(port => port.name);
  const windows = native?.midiOutputs.map(port => port.name) ?? [];
  const available = engine === 'native' ? windows : browser;
  const windowsOnly = engine === 'browser' ? windows.filter(name => !browser.includes(name)) : [];
  const names = [...new Set([...available, ...windowsOnly, ...(selected ? [selected] : [])])];
  return { available, windowsOnly, options: names.map(name => ({ name, available: available.includes(name),
    reason: windowsOnly.includes(name) ? '当前播放引擎未识别' : available.includes(name) ? '' : '未检测到' })) };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
