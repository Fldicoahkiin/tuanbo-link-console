import { loopMidiStatusSchema, type IntegrationProfile } from '@tb/schema';
import { linkDesktopViewModel } from './link-desktop-view-model';

export async function prepareLoopMidi(profile: IntegrationProfile): Promise<void> {
  if (!profile.loopMidi?.autoStart) return;
  const status = loopMidiStatusSchema.parse(await linkDesktopViewModel.loopMidi('start'));
  if (status.state !== 'running') throw new Error('找不到 loopMIDI。请在“设置 → 虚拟 MIDI”里完成首次安装，或关闭“随联动台启动”');
}
