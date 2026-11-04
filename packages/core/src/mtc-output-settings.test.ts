import { expect, it } from 'vitest';
import type { IntegrationProfile } from '@tb/schema';
import { mtcOutputSettings } from './mtc-output-settings';

it('正式播放和试听读同一个时间码端口和发送方式；没选端口时为空，不猜别的端口', () => {
  const profile: Pick<IntegrationProfile, 'midiPortProfiles' | 'internalPlayer'> = { midiPortProfiles: [] };
  expect(mtcOutputSettings(null)).toEqual({ portName: null, sendMode: 'standard' });
  expect(mtcOutputSettings(profile).portName).toBeNull();
  profile.midiPortProfiles.push({ id: 'mtc', direction: 'output', portName: 'USB MIDI Interface' }, { id: 'in', direction: 'input', portName: 'USB MIDI Interface' });
  profile.internalPlayer = { audioOutputDeviceId: 'default', mtcOutputPortProfileId: 'mtc', mtcSendMode: 'quarter-frames' };
  expect(mtcOutputSettings(profile)).toEqual({ portName: 'USB MIDI Interface', sendMode: 'quarter-frames' });
  profile.internalPlayer.mtcOutputPortProfileId = 'in';
  expect(mtcOutputSettings(profile).portName).toBeNull();
});
