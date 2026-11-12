import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../registry/midi-access', () => ({ requestMidiAccess: vi.fn(), refreshMidiAccess: vi.fn() }));
import { requestMidiAccess, type MidiAccess } from '../../registry/midi-access';
/** The window's MIDI comes from main; these tests hand the code under test a fixed port list. */
function stubMidi(request: () => Promise<unknown>): void { vi.mocked(requestMidiAccess).mockImplementation(() => request() as Promise<MidiAccess>); }
vi.mock('../../registry/license-output', () => ({ requireOutputLicense: vi.fn().mockResolvedValue(undefined) }));
import { createEmptyLinkProject, parseLinkProject, type LinkAction } from '@tb/schema';
import { runDesktopPreflight } from './link-preflight-view-model';
import { createDefaultIntegrationProfile } from './local-integration-profile';
import { LinkMidiAdapter } from '../../registry/link-midi-adapter';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { useRuntimeStore } from '../stores/runtime-store';

const mocks = vi.hoisted(() => ({ recordLog: vi.fn<(entry: { category: string; message: string; details?: Readonly<Record<string, unknown>> }) => Promise<void>>(() => Promise.resolve()) }));
vi.mock('./link-desktop-view-model', () => ({ linkDesktopViewModel: {
  recordLog: mocks.recordLog,
  inspectProjectAssets: vi.fn(() => Promise.resolve({ referenceAudio: { song: { audioAvailable: true, waveformAvailable: true } }, media: {} })),
  getSecurityPreflight: vi.fn(() => Promise.resolve({ credentialDecryptable: true, logRedactionReady: true, error: null })),
  getExternalSnapshots: vi.fn(() => Promise.resolve([])),
  getAppInfo: vi.fn(() => Promise.resolve({ version: '0.4.25', availableDiskBytes: 10_000_000_000 })),
  saveIntegrationProfile: vi.fn(() => Promise.resolve())
} }));

const midiRequest = vi.fn(() => Promise.reject(new Error('测试：系统 MIDI 枚举不可用')));
let midi: LinkMidiAdapter | undefined;
beforeEach(() => {
  midiRequest.mockClear();
  stubMidi(midiRequest);
  useRuntimeStore.getState().reset();
  const profile = createDefaultIntegrationProfile();
  profile.internalPlayer = { mtcOutputPortProfileId: 'lighting-output', audioOutputDeviceId: 'default' };
  useIntegrationStore.getState().setProfile(profile);
  useIntegrationStore.getState().setMidiPorts([]);
});
afterEach(() => { midi?.dispose(); midi = undefined; vi.unstubAllGlobals(); });

function setup(actions: LinkAction[] = [], selected = 'song') {
  const project = parseLinkProject({ ...createEmptyLinkProject('预检 MIDI 边界'), playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [
    { id: 'song', title: '歌曲', referenceAudio: { assetId: 'audio', relativePath: 'song.wav', sha256: 'a'.repeat(64), durationMs: 10_000 }, cues: [{ id: 'cue', name: '灯光', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, actions }] },
    { id: 'other', title: '其他节目', cues: [] }
  ] });
  useDocumentStore.getState().setProject(project, 'C:\\test\\show.tblink');
  useRuntimeStore.getState().setState({ currentItemId: selected });
  midi = new LinkMidiAdapter(() => null, () => undefined);
  return midi;
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

it('预检只记一条汇总（各项结果在详情里），另加阻断项和提示项，不再逐项记录通过的检查', async () => {
  const recordLog = mocks.recordLog; recordLog.mockClear();
  const report = await runDesktopPreflight(setup(), 'live', 'internal', false, { internalMtcOutputEnabled: false });
  const preflight = recordLog.mock.calls.map(([entry]) => entry).filter(entry => entry.category === 'preflight');
  const notPassed = report.checks.filter(check => check.status !== 'passed');
  expect(preflight).toHaveLength(1 + notPassed.length);
  expect(preflight[0]!.message).toMatch(new RegExp(`^开播前检查(通过|未通过)（.*共? ?${report.checks.length} 项`));
  expect(preflight[0]!.details?.['checks']).toHaveLength(report.checks.length);
  expect(preflight.some(entry => report.checks.some(check => check.status === 'passed' && entry.message === `${check.label}：${check.detail}`))).toBe(false);
});
