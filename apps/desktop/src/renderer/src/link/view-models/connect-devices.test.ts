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
  connectLocalObs: vi.fn<LinkDesktopApi['connectLocalObs']>(),
  loadIntegrationProfile: vi.fn<LinkDesktopApi['loadIntegrationProfile']>(),
  readObsInventory: vi.fn<LinkDesktopApi['readObsInventory']>(),
  getObsLiveFrame: vi.fn<LinkDesktopApi['getObsLiveFrame']>(),
  closeObsLivePreview: vi.fn<LinkDesktopApi['closeObsLivePreview']>(),
  getMa2NetworkStatus: vi.fn<LinkDesktopApi['getMa2NetworkStatus']>(),
  connectMa2Network: vi.fn<LinkDesktopApi['connectMa2Network']>(),
  recordLog: vi.fn<LinkDesktopApi['recordLog']>(),
  getNativePlaybackDevices: vi.fn<LinkDesktopApi['getNativePlaybackDevices']>(),
  checkNativeMidiOutput: vi.fn<LinkDesktopApi['checkNativeMidiOutput']>(),
  checkNetwork: vi.fn(() => Promise.resolve())
}));
vi.mock('./link-desktop-view-model', () => ({ linkDesktopViewModel: api }));
vi.mock('../stores/ma2-mode-store', () => ({ readMa2Method: () => 'network' }));
vi.mock('../stores/ma2-connection-store', () => ({ checkNetworkMa2: api.checkNetwork, connectDiscoveredMa2: vi.fn(), connectLocalMa2: vi.fn() }));

function snapshot(id: LinkProcessSnapshot['id']): LinkProcessSnapshot {
  return { id, status: 'running', pid: 1, processName: id, executablePath: null, startTime: null, windowTitle: null, fileVersion: null, owned: false, error: null };
}
function maProgram(path: string) {
  return { executablePath: path, workingDirectory: 'D:\\MA', arguments: [], startupTimeoutMs: 30000, shutdownTimeoutMs: 10000, connectOnDemand: true };
}

it('一键连接先打开并连接 onPC 再启动 MA 3D，避免抢占通信端口；MIDI 失败不阻断程序启动', async () => {
  const config = options();
  config.draft.ma2 = maProgram('D:\\MA\\gma2onpc.exe');
  config.draft.ma3d = maProgram('D:\\MA\\MA3D.exe');
  config.readMidiPorts = vi.fn().mockRejectedValue(new Error('MIDI 服务停止中'));
  const order: string[] = [];
  api.startExternalApplication.mockImplementation(id => { order.push(id); return Promise.resolve(snapshot(id)); });
  api.connectMa2Network.mockImplementation(async () => {
    order.push('network');
    return { ...(await api.getMa2NetworkStatus()), state: 'connected' };
  });
  await connectDevices(config);
  expect(order.indexOf('ma2')).toBeLessThan(order.indexOf('network'));
  expect(order.indexOf('network')).toBeLessThan(order.indexOf('ma3d'));
  expect(useConnectionCheckStore.getState().checks['ma2-app']?.state).toBe('ready');
  expect(useConnectionCheckStore.getState().checks.ma3d?.state).toBe('ready');
  expect(useConnectionCheckStore.getState().checks.midi?.state).toBe('error');
});

it('保留用户选定路径和关闭选项，不被识别出的其他版本覆盖', async () => {
  const config = options();
  config.draft.ma2 = { ...maProgram('D:\\MA\\chosen.exe'), connectOnDemand: false };
  api.detectLocalIntegrations.mockResolvedValue({ detectedAt: new Date().toISOString(), applications: {
    obs: { id: 'obs', executablePath: null, workingDirectory: null, processName: null, windowTitle: null, version: null, running: false },
    p1: { id: 'p1', executablePath: null, workingDirectory: null, processName: null, windowTitle: null, version: null, running: false },
    ma2: { id: 'ma2', executablePath: 'D:\\Other\\onpc.exe', workingDirectory: 'D:\\Other', processName: 'onpc.exe', windowTitle: 'MA2', version: '3.9', running: true },
    ma3d: { id: 'ma3d', executablePath: 'D:\\MA\\MA3D.exe', workingDirectory: 'D:\\MA', processName: 'MA3D.exe', windowTitle: 'MA 3D', version: '3.7', running: true }
  } });
  await connectDevices(config);
  expect(api.startExternalApplication).not.toHaveBeenCalledWith('ma2');
  expect(api.startExternalApplication).toHaveBeenCalledWith('ma3d');
  expect(useIntegrationStore.getState().profile?.ma2?.executablePath).toBe('D:\\MA\\chosen.exe');
  expect(useIntegrationStore.getState().profile?.ma3d?.executablePath).toBe('D:\\MA\\MA3D.exe');
});

