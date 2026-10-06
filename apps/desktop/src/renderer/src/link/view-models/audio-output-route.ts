import type { IntegrationProfile } from '@tb/schema';
import { linkDesktopViewModel as desktop } from './link-desktop-view-model';

export async function assertAudioOutputAvailable(route: IntegrationProfile['internalPlayer']): Promise<void> {
  if (route?.audioEngine === 'native') {
    const devices = await desktop.getNativePlaybackDevices();
    const id = route.nativeAudioOutputDeviceId ?? 'default';
    if (!devices.audio.some(device => id === 'default' ? device.isDefault : device.id === id)) throw new Error('所选 Windows 原生播放设备不可用，请重新选择输出线路');
  } else {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const id = route?.audioOutputDeviceId ?? 'default';
    if (!devices.some(device => device.kind === 'audiooutput' && device.deviceId === id)) throw new Error('所选播放设备不可用，请重新选择输出线路');
  }
}
