import type { IntegrationProfile } from '@tb/schema';
import { linkDesktopViewModel as desktop } from './link-desktop-view-model';

/** Playback uses Windows native audio only; a device id saved by the old browser engine is never used. */
export async function assertAudioOutputAvailable(route: IntegrationProfile['internalPlayer']): Promise<void> {
  const devices = await desktop.getNativePlaybackDevices('audio');
  const id = route?.nativeAudioOutputDeviceId ?? 'default';
  if (!devices.audio.some(device => id === 'default' ? device.isDefault : device.id === id)) throw new Error('选择的 Windows 播放设备不可用，请重新选择输出设备');
}
