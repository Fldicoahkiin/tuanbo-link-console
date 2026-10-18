import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject } from '@tb/schema';
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
  getMa2CurrentShow: vi.fn<LinkDesktopApi['getMa2CurrentShow']>(),
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
function nothingDetected(): Awaited<ReturnType<LinkDesktopApi['detectLocalIntegrations']>> {
  const none = (id: 'obs' | 'p1' | 'ma2' | 'ma3d') => ({ id, executablePath: null, workingDirectory: null, processName: null, windowTitle: null, version: null, running: false });
  return { detectedAt: new Date().toISOString(), applications: { obs: none('obs'), p1: none('p1'), ma2: none('ma2'), ma3d: none('ma3d') } };
}
function maProgram(path: string) {
  return { executablePath: path, workingDirectory: 'D:\\MA', arguments: [], startupTimeoutMs: 30000, shutdownTimeoutMs: 10000, connectOnDemand: true };
}

it('一键连接按顺序执行：OBS 在灯光之前，先打开并连接 onPC 再启动 MA 3D，避免抢占通信端口', async () => {
  const config = options();
  config.draft.ma2 = maProgram('D:\\MA\\gma2onpc.exe');
  config.draft.ma3d = maProgram('D:\\MA\\MA3D.exe');
  const order: string[] = [];
  api.startExternalApplication.mockImplementation(id => { order.push(id); return Promise.resolve(snapshot(id)); });
  api.connectMa2Network.mockImplementation(async () => {
    order.push('network');
    return { ...(await api.getMa2NetworkStatus()), state: 'connected' };
  });
  await connectDevices(config);
  expect(order.indexOf('obs')).toBeLessThan(order.indexOf('ma2'));
  expect(order.indexOf('ma2')).toBeLessThan(order.indexOf('network'));
  expect(order.indexOf('network')).toBeLessThan(order.indexOf('ma3d'));
  expect(useConnectionCheckStore.getState().checks['ma2-app']?.state).toBe('ready');
  expect(useConnectionCheckStore.getState().checks.ma3d?.state).toBe('ready');
});

it('系统 MIDI 未通过即停止：后续步骤全部标为未执行，不连接 OBS、不启动任何程序', async () => {
  const config = options();
  config.draft.ma2 = maProgram('D:\\MA\\gma2onpc.exe');
  config.readMidiPorts = vi.fn().mockRejectedValue(new Error('Windows MIDI 服务正在停止'));
  await connectDevices(config);
  const state = useConnectionCheckStore.getState();
  expect(state.checks.midi?.state).toBe('error');
  for (const id of ['profile', 'obs', 'obs-inventory', 'preview', 'audio', 'ma2-app', 'ma2', 'bridge', 'ma3d']) {
    expect(state.checks[id]?.state).toBe('blocked');
    expect(state.checks[id]?.detail).toBe('未执行：系统 MIDI未通过，已停止后续步骤');
  }
  expect(api.saveIntegrationProfile).not.toHaveBeenCalled(); expect(api.connectObs).not.toHaveBeenCalled();
  expect(api.startExternalApplication).not.toHaveBeenCalled(); expect(api.connectMa2Network).not.toHaveBeenCalled();
  expect(state.pending).toEqual([]); expect(state.completed).toBe(state.total); expect(state.running).toBe(false);
});

it('单步超过截止时间记为失败并停止，说明操作可能仍在后台进行', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  api.connectObs.mockImplementation(() => new Promise(() => undefined));
  const running = connectDevices(options());
  await vi.advanceTimersByTimeAsync(60_000); await running;
  const state = useConnectionCheckStore.getState();
  expect(state.checks.obs?.state).toBe('error');
  expect(state.checks.obs?.detail).toContain('OBS 控制超过 60 秒未完成；该操作可能仍在后台进行');
  expect(state.checks.preview?.detail).toBe('未执行：OBS 控制未通过，已停止后续步骤');
  expect(api.checkNetwork).not.toHaveBeenCalled(); expect(state.running).toBe(false);
  vi.useRealTimers();
});

it('开始一键连接时，上一次的结果先重置为等待中，不冒充本次结果', () => {
  useConnectionCheckStore.getState().finish('ma3d', 'ready', '上次已运行');
  expect(useConnectionCheckStore.getState().begin(['ma3d'])).toBe(true);
  expect(useConnectionCheckStore.getState().checks.ma3d).toMatchObject({ state: 'waiting', detail: '等待前序步骤完成' });
  useConnectionCheckStore.getState().end();
});

