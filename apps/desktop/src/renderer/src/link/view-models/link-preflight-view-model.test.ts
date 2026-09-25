import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkAction } from '@tb/schema';
import { runDesktopPreflight } from './link-preflight-view-model';
import { createDefaultIntegrationProfile } from './local-integration-profile';
import { LinkRuntimeCoordinator } from '../runtime/link-runtime-coordinator';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { useRuntimeStore } from '../stores/runtime-store';

vi.mock('./link-desktop-view-model', () => ({ linkDesktopViewModel: {
  recordLog: vi.fn(() => Promise.resolve()),
  inspectProjectAssets: vi.fn(() => Promise.resolve({ referenceAudio: { song: { audioAvailable: true, waveformAvailable: true } }, media: {} })),
  getSecurityPreflight: vi.fn(() => Promise.resolve({ credentialDecryptable: true, logRedactionReady: true, error: null })),
  getExternalSnapshots: vi.fn(() => Promise.resolve([])),
  getAppInfo: vi.fn(() => Promise.resolve({ version: '0.4.25', availableDiskBytes: 10_000_000_000 })),
  saveIntegrationProfile: vi.fn(() => Promise.resolve())
} }));

const midiRequest = vi.fn(() => Promise.reject(new Error('测试：系统 MIDI 枚举不可用')));
let coordinator: LinkRuntimeCoordinator | undefined;
beforeEach(() => {
  midiRequest.mockClear();
  vi.stubGlobal('navigator', { requestMIDIAccess: midiRequest });
  useRuntimeStore.getState().reset();
  const profile = createDefaultIntegrationProfile();
  profile.internalPlayer = { mtcOutputPortProfileId: 'lighting-output', audioOutputDeviceId: 'default' };
  useIntegrationStore.getState().setProfile(profile);
  useIntegrationStore.getState().setMidiPorts([]);
});
afterEach(() => { coordinator?.dispose(); coordinator = undefined; vi.unstubAllGlobals(); });

function setup(actions: LinkAction[] = [], selected = 'song') {
  const project = parseLinkProject({ ...createEmptyLinkProject('预检 MIDI 边界'), playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [
    { id: 'song', title: '歌曲', referenceAudio: { assetId: 'audio', relativePath: 'song.wav', sha256: 'a'.repeat(64), durationMs: 10_000 }, cues: [{ id: 'cue', name: '灯光', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, actions }] },
    { id: 'other', title: '其他节目', cues: [] }
  ] });
  useDocumentStore.getState().setProject(project, 'C:\\test\\show.tblink');
  coordinator = new LinkRuntimeCoordinator(project, 'C:\\test\\show.tblink');
  coordinator.selectItem(selected, false);
  return coordinator;
}
const lightingAction: LinkAction = { id: 'light-action', label: '灯光', kind: 'midi.noteOn', portProfileId: 'lighting-output', channel: 1, note: 60, velocity: 100 };

it('内部播放关闭时间码后，无 MIDI Cue 的节目不触发系统枚举', async () => {
  const report = await runDesktopPreflight(setup(), 'live', 'internal', false, { internalMtcOutputEnabled: false });
  expect(midiRequest).not.toHaveBeenCalled();
  expect(report.checks.some(check => check.id.startsWith('midi.'))).toBe(false);
});
it('内部播放仍检查当前节目的 MIDI Cue，失败不能跳过', async () => {
  await expect(runDesktopPreflight(setup([lightingAction]), 'live', 'internal', false, { internalMtcOutputEnabled: false })).rejects.toThrow('系统 MIDI 枚举不可用');
  expect(midiRequest).toHaveBeenCalledOnce();
});
it('启用内部时间码时仍检查保存的输出端口', async () => {
  await expect(runDesktopPreflight(setup(), 'live', 'internal')).rejects.toThrow('系统 MIDI 枚举不可用');
  expect(midiRequest).toHaveBeenCalledOnce();
});
it('其他节目的 MIDI Cue 不阻断当前无 MIDI 动作的节目', async () => {
  await runDesktopPreflight(setup([lightingAction], 'other'), 'live', 'internal', false, { internalMtcOutputEnabled: false });
  expect(midiRequest).not.toHaveBeenCalled();
});
it('P1 跟随仍必须检测 MIDI，不能套用内部播放的关闭选项', async () => {
  await expect(runDesktopPreflight(setup(), 'live', 'awaiting-external-start', false, { internalMtcOutputEnabled: false })).rejects.toThrow('系统 MIDI 枚举不可用');
  expect(midiRequest).toHaveBeenCalledOnce();
});
