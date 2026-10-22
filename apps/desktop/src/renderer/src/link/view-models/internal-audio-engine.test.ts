import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type IntegrationProfile } from '@tb/schema';
import { internalAudioEngine, internalAudioEngineLabel, projectOutputsMtc } from './internal-audio-engine';
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

it('未单独设置引擎的档案默认用原生引擎；输出时间码时明确选了浏览器引擎就开播前拒绝，不偷偷切换', () => {
  expect(internalAudioEngine(profile(undefined, true), project())).toEqual({ engine: 'native', outputsMtc: true, blocked: null });
  expect(internalAudioEngine(profile(undefined, false), project())).toEqual({ engine: 'native', outputsMtc: false, blocked: null });
  const chosen = internalAudioEngine(profile('browser', true), project());
  expect(chosen).toMatchObject({ engine: 'browser', outputsMtc: true });
  expect(chosen.blocked).toContain('请在“播放设置”点“改用 Windows 原生音频”后再播放');
  expect(internalAudioEngine(profile('browser', false), project('timecode')).blocked).not.toBeNull();
  const native = internalAudioEngine(profile('native', true), project('timecode'));
  expect(native).toEqual({ engine: 'native', outputsMtc: true, blocked: null });
  expect(internalAudioEngineLabel(native)).toBe('Windows 原生音频（输出 MIDI 时间码）');
});

it('不输出时间码的工程（纯音频加画面、网络或 MIDI 直控灯光）继续可用浏览器引擎', () => {
  for (const mode of [undefined, 'direct', 'network'] as const) {
    expect(projectOutputsMtc(project(mode))).toBe(false);
    const choice = internalAudioEngine(profile('browser', false), project(mode));
    expect(choice).toEqual({ engine: 'browser', outputsMtc: false, blocked: null });
    expect(internalAudioEngineLabel(choice)).toBe('浏览器音频');
  }
  expect(projectOutputsMtc({ ...project('timecode'), playbackSource: 'p1' })).toBe(false);
});
