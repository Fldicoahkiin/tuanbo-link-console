import { beforeEach, expect, it, vi } from 'vitest';
import type { LinkDesktopApi } from '@tb/core/link';
import type { NativePlaybackDevices } from '@tb/schema';
import { LinkMidiAdapter, type MidiPortSnapshot } from '../../registry/link-midi-adapter';
import { useIntegrationStore } from '../stores/integration-store';
import { midiOutputInventory, readAndStoreMidiPorts } from './midi-device-inventory';

const api = vi.hoisted(() => ({ recheckMidi: vi.fn<LinkDesktopApi['recheckMidi']>(),
  getNativePlaybackDevices: vi.fn<LinkDesktopApi['getNativePlaybackDevices']>(), recordLog: vi.fn<LinkDesktopApi['recordLog']>() }));
vi.mock('./link-desktop-view-model', () => ({ linkDesktopViewModel: api }));
const usb: MidiPortSnapshot = { id: 'usb', name: 'USB MIDI Interface', direction: 'output', manufacturer: '', state: 'connected', connection: 'closed' };
const babyface: MidiPortSnapshot = { ...usb, id: 'babyface', name: 'Babyface Midi Port 1' };
const native: NativePlaybackDevices = { protocol: 4, audio: [], midiOutputs: [{ id: 0, name: babyface.name }, { id: 1, name: usb.name }], midiInputs: [] };
beforeEach(() => {
  vi.resetAllMocks();
  api.recheckMidi.mockResolvedValue();
  api.recordLog.mockImplementation(entry => Promise.resolve({ ...entry, id: 'test', sessionId: 'test', timestamp: new Date().toISOString(), monotonicMs: 0 }));
  useIntegrationStore.getState().setMidiPorts([babyface]);
  useIntegrationStore.getState().setNativeDevices(null, null);
  api.getNativePlaybackDevices.mockResolvedValue(native);
});

it('退出占用软件后刷新，同一份列表更新设置页并记录两套枚举结果；不打开端口', async () => {
  const monitor = new LinkMidiAdapter(() => null, () => undefined);
  vi.spyOn(monitor, 'refreshPorts').mockResolvedValue([babyface, usb]);
  const open = vi.spyOn(monitor, 'openOutputs');
  await readAndStoreMidiPorts(monitor);
  const state = useIntegrationStore.getState();
  expect(midiOutputInventory(state.nativeDevices, '').options).toContainEqual({ name: usb.name, available: true, reason: '' });
  expect(api.recordLog.mock.calls[0]?.[0].details?.browserPorts).toEqual([babyface, usb]);
  expect(api.recordLog.mock.calls[0]?.[0].details?.windowsOutputs).toEqual(native.midiOutputs);
  expect(open).not.toHaveBeenCalled();
});

it('时间码输出列 Windows 看得到的接口：浏览器漏枚举的 USB 接口也能选', () => {
  expect(midiOutputInventory(native, usb.name).options.find(option => option.name === usb.name)?.available).toBe(true);
});

it('刷新失败清除旧可用列表但保留已选名称，Windows 检测仍可独立完成', async () => {
  const monitor = new LinkMidiAdapter(() => null, () => undefined);
  vi.spyOn(monitor, 'refreshPorts').mockRejectedValue(new Error('Web MIDI 未响应'));
  await expect(readAndStoreMidiPorts(monitor)).rejects.toThrow('Web MIDI 未响应');
  const state = useIntegrationStore.getState();
  expect(state.midiPorts).toEqual([]);
  expect(state.nativeDevices).toEqual(native);
  expect(midiOutputInventory(null, usb.name).options).toEqual([{ name: usb.name, available: false, reason: '未检测到' }]);
});

it('Windows 检测失败不阻止浏览器 MIDI 刷新，不使用过期原生列表', async () => {
  useIntegrationStore.getState().setNativeDevices(native, null);
  api.getNativePlaybackDevices.mockRejectedValue(new Error('原生检测失败'));
  const monitor = new LinkMidiAdapter(() => null, () => undefined);
  vi.spyOn(monitor, 'refreshPorts').mockResolvedValue([usb]);
  await expect(readAndStoreMidiPorts(monitor)).resolves.toEqual([usb]);
  expect(useIntegrationStore.getState().nativeDevices).toBeNull();
  expect(useIntegrationStore.getState().nativeDeviceError).toBe('原生检测失败');
});
