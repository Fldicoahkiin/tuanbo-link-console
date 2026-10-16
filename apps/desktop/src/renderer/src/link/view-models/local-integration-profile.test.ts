import { describe, expect, it } from 'vitest';
import { createDefaultIntegrationProfile, mergeIntegrationDraft, mergeProgramSettings } from './local-integration-profile';

describe('integration settings drafts', () => {
  it('keeps unsaved address and P1 port edits while accepting another saved MIDI change', () => {
    const base = createDefaultIntegrationProfile();
    base.midiPortProfiles.push({ id: 'lighting-events-output', direction: 'output', portName: 'Old lighting' });
    const draft = structuredClone(base);
    draft.obs.webSocketUrl = 'ws://127.0.0.1:4456';
    draft.midiPortProfiles[0]!.portName = 'New P1';
    const saved = structuredClone(base);
    saved.midiPortProfiles = saved.midiPortProfiles.filter((port) => port.id !== 'lighting-events-output');
    saved.p1.expectedFrameRate = '25';
    const merged = mergeIntegrationDraft(base, draft, saved);
    expect(merged.obs.webSocketUrl).toBe(draft.obs.webSocketUrl);
    expect(merged.p1.expectedFrameRate).toBe('25');
    expect(merged.midiPortProfiles[0]?.portName).toBe('New P1');
    expect(merged.midiPortProfiles.some((port) => port.id === 'lighting-events-output')).toBe(false);
    expect(mergeIntegrationDraft(saved, merged, merged)).toEqual(merged);
  });

  it('accepts saved values for untouched fields and retains explicit local deletions', () => {
    const base = createDefaultIntegrationProfile();
    const draft = structuredClone(base);
    draft.midiPortProfiles = draft.midiPortProfiles.filter((port) => port.id !== 'lighting-output');
    const saved = structuredClone(base);
    saved.obs.webSocketUrl = 'ws://localhost:5566';
    saved.internalPlayer = { mtcOutputPortProfileId: null, audioOutputDeviceId: 'speakers' };
    saved.midiPortProfiles.push({ id: 'lighting-record-input', direction: 'input', portName: 'Feedback' });
    const merged = mergeIntegrationDraft(base, draft, saved);
    expect(merged.obs).toEqual(saved.obs);
    expect(merged.internalPlayer).toEqual(saved.internalPlayer);
    expect(merged.midiPortProfiles.map((port) => port.id)).toEqual(['p1-mtc', 'p1-output', 'lighting-record-input']);
  });
});

it('maintenance saves only its fields, preserving other connection and MIDI settings', () => {
  const saved = createDefaultIntegrationProfile();
  saved.obs.webSocketUrl = 'ws://192.0.2.1:4455';
  saved.obs.autoConnectOnLaunch = false;
  const draft = structuredClone(saved);
  draft.obs.webSocketUrl = 'ws://192.0.2.2:4455';
  draft.obs.credentialId = 'unsubmitted-target';
  draft.obs.autoConnectOnLaunch = true;
  draft.obs.executablePath = 'C:\\OBS\\obs64.exe';
  draft.p1.expectedFrameRate = '25';
  draft.midiPortProfiles[0]!.portName = 'unsubmitted-input';
  draft.midiPortProfiles[2]!.portName = 'legacy-output';
  const result = mergeProgramSettings(saved, draft);
  expect(result.obs.webSocketUrl).toBe(saved.obs.webSocketUrl);
  expect(result.obs.credentialId).toBe(saved.obs.credentialId);
  expect(result.obs.autoConnectOnLaunch).toBe(false);
  expect(result.obs.executablePath).toBe(draft.obs.executablePath);
  expect(result.p1.expectedFrameRate).toBe('25');
  expect(result.midiPortProfiles.find(port => port.id === 'p1-mtc')?.portName).toBe('');
  expect(result.midiPortProfiles.find(port => port.id === 'lighting-output')?.portName).toBe('legacy-output');
});
