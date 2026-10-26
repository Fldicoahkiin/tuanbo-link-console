import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectStartupObs, initializeStartupDevices } from './startup-obs-connection';
import { createDefaultIntegrationProfile as defaultProfile } from './view-models/local-integration-profile';
import { linkDesktopViewModel } from './view-models/link-desktop-view-model';
import { useIntegrationStore } from './stores/integration-store';
import { readNativeDevices } from './view-models/midi-device-inventory';

vi.mock('./view-models/midi-device-inventory', () => ({ readNativeDevices: vi.fn() }));

const mockDesktop = vi.mocked(linkDesktopViewModel, { deep: true });
function createDefaultIntegrationProfile() {
  const profile = defaultProfile(); profile.obs.connectionMethod = 'manual'; return profile;
}

vi.mock('./view-models/link-desktop-view-model', () => ({
  linkDesktopViewModel: {
    getSecurityPreflight: vi.fn(), startExternalApplication: vi.fn(), connectObs: vi.fn(),
    connectLocalObs: vi.fn(), loadIntegrationProfile: vi.fn(),
    readObsInventory: vi.fn(), recordLog: vi.fn(), refreshExternalApplication: vi.fn()
  }
}));

const disconnected = { status: 'disconnected' as const, obsVersion: null, webSocketVersion: null, error: null };
const stopped = { id: 'obs' as const, status: 'notRunning' as const, pid: null, processName: null, executablePath: null, startTime: null, windowTitle: null, fileVersion: null, owned: false, error: null };
const running = { ...stopped, status: 'running' as const, pid: 1234, owned: true };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readNativeDevices).mockResolvedValue({ protocol: 4, audio: [], midiOutputs: [] });
  mockDesktop.getSecurityPreflight.mockResolvedValue({ credentialDecryptable: true, logRedactionReady: true, error: null });
  mockDesktop.startExternalApplication.mockResolvedValue(running);
  mockDesktop.connectObs.mockResolvedValue({ status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3', error: null });
  mockDesktop.readObsInventory.mockResolvedValue({ videoSettings: { baseWidth: 1080, baseHeight: 1920 }, scenes: [], inputs: [], inputKinds: {}, sceneItems: {}, filters: {}, transitions: [], inputAudioStates: {}, sourceSizes: {} });
  mockDesktop.recordLog.mockResolvedValue({ id: 'test', sessionId: 'test', timestamp: '2026-09-23T00:00:00.000Z', monotonicMs: 0, level: 'warning', category: 'device', message: 'test' });
  mockDesktop.refreshExternalApplication.mockResolvedValue({ ...stopped, id: 'p1' });
  useIntegrationStore.getState().setObs(disconnected);
  useIntegrationStore.getState().setError(null);
});

describe('OBS 启动连接', () => {
  it('不打开设置页面也在启动时读取 Windows 原生 MIDI 名单', () => {
    const profile = createDefaultIntegrationProfile();
    profile.internalPlayer = { audioEngine: 'native', audioOutputDeviceId: 'default', mtcOutputPortProfileId: 'internal-mtc-output' };
    initializeStartupDevices(profile, false, disconnected, () => false);
    expect(vi.mocked(readNativeDevices)).toHaveBeenCalledTimes(1);
  });
  it('自动连接后场景清单失败仍保持真实连接，并显示和记录独立错误', async () => {
    mockDesktop.connectLocalObs.mockResolvedValue({ version: 1, address: 'ws://127.0.0.1:4455', password: '', snapshot: { ...disconnected, status: 'connected' } });
    mockDesktop.loadIntegrationProfile.mockResolvedValue(defaultProfile());
    mockDesktop.readObsInventory.mockRejectedValue(new Error('显示器采集无法对应到有效显示器尺寸'));
    await connectStartupObs(defaultProfile(), true, disconnected, [], () => false);
    expect(useIntegrationStore.getState().obs.status).toBe('connected');
    expect(useIntegrationStore.getState().error).toContain('读取场景列表失败');
    expect(mockDesktop.recordLog.mock.calls.some(([entry]) => entry.level === 'warning' && entry.message.includes('显示器采集'))).toBe(true);
  });
  it('后续清单请求失败不会复活已经断开的 OBS', async () => {
    mockDesktop.readObsInventory.mockImplementation(() => {
      useIntegrationStore.getState().setObs({ ...disconnected, error: '连接已断开' });
      return Promise.reject(new Error('请求超时'));
    });
    await connectStartupObs(createDefaultIntegrationProfile(), true, disconnected, [stopped], () => false);
    expect(useIntegrationStore.getState().obs).toEqual({ ...disconnected, error: '连接已断开' });
  });
  it('默认启动自动读取本机配置，不使用旧密码发起手动连接', async () => {
    const profile = defaultProfile();
    profile.obs.webSocketUrl = 'ws://old-host:4455';
    const saved = { ...profile, obs: { ...profile.obs, webSocketUrl: 'ws://127.0.0.1:4567' } };
    mockDesktop.connectLocalObs.mockResolvedValue({ version: 1, address: saved.obs.webSocketUrl, password: 'fixture', snapshot: { status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3', error: null } });
    mockDesktop.loadIntegrationProfile.mockResolvedValue(saved);
    await connectStartupObs(profile, true, disconnected, [stopped], () => false);
    expect(mockDesktop.connectLocalObs.mock.calls).toHaveLength(1);
    expect(mockDesktop.connectObs.mock.calls).toHaveLength(0);
    expect(useIntegrationStore.getState().profile?.obs.webSocketUrl).toBe(saved.obs.webSocketUrl);
  });
  it('有保存的配置时启动并连接 OBS', async () => {
    await connectStartupObs(createDefaultIntegrationProfile(), true, disconnected, [stopped], () => false);
    expect(mockDesktop.startExternalApplication.mock.calls).toEqual([['obs']]);
    expect(mockDesktop.connectObs.mock.calls).toHaveLength(1);
    expect(useIntegrationStore.getState().obs.status).toBe('connected');
  });

  it('OBS 离线时只显示未连接，不使整个工作区初始化失败', async () => {
    mockDesktop.startExternalApplication.mockRejectedValue(new Error('ECONNREFUSED'));
    await connectStartupObs(createDefaultIntegrationProfile(), true, disconnected, [stopped], () => false);
    expect(useIntegrationStore.getState().obs.status).toBe('disconnected');
    expect(useIntegrationStore.getState().obs.error).toMatch(/^启动时没能连上 OBS：连不上目标设备/);
    expect(useIntegrationStore.getState().error).toBeNull();
  });

  it('关闭自动连接时不访问设备', async () => {
    const profile = createDefaultIntegrationProfile();
    profile.obs.autoConnectOnLaunch = false;
    await connectStartupObs(profile, true, disconnected, [stopped], () => false);
    expect(mockDesktop.getSecurityPreflight.mock.calls).toHaveLength(0);
    expect(mockDesktop.startExternalApplication.mock.calls).toHaveLength(0);
  });

  it('P1 进程检测未返回时仍启动 OBS 连接', async () => {
    const pending = new Promise<Awaited<ReturnType<typeof linkDesktopViewModel.refreshExternalApplication>>>(() => undefined);
    mockDesktop.refreshExternalApplication.mockReturnValue(pending);
    initializeStartupDevices(createDefaultIntegrationProfile(), true, disconnected, () => false);
    await vi.waitFor(() => expect(mockDesktop.startExternalApplication.mock.calls).toEqual([['obs']]));
    expect(useIntegrationStore.getState().obs.status).toBe('connected');
  });
});
