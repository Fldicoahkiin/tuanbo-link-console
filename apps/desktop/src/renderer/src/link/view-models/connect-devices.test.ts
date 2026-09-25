import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import type { LinkDesktopApi, LinkProcessSnapshot } from '@tb/core/link';
import { connectDevices, type DeviceConnectionOptions } from './connect-devices';
import { createDefaultIntegrationProfile } from './local-integration-profile';
import { useConnectionCheckStore } from '../stores/connection-check-store';
import { useIntegrationStore } from '../stores/integration-store';

const api = vi.hoisted(() => ({
  detectLocalIntegrations: vi.fn<LinkDesktopApi['detectLocalIntegrations']>(),
  saveIntegrationProfile: vi.fn<LinkDesktopApi['saveIntegrationProfile']>(),
  loopMidi: vi.fn<LinkDesktopApi['loopMidi']>(),
  startExternalApplication: vi.fn<LinkDesktopApi['startExternalApplication']>(),
  connectObs: vi.fn<LinkDesktopApi['connectObs']>(),
  readObsInventory: vi.fn<LinkDesktopApi['readObsInventory']>(),
  getObsLiveFrame: vi.fn<LinkDesktopApi['getObsLiveFrame']>(),
  closeObsLivePreview: vi.fn<LinkDesktopApi['closeObsLivePreview']>(),
  getMa2NetworkStatus: vi.fn<LinkDesktopApi['getMa2NetworkStatus']>(),
  connectMa2Network: vi.fn<LinkDesktopApi['connectMa2Network']>(),
  recordLog: vi.fn<LinkDesktopApi['recordLog']>(),
  checkNetwork: vi.fn(() => Promise.resolve())
}));
vi.mock('./link-desktop-view-model', () => ({ linkDesktopViewModel: api }));
vi.mock('../stores/ma2-mode-store', () => ({ readMa2Method: () => 'network' }));
vi.mock('../stores/ma2-connection-store', () => ({ checkNetworkMa2: api.checkNetwork, connectDiscoveredMa2: vi.fn(), connectLocalMa2: vi.fn() }));

function snapshot(id: LinkProcessSnapshot['id']): LinkProcessSnapshot {
  return { id, status: 'running', pid: 1, processName: id, executablePath: null, startTime: null, windowTitle: null, fileVersion: null, owned: false, error: null };
}
beforeEach(() => {
  vi.resetAllMocks();
  useConnectionCheckStore.setState({ running: false, checks: {}, pending: [], completed: 0, total: 0 });
  useIntegrationStore.getState().setObs({ status: 'disconnected', obsVersion: null, webSocketVersion: null, error: null });
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: () => Promise.resolve([{ kind: 'audiooutput', deviceId: 'default' }]) } });
  api.detectLocalIntegrations.mockRejectedValue(new Error('识别不可用，仍可使用已保存路径'));
  api.saveIntegrationProfile.mockResolvedValue(); api.recordLog.mockImplementation(entry => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: new Date().toISOString(), monotonicMs: 0 }));
  api.loopMidi.mockImplementation(action => Promise.resolve({ state: action === 'start' ? 'running' : 'installed', executablePath: 'C:\\loopMIDI.exe', pid: action === 'start' ? 2 : null, startTime: null }));
  api.startExternalApplication.mockImplementation(id => Promise.resolve(snapshot(id)));
  api.connectObs.mockResolvedValue({ status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5', error: null });
  api.readObsInventory.mockResolvedValue({ scenes: [], inputs: [], inputKinds: {}, inputAudioStates: {}, sceneItems: {}, filters: {}, transitions: [], sourceSizes: {} });
  api.getObsLiveFrame.mockResolvedValue({ width: 1, height: 1, rgba: new Uint8Array(4), sequence: 1, timestampNs: '1' });
  api.closeObsLivePreview.mockResolvedValue();
  const network = { settings: { host: '192.168.1.2', port: 30000, monitorPort: 30001, username: 'administrator', autoConnect: false }, state: 'connected' as const, passwordSaved: true, version: '3.3.4.3', error: null };
  api.getMa2NetworkStatus.mockResolvedValue({ ...network, state: 'disconnected' });
  api.connectMa2Network.mockResolvedValue(network); api.checkNetwork.mockResolvedValue();
});
afterEach(() => vi.unstubAllGlobals());
function options(): DeviceConnectionOptions {
  const draft = createDefaultIntegrationProfile();
  draft.midiPortProfiles.push({ id: 'custom-input', direction: 'input', portName: '遥控键盘' });
  return { draft, password: '', project: parseLinkProject({ ...createEmptyLinkProject('连接检查'), playbackSource: 'internal' }),
    readMidiPorts: vi.fn(() => Promise.resolve([{ id: 'input', name: '遥控键盘', manufacturer: '', direction: 'input' as const, state: 'connected' as const, connection: 'closed' as const }])),
    openMidiPorts: vi.fn(() => Promise.resolve([])), listenToP1: vi.fn(() => Promise.resolve()), onProfile: vi.fn(), onDetection: vi.fn(), onIssues: vi.fn() };
}

