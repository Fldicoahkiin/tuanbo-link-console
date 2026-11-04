import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type IntegrationProfile } from '@tb/schema';
import { legacyAudioDeviceNotice, playerEngineLabel, projectOutputsMtc } from './internal-audio-engine';
import { createDefaultIntegrationProfile } from './local-integration-profile';

function project(outputMode?: 'timecode' | 'direct' | 'network') {
  return parseLinkProject({ ...createEmptyLinkProject('引擎'), schemaVersion: 2, playbackSource: 'internal',
    rundown: [{ id: 'song', title: '歌', cues: [], ...(outputMode ? { lighting: { ...createLightingDocument(), outputMode } } : {}) }] });
}
function profile(audioEngine: 'browser' | 'native' | undefined, mtcPort: boolean): IntegrationProfile {
  const value = createDefaultIntegrationProfile();
  value.internalPlayer = { audioOutputDeviceId: 'default', mtcOutputPortProfileId: mtcPort ? 'internal-mtc-output' : null, ...(audioEngine ? { audioEngine } : {}) };
  return value;
}

it('只有 Windows 原生音频一种播放方式：档案里写着旧的浏览器方式也照样用原生音频', () => {
  expect(playerEngineLabel(profile('browser', true), project())).toBe('Windows 原生音频（同时发送 MIDI 时间码）');
  expect(playerEngineLabel(profile(undefined, false), project())).toBe('Windows 原生音频');
});

it('有灯光的歌不论保存的输出方式都发时间码', () => {
  expect(projectOutputsMtc(project())).toBe(false);
  for (const mode of ['timecode', 'direct', 'network'] as const) expect(projectOutputsMtc(project(mode))).toBe(true);
  expect(projectOutputsMtc({ ...project('timecode'), playbackSource: 'p1' })).toBe(false);
  expect(playerEngineLabel(profile(undefined, false), project('timecode'))).toBe('Windows 原生音频（同时发送 MIDI 时间码）');
});

it('旧播放方式下选过的设备不能直接用：明确告诉操作员现在用默认设备，不悄悄换', () => {
  const old = { audioEngine: 'browser' as const, audioOutputDeviceId: 'browser-a', mtcOutputPortProfileId: null };
  expect(legacyAudioDeviceNotice(old)).toContain('Windows 默认播放设备');
  expect(legacyAudioDeviceNotice({ ...old, nativeAudioOutputDeviceId: 'native-a' })).toBeNull();
  expect(legacyAudioDeviceNotice({ ...old, audioOutputDeviceId: 'default' })).toBeNull();
  expect(legacyAudioDeviceNotice({ ...old, audioEngine: 'native' })).toBeNull();
});
