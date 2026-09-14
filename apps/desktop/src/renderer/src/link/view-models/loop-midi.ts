import { loopMidiStatusSchema, type IntegrationProfile } from '@tb/schema';
import { linkDesktopViewModel } from './link-desktop-view-model';

export async function prepareLoopMidi(profile: IntegrationProfile): Promise<void> {
  if (!profile.loopMidi?.autoStart) return;
  const status = loopMidiStatusSchema.parse(await linkDesktopViewModel.loopMidi('start'));
  if (status.state !== 'running') throw new Error('未找到 loopMIDI，请在“设备 → 音频与 MIDI → 虚拟 MIDI 通道”完成首次安装，或关闭随联动台启动');
}
