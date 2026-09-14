import { describe, expect, it } from 'vitest';
import { parseIntegrationProfile } from './integration-profile';

describe('本机集成档案', () => {
  it('允许持久保存尚未配置的 MIDI 端口名称', () => {
    const profile = parseIntegrationProfile({
      schemaVersion: 1,
      profileId: 'local',
      name: '本机',
      updatedAt: '2026-08-27T00:00:00.000Z',
      obs: {
        executablePath: 'C:\\OBS\\obs64.exe',
        arguments: [],
        workingDirectory: 'C:\\OBS',
        startupTimeoutMs: 10_000,
        shutdownTimeoutMs: 10_000,
        webSocketUrl: 'ws://127.0.0.1:4455',
        credentialId: 'obs-main'
      },
      p1: {
        executablePath: 'D:\\HirenderP1\\HirenderP1.exe',
        arguments: [],
        workingDirectory: 'D:\\HirenderP1',
        startupTimeoutMs: 10_000,
        shutdownTimeoutMs: 10_000,
        mtcInputPortProfileId: 'p1-mtc',
        controlOutputPortProfileId: 'p1-output',
        expectedFrameRate: '30'
      },
      midiPortProfiles: [
        { id: 'p1-mtc', direction: 'input', portName: '' },
        { id: 'p1-output', direction: 'output', portName: '' }
      ],
      liveCompanion: {
        executablePath: 'C:\\LegacyLive\\Live.exe', arguments: [], workingDirectory: 'C:\\LegacyLive',
        startupTimeoutMs: 10_000, shutdownTimeoutMs: 10_000, processName: 'Live.exe', windowTitlePattern: '直播伴侣'
      },
      acceptedVersions: { obs: '32.2.2', p1: '1.14.2', liveCompanion: '12.8.1' }
    });

    expect(profile.midiPortProfiles).toEqual([
      { id: 'p1-mtc', direction: 'input', portName: '' },
      { id: 'p1-output', direction: 'output', portName: '' }
    ]);
    expect('liveCompanion' in profile).toBe(false);
    expect('liveCompanion' in profile.acceptedVersions).toBe(false);
  });
});