it('保留用户选定路径和关闭选项；识别到的未登记程序只报告，不自动登记或启动', async () => {
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
  expect(api.startExternalApplication).not.toHaveBeenCalledWith('ma3d');
  expect(useIntegrationStore.getState().profile?.ma2?.executablePath).toBe('D:\\MA\\chosen.exe');
  expect(useIntegrationStore.getState().profile?.ma3d).toBeUndefined();
  expect(useConnectionCheckStore.getState().checks.ma3d).toMatchObject({ state: 'skipped',
    detail: '已识别 D:\\MA\\MA3D.exe，未启用；在 MA2 设置中选择并启用后才会由一键连接启动' });
});

it('onPC 启动失败即停止：不登录控台、不启动 MA 3D，之前的 OBS 已完成', async () => {
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
  expect(useConnectionCheckStore.getState().checks.ma3d).toMatchObject({ state: 'blocked', detail: '未执行：MA2 onPC未通过，已停止后续步骤' });
  expect(api.startExternalApplication).not.toHaveBeenCalledWith('ma3d');
});
beforeEach(() => {
  vi.resetAllMocks();
  api.checkNativeMidiOutput.mockResolvedValue();
  useIntegrationStore.getState().setNativeDevices(null, null);
  useConnectionCheckStore.setState({ running: false, checks: {}, pending: [], completed: 0, total: 0 });
  useIntegrationStore.getState().setObs({ status: 'disconnected', obsVersion: null, webSocketVersion: null, error: null });
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: () => Promise.resolve([{ kind: 'audiooutput', deviceId: 'default' }]) } });
  api.detectLocalIntegrations.mockResolvedValue(nothingDetected());
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

