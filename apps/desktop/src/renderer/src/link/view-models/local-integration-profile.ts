import type { IntegrationProfile } from '@tb/schema';

/** Keep uncommitted device edits when another settings panel saves its fields. */
export function mergeIntegrationDraft(base: IntegrationProfile, draft: IntegrationProfile, saved: IntegrationProfile): IntegrationProfile {
  const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
  const fields = <T extends object>(previous: T, local: T, remote: T): T => {
    const result = { ...remote };
    for (const key of Object.keys(local) as Array<keyof T>) {
      if (!equal(local[key], previous[key])) result[key] = local[key];
    }
    return result;
  };
  const ports = new Map(saved.midiPortProfiles.map((port) => [port.id, port]));
  const localPorts = new Map(draft.midiPortProfiles.map((port) => [port.id, port]));
  for (const previous of base.midiPortProfiles) {
    if (!localPorts.has(previous.id)) ports.delete(previous.id);
  }
  for (const port of draft.midiPortProfiles) {
    if (!equal(port, base.midiPortProfiles.find((previous) => previous.id === port.id))) ports.set(port.id, port);
  }
  return {
    ...fields(base, draft, saved),
    updatedAt: saved.updatedAt,
    obs: fields(base.obs, draft.obs, saved.obs),
    p1: fields(base.p1, draft.p1, saved.p1),
    acceptedVersions: fields(base.acceptedVersions, draft.acceptedVersions, saved.acceptedVersions),
    midiPortProfiles: [...ports.values()]
  };
}

export function createDefaultIntegrationProfile(): IntegrationProfile {
  const executable = (path: string) => ({ executablePath: path, arguments: [], workingDirectory: path.slice(0, path.lastIndexOf('\\')), startupTimeoutMs: 20_000, shutdownTimeoutMs: 10_000 });
  return {
    schemaVersion: 1,
    profileId: 'windows-stage',
    name: 'Windows 现场机器',
    updatedAt: new Date().toISOString(),
    obs: { ...executable('C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe'), autoConnectOnLaunch: true, webSocketUrl: 'ws://127.0.0.1:4455', credentialId: 'obs-main' },
    p1: { ...executable('C:\\P1\\P1.exe'), mtcInputPortProfileId: 'p1-mtc', controlOutputPortProfileId: 'p1-output', expectedFrameRate: '30', obsAudioInputName: '' },
    midiPortProfiles: [
      { id: 'p1-mtc', direction: 'input', portName: '' },
      { id: 'p1-output', direction: 'output', portName: '' },
      { id: 'lighting-output', direction: 'output', portName: '' }
    ],
    acceptedVersions: { obs: '32.2.2', p1: '待现场填写' }
  };
}