it('系统 MIDI 失败后继续连接 OBS、真实预览、控台与音频，并完成所有进度项', async () => {
  const config = options(); config.readMidiPorts = vi.fn(() => Promise.reject(new Error('系统 MIDI 未响应')));
  await connectDevices(config);
  expect(api.connectObs).toHaveBeenCalledOnce(); expect(api.getObsLiveFrame).toHaveBeenCalledOnce(); expect(api.checkNetwork).toHaveBeenCalledOnce();
  expect(api.closeObsLivePreview).toHaveBeenCalledOnce();
  const state = useConnectionCheckStore.getState();
  expect(state.checks.midi?.state).toBe('error');
  for (const id of ['obs', 'preview', 'ma2', 'bridge', 'audio']) expect(state.checks[id]?.state).toBe('ready');
  expect(state.pending).toEqual([]); expect(state.completed).toBe(state.total); expect(state.running).toBe(false);
  expect(config.openMidiPorts).not.toHaveBeenCalled();
  expect(api.loopMidi).toHaveBeenCalledWith('start');
});
it('OBS 连接失败不误报预览就绪，也不阻断控台与已配置 MIDI 输入', async () => {
  api.connectObs.mockRejectedValueOnce(new Error('OBS 无法连接'));
  const config = options(); await connectDevices(config);
  expect(api.getObsLiveFrame).not.toHaveBeenCalled(); expect(api.checkNetwork).toHaveBeenCalledOnce();
  expect(config.openMidiPorts).toHaveBeenCalledWith(['custom-input'], 'input');
  expect(useConnectionCheckStore.getState().checks.preview?.state).toBe('skipped');
  expect(useConnectionCheckStore.getState().checks['port:custom-input']?.state).toBe('ready');
});
it('首次检查挂起时连续点击不重复启动连接', async () => {
  let release = (): void => { throw new Error('尚未开始检测'); };
  api.detectLocalIntegrations.mockImplementationOnce(() => new Promise((_resolve, reject) => { release = () => reject(new Error('检测结束')); }));
  const config = options(); const first = connectDevices(config);
  await connectDevices(config); expect(api.detectLocalIntegrations).toHaveBeenCalledOnce();
  release(); await first; expect(api.connectObs).toHaveBeenCalledOnce();
});
it('P1 模式启动播放器并建立时间码监听，不发送播放命令', async () => {
  const config = options(); config.project = createEmptyLinkProject('P1 跟随');
  await connectDevices(config);
  expect(api.startExternalApplication).toHaveBeenCalledWith('p1'); expect(config.listenToP1).toHaveBeenCalledOnce();
  expect(useConnectionCheckStore.getState().checks.p1?.detail).toContain('等待真实播放信号');
});
it('配置保存失败时不连接旧目标，但独立的控台和音频检查仍完成', async () => {
  api.saveIntegrationProfile.mockRejectedValueOnce(new Error('配置无法保存'));
  await connectDevices(options());
  expect(api.connectObs).not.toHaveBeenCalled(); expect(api.checkNetwork).toHaveBeenCalledOnce();
  expect(useConnectionCheckStore.getState().checks.profile?.state).toBe('error');
  expect(useConnectionCheckStore.getState().checks.audio?.state).toBe('ready');
});