it('OBS 场景清单未通过即停止：控制已连接，但不再检查预览和后续设备', async () => {
  api.readObsInventory.mockRejectedValue(new Error('显示器采集尺寸不可用'));
  await connectDevices(options());
  expect(useIntegrationStore.getState().obs.status).toBe('connected');
  expect(useConnectionCheckStore.getState().checks.obs?.state).toBe('ready');
  expect(useConnectionCheckStore.getState().checks['obs-inventory']?.state).toBe('error');
  expect(useConnectionCheckStore.getState().checks.preview?.detail).toBe('未执行：OBS 场景清单未通过，已停止后续步骤');
  expect(api.getObsLiveFrame).not.toHaveBeenCalled(); expect(api.checkNetwork).not.toHaveBeenCalled();
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
  // Web MIDI lists only the remote keyboard; the USB outputs are checked through the native path.
  await connectDevices(config);
  expect(api.checkNativeMidiOutput).toHaveBeenCalledWith({ version: 1, portName: '声光 MIDI' });
  expect(useConnectionCheckStore.getState().checks['port:lighting-events-output']?.state).toBe('ready');
  expect(useConnectionCheckStore.getState().checks['port:internal-mtc-output']?.state).toBe('ready');
  expect(useConnectionCheckStore.getState().checks['port:custom-input']?.state).toBe('ready');
  expect(config.openMidiPorts).toHaveBeenCalledExactlyOnceWith(['custom-input'], 'input');
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

it('全部步骤通过时依次完成 OBS、真实预览、音频、MIDI 接口与控台，并完成所有进度项', async () => {
  const config = options();
  await connectDevices(config);
  expect(api.connectObs).toHaveBeenCalledOnce(); expect(api.getObsLiveFrame).toHaveBeenCalledOnce(); expect(api.checkNetwork).toHaveBeenCalledOnce();
  expect(api.closeObsLivePreview).toHaveBeenCalledOnce();
  const state = useConnectionCheckStore.getState();
  for (const id of ['midi', 'profile', 'obs', 'preview', 'audio', 'port:custom-input', 'ma2', 'bridge']) expect(state.checks[id]?.state).toBe('ready');
  expect(state.pending).toEqual([]); expect(state.completed).toBe(state.total); expect(state.running).toBe(false);
  expect(config.openMidiPorts).toHaveBeenCalledWith(['custom-input'], 'input');
  expect(api.loopMidi).toHaveBeenCalledWith('start');
});
it('OBS 连接失败即停止：预览不误报就绪，控台与 MIDI 接口均未执行', async () => {
  api.connectObs.mockRejectedValueOnce(new Error('OBS 无法连接'));
  const config = options(); await connectDevices(config);
  expect(api.getObsLiveFrame).not.toHaveBeenCalled(); expect(api.checkNetwork).not.toHaveBeenCalled();
  expect(config.openMidiPorts).not.toHaveBeenCalled();
  expect(useConnectionCheckStore.getState().checks.preview).toMatchObject({ state: 'blocked', detail: '未执行：OBS 控制未通过，已停止后续步骤' });
  expect(useConnectionCheckStore.getState().checks['port:custom-input']?.state).toBe('blocked');
});
it('控台当前 show 与工程灯光依据不一致时工程通信不通过，不再启动 MA 3D；一致时通过', async () => {
  const track = lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false,
    channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 5000, timeLock: 'time', muted: false,
      events: [{ id: 'cue', at: 1000, kind: 'ma2', sequence: 7, cue: '6.000', executor: '', label: '副歌', action: 'goto' }] }] });
  const config = options(); config.draft.ma3d = maProgram('D:\\MA\\MA3D.exe');
  config.project = parseLinkProject({ ...createEmptyLinkProject('灯光工程'), schemaVersion: 2, playbackSource: 'internal', rundown: [{ id: 'song', title: '第一首',
    lighting: { ...createLightingDocument(), outputMode: 'network', tracks: [track], ma2Library: { show: '2hao', readAt: '2026-10-13T00:00:00.000Z', sequences: [] } } }] });
  api.getMa2CurrentShow.mockResolvedValueOnce('tblink_ui100_20261007');
  await connectDevices(config);
  expect(useConnectionCheckStore.getState().checks.bridge?.state).toBe('error');
  expect(useConnectionCheckStore.getState().checks.bridge?.detail).toContain('控台当前加载的 show 是“tblink_ui100_20261007”，灯光 Cue 依据“2hao”编写');
  expect(api.startExternalApplication).not.toHaveBeenCalledWith('ma3d');
  api.getMa2CurrentShow.mockResolvedValueOnce('2hao');
  await connectDevices(config);
  expect(useConnectionCheckStore.getState().checks.bridge?.state).toBe('ready');
  expect(api.startExternalApplication).toHaveBeenCalledWith('ma3d');
});
it('程序识别未通过即停止，不再保存配置或连接设备', async () => {
  api.detectLocalIntegrations.mockRejectedValueOnce(new Error('系统命令组件暂不可用'));
  await connectDevices(options());
  expect(useConnectionCheckStore.getState().checks.discovery?.state).toBe('error');
  expect(useConnectionCheckStore.getState().checks.obs?.detail).toBe('未执行：程序识别未通过，已停止后续步骤');
  expect(api.saveIntegrationProfile).not.toHaveBeenCalled(); expect(api.connectObs).not.toHaveBeenCalled();
});
it('首次检查挂起时连续点击不重复启动连接', async () => {
  let release = (): void => { throw new Error('尚未开始检测'); };
  api.detectLocalIntegrations.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(nothingDetected()); }));
  const config = options(); const first = connectDevices(config);
  await connectDevices(config); expect(api.detectLocalIntegrations).toHaveBeenCalledOnce();
  release(); await first; expect(api.connectObs).toHaveBeenCalledOnce();
});
it('P1 模式启动播放器并建立时间码监听，不发送播放命令', async () => {
  const config = options(); config.project = createEmptyLinkProject('P1 跟随');
  config.readMidiPorts = vi.fn(() => Promise.resolve((['input', 'output'] as const).flatMap(direction => [
    { id: `p1-${direction}`, name: 'HirenderP1', manufacturer: '', direction, state: 'connected' as const, connection: 'closed' as const },
    ...direction === 'input' ? [{ id: 'keyboard', name: '遥控键盘', manufacturer: '', direction, state: 'connected' as const, connection: 'closed' as const }] : []])));
  await connectDevices(config);
  expect(Object.values(useConnectionCheckStore.getState().checks).filter(check => check.state === 'error')).toEqual([]);
  expect(api.startExternalApplication).toHaveBeenCalledWith('p1'); expect(config.listenToP1).toHaveBeenCalledOnce();
  expect(useConnectionCheckStore.getState().checks.p1?.detail).toContain('等待真实播放信号');
});
it('配置保存失败即停止：不连接旧目标，后续步骤均未执行', async () => {
  api.saveIntegrationProfile.mockRejectedValueOnce(new Error('配置无法保存'));
  await connectDevices(options());
  expect(api.connectObs).not.toHaveBeenCalled(); expect(api.checkNetwork).not.toHaveBeenCalled();
  expect(useConnectionCheckStore.getState().checks.profile?.state).toBe('error');
  expect(useConnectionCheckStore.getState().checks.audio).toMatchObject({ state: 'blocked', detail: '未执行：连接配置未通过，已停止后续步骤' });
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