it('onPC 启动失败会明确阻止后续控台连接，OBS 和 MA 3D 仍单独检查', async () => {
  const config = options();
  config.draft.ma2 = maProgram('D:\\MA\\missing.exe');
  config.draft.ma3d = maProgram('D:\\MA\\MA3D.exe');
  api.startExternalApplication.mockImplementation(id => {
    if (id === 'ma2') return Promise.reject(new Error('所选控台程序不存在'));
    return Promise.resolve(snapshot(id));
  });
  await connectDevices(config);
  expect(api.connectMa2Network).not.toHaveBeenCalled();
  expect(api.connectObs).toHaveBeenCalled();
  expect(useConnectionCheckStore.getState().checks['ma2-app']?.detail).toContain('所选控台程序不存在');
  expect(useConnectionCheckStore.getState().checks.ma3d?.state).toBe('ready');
});
beforeEach(() => {
  vi.resetAllMocks();
  api.checkNativeMidiOutput.mockResolvedValue();
  useIntegrationStore.getState().setNativeDevices(null, null);
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

it('OBS 清单失败单独报告，控制仍已连接且继续检查预览', async () => {
  api.readObsInventory.mockRejectedValue(new Error('显示器采集尺寸不可用'));
  await connectDevices(options());
  expect(useIntegrationStore.getState().obs.status).toBe('connected');
  expect(useConnectionCheckStore.getState().checks.obs?.state).toBe('ready');
  expect(useConnectionCheckStore.getState().checks['obs-inventory']?.state).toBe('error');
  expect(api.getObsLiveFrame).toHaveBeenCalled();
});

it('原生 MTC 端口不被浏览器一键连接提前占用，浏览器漏枚举不误报 USB 未连接', async () => {
  const config = options();
  config.draft.internalPlayer = { audioEngine: 'native', audioOutputDeviceId: 'default', mtcOutputPortProfileId: 'internal-mtc-output' };
  config.draft.midiPortProfiles.push({ id: 'internal-mtc-output', direction: 'output', portName: 'USB MIDI Interface' });
  const native = { protocol: 4 as const, audio: [{ id: 'audio', name: '测试输出', isDefault: true }], midiOutputs: [{ id: 1, name: 'USB MIDI Interface' }] };
  useIntegrationStore.getState().setNativeDevices(native, null);
  api.getNativePlaybackDevices.mockResolvedValue(native);
  await connectDevices(config);
  expect(useConnectionCheckStore.getState().checks['port:internal-mtc-output']?.state).toBe('ready');
  expect(useConnectionCheckStore.getState().checks['port:internal-mtc-output']?.detail).toContain('打开检查通过');
  expect(api.checkNativeMidiOutput).toHaveBeenCalledExactlyOnceWith({ version: 1, portName: 'USB MIDI Interface' });
  expect(config.openMidiPorts).not.toHaveBeenCalledWith(['internal-mtc-output'], 'output');
  expect(config.openMidiPorts).not.toHaveBeenCalledWith(['lighting-events-output'], 'output');
  expect(config.openMidiPorts).toHaveBeenCalledWith(['custom-input'], 'input');
});

it('USB 打开失败不重复检查、不换成 Babyface，保留用户选定接口并报告具体原因', async () => {
  const config = options();
  config.draft.internalPlayer = { audioEngine: 'native', audioOutputDeviceId: 'default', mtcOutputPortProfileId: 'internal-mtc-output' };
  config.draft.midiPortProfiles.push({ id: 'internal-mtc-output', direction: 'output', portName: 'USB MIDI Interface' });
  const native = { protocol: 4 as const, audio: [{ id: 'audio', name: '测试输出', isDefault: true }], midiOutputs: [{ id: 0, name: 'Babyface Midi Port 1' }, { id: 1, name: 'USB MIDI Interface' }] };
  useIntegrationStore.getState().setNativeDevices(native, null);
  api.getNativePlaybackDevices.mockResolvedValue(native);
  api.checkNativeMidiOutput.mockRejectedValue(new Error('MIDI 接口 USB MIDI Interface：Windows 错误 4'));
  await connectDevices(config);
  expect(api.checkNativeMidiOutput).toHaveBeenCalledExactlyOnceWith({ version: 1, portName: 'USB MIDI Interface' });
  expect(useConnectionCheckStore.getState().checks['port:internal-mtc-output']?.state).toBe('error');
  expect(useConnectionCheckStore.getState().checks['port:internal-mtc-output']?.detail).toContain('Windows 错误 4');
  expect(useIntegrationStore.getState().profile?.midiPortProfiles.find(port => port.id === 'internal-mtc-output')?.portName).toBe('USB MIDI Interface');
});
function options(): DeviceConnectionOptions {
  const draft = createDefaultIntegrationProfile();
  draft.obs.connectionMethod = 'manual';
  draft.midiPortProfiles.push({ id: 'custom-input', direction: 'input', portName: '遥控键盘' });
  return { draft, password: '', project: parseLinkProject({ ...createEmptyLinkProject('连接检查'), playbackSource: 'internal' }),
    readMidiPorts: vi.fn(() => Promise.resolve([{ id: 'input', name: '遥控键盘', manufacturer: '', direction: 'input' as const, state: 'connected' as const, connection: 'closed' as const }])),
    openMidiPorts: vi.fn(() => Promise.resolve([])), listenToP1: vi.fn(() => Promise.resolve()), onProfile: vi.fn(), onDetection: vi.fn(), onIssues: vi.fn() };
}

it('原生引擎的灯光 Cue 使用独立 USB 端口时，也按 Windows 原生路径检测，不被 Web MIDI 漏枚举阻断', async () => {
  const config = options();
  config.draft.internalPlayer = { audioEngine: 'native', audioOutputDeviceId: 'default', mtcOutputPortProfileId: 'internal-mtc-output' };
  config.draft.midiPortProfiles.push({ id: 'internal-mtc-output', direction: 'output', portName: '时间码口' }, { id: 'lighting-events-output', direction: 'output', portName: '声光 MIDI' });
  const native = { protocol: 4 as const, audio: [{ id: 'audio', name: '测试输出', isDefault: true }], midiOutputs: [{ id: 0, name: '时间码口' }, { id: 1, name: '声光 MIDI' }] };
  useIntegrationStore.getState().setNativeDevices(native, null);
  api.getNativePlaybackDevices.mockResolvedValue(native);
  config.readMidiPorts = vi.fn(() => Promise.reject(new Error('Web MIDI 不可用')));
  await connectDevices(config);
  expect(api.checkNativeMidiOutput).toHaveBeenCalledWith({ version: 1, portName: '声光 MIDI' });
  expect(useConnectionCheckStore.getState().checks['port:lighting-events-output']?.state).toBe('ready');
  expect(useConnectionCheckStore.getState().checks['port:internal-mtc-output']?.state).toBe('ready');
  expect(useConnectionCheckStore.getState().checks['port:custom-input']?.state).toBe('error');
  expect(config.openMidiPorts).not.toHaveBeenCalled();
});

it('自动连接不使用误填的地址和旧密码，读取 OBS 当前配置后更新显示', async () => {
  const config = options(); config.draft.obs.connectionMethod = 'automatic';
  config.draft.obs.webSocketUrl = 'ws://wrong-target';
  config.password = 'outdated';
  config.onObsPassword = vi.fn();
  const saved = createDefaultIntegrationProfile(); saved.obs.webSocketUrl = 'ws://127.0.0.1:4567';
  api.connectLocalObs.mockResolvedValue({ version: 1, address: saved.obs.webSocketUrl, password: 'from-obs', snapshot: { status: 'connected', obsVersion: '32.1.1', webSocketVersion: '5', error: null } });
  api.loadIntegrationProfile.mockResolvedValue(saved);
  await connectDevices(config);
  expect(api.connectLocalObs).toHaveBeenCalledOnce();
  expect(api.connectObs).not.toHaveBeenCalled();
  expect(config.onObsPassword).toHaveBeenCalledWith('from-obs');
  expect(useIntegrationStore.getState().profile?.obs.webSocketUrl).toBe('ws://127.0.0.1:4567');
});

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

it('配置失败保留诊断原文并脱敏密码，不只记录通用提示', async () => {
  const config = options(); config.password = 'private-obs-password';
  api.saveIntegrationProfile.mockRejectedValueOnce(new Error('DataCloneError private-obs-password field invalid'));
  await connectDevices(config);
  const entry = api.recordLog.mock.calls.map(([value]) => value).find(value => value.details?.step === 'profile');
  expect(entry?.details?.technicalError).toBe('DataCloneError [REDACTED] field invalid');
  expect(JSON.stringify(entry)).not.toContain(config.password);
  expect(useConnectionCheckStore.getState().checks.profile?.detail).toContain('DataCloneError');
});
