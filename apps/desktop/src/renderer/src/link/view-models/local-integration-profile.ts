import { DEFAULT_PROGRAM_PATHS, type IntegrationProfile } from '@tb/schema';

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
    obs: { ...executable(DEFAULT_PROGRAM_PATHS.obs), autoConnectOnLaunch: true, webSocketUrl: 'ws://127.0.0.1:4455', credentialId: 'obs-main' },
    p1: { ...executable(DEFAULT_PROGRAM_PATHS.p1), mtcInputPortProfileId: 'p1-mtc', controlOutputPortProfileId: 'p1-output', expectedFrameRate: '30', obsAudioInputName: '' },
    midiPortProfiles: [
      { id: 'p1-mtc', direction: 'input', portName: '' },
      { id: 'p1-output', direction: 'output', portName: '' },
      { id: 'lighting-output', direction: 'output', portName: '' }
    ],
    acceptedVersions: { obs: '32.2.2', p1: '待现场填写' }
  };
}


function programSettings(value: Pick<IntegrationProfile['obs'], 'executablePath' | 'workingDirectory' | 'arguments' | 'startupTimeoutMs' | 'shutdownTimeoutMs'>) {
  return { executablePath: value.executablePath, workingDirectory: value.workingDirectory, arguments: value.arguments, startupTimeoutMs: value.startupTimeoutMs, shutdownTimeoutMs: value.shutdownTimeoutMs };
}

export function programDraftValues(profile: IntegrationProfile) {
  return { obs: programSettings(profile.obs), p1: programSettings(profile.p1), obsAudioInputName: profile.p1.obsAudioInputName, expectedFrameRate: profile.p1.expectedFrameRate, acceptedVersions: profile.acceptedVersions, legacyOutput: profile.midiPortProfiles.find(port => port.id === 'lighting-output') };
}

/** Maintenance owns program launch parameters, never connection credentials or other MIDI drafts. */
export function mergeProgramSettings(current: IntegrationProfile, draft: IntegrationProfile): IntegrationProfile {
  const legacyOutput = draft.midiPortProfiles.find(port => port.id === 'lighting-output');
  return { ...current, updatedAt: new Date().toISOString(), acceptedVersions: draft.acceptedVersions,
    obs: { ...current.obs, ...programSettings(draft.obs) },
    p1: { ...current.p1, ...programSettings(draft.p1), obsAudioInputName: draft.p1.obsAudioInputName, expectedFrameRate: draft.p1.expectedFrameRate },
    midiPortProfiles: [...current.midiPortProfiles.filter(port => port.id !== 'lighting-output'), ...(legacyOutput ? [legacyOutput] : [])] };
}
