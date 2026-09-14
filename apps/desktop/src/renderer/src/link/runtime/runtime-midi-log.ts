import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import type { MidiPortSnapshot } from '../../registry/link-midi-adapter';

export async function recordMidiPortUpdate(projectId: string, ports: readonly MidiPortSnapshot[]): Promise<void> {
  await linkDesktopViewModel.recordLog({
    level: ports.some((port) => port.state !== 'connected') ? 'warning' : 'info',
    category: 'device',
    message: `Windows MIDI 端口更新：${ports.length} 个`,
    projectId,
    device: 'midi',
    details: {
      ports: ports.map((port) => ({
        name: port.name,
        direction: port.direction,
        state: port.state,
        connection: port.connection
      }))
    }
  });
}
