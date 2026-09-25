import { expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { midiConnectionTargets } from './connection-targets';
import { createDefaultIntegrationProfile } from './local-integration-profile';

it('所有固定角色始终可见，未配置项不能伪装成已连接', () => {
  const rows = midiConnectionTargets(null, null);
  expect(rows.map(row => row.name)).toEqual(['P1 时间码输入', 'P1 控制输出', '灯光时间码输出', '播放控制输入', '灯光 Cue 输出']);
  expect(rows.every(row => !row.required)).toBe(true);
});
it('覆盖任意已保存端口与工程引用的未配置 Cue 端口，同一角色合并而不遗漏', () => {
  const profile = createDefaultIntegrationProfile();
  profile.internalPlayer = { mtcOutputPortProfileId: 'p1-output', audioOutputDeviceId: 'default' };
  profile.midiPortProfiles.push({ id: 'custom', direction: 'input', portName: '外部遥控' });
  const project = parseLinkProject({ ...createEmptyLinkProject('端口覆盖'), playbackSource: 'internal', rundown: [{ id: 'song', title: '节目', cues: [{ id: 'cue', name: '自定义端口', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, actions: [{ id: 'action', label: '控制', kind: 'midi.noteOn', portProfileId: 'missing', channel: 1, note: 60, velocity: 100 }] }] }] });
  const rows = midiConnectionTargets(profile, project);
  expect(rows.find(row => row.id === 'custom')).toMatchObject({ direction: 'input', required: true });
  expect(rows.find(row => row.id === 'missing')).toMatchObject({ direction: 'output', required: true });
  expect(rows.filter(row => row.id === 'p1-output')).toHaveLength(1);
  expect(rows.find(row => row.id === 'p1-output')?.name).toContain('灯光时间码输出');
});
